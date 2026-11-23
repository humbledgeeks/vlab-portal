'use strict';
// Catalog files (descriptions, diagrams, per-template RDP overrides) plus the inventory poller.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { db } = require('./db');

const LAB_NAME = /^lab_[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const isLabName = (s) => typeof s === 'string' && LAB_NAME.test(s);

// *.conf / descriptions.tbl are key=value files (the same format vlab 1.x uses, so they can be copied over).
function readKV(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const descriptionsFile = () => path.join(config.catalogDir, 'descriptions.tbl');
const descriptions = () => readKV(descriptionsFile());

// Update one key in descriptions.tbl, keeping every other line as-is.
function setDescription(template, text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  const file = descriptionsFile();
  let lines = [];
  fs.mkdirSync(config.catalogDir, { recursive: true });
  try { lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/); } catch { /* new file */ }
  let found = false;
  lines = lines.map((l) => {
    const i = l.indexOf('=');
    if (i > 0 && l.slice(0, i).trim() === template) { found = true; return `${template}=${clean}`; }
    return l;
  });
  if (!found) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${template}=${clean}`);
  }
  fs.writeFileSync(file, lines.join('\r\n').replace(/(\r\n)*$/, '\r\n'));
}

// The <name>.conf for a lab: the portal's catalog folder first, then vlab 1.x's cmdb folder,
// so a .conf dropped into either one is used. null when there is none.
function labConf(name) {
  if (!isLabName(name)) return null;
  for (const dir of [config.catalogDir, config.legacyCmdbDir]) {
    if (!dir) continue;
    const file = path.join(dir, `${name}.conf`);
    if (fs.existsSync(file)) return readKV(file);
  }
  return null;
}

// RDP login for a lab's jumphost: config.json "rdp" defaults, overridden by the first .conf found
// for the given names, in order (a lab copy passes its own name, then its template's).
// Like vlab 1.x, a key that is present wins even when blank: "rdpdomain=" means a local account,
// not "use the default domain".
function rdpCredentials(...names) {
  const o = names.map(labConf).find(Boolean) || {};
  const pick = (key, dflt) => (Object.hasOwn(o, key) ? o[key] : dflt);
  return {
    domain: pick('rdpdomain', config.rdp.domain || ''),
    username: pick('rdpuser', config.rdp.user || 'administrator'),
    password: pick('rdppassword', config.rdp.password || ''),
  };
}

// A template made by "Split clone" starts with its source template's description, diagram and
// RDP login (.conf); anything already there is kept.
function adoptTemplateFiles(newTemplate, fromTemplate, fromLab) {
  if (!isLabName(newTemplate) || !isLabName(fromTemplate)) return;
  const dir = config.catalogDir;
  const desc = descriptions();
  if (!desc[newTemplate]) setDescription(newTemplate, `${desc[fromTemplate] || fromTemplate} (split from ${fromLab})`);
  // the login the source lab copy used (its own .conf, else its template's), in either folder
  const conf = [fromLab, fromTemplate].map((n) => [config.catalogDir, config.legacyCmdbDir].filter(Boolean)
    .map((d) => path.join(d, `${n}.conf`)).find((f) => fs.existsSync(f))).find(Boolean);
  if (conf && !labConf(newTemplate)) fs.copyFileSync(conf, path.join(dir, `${newTemplate}.conf`));
  const pic = diagramPath(fromTemplate);
  if (pic && !diagramPath(newTemplate)) fs.copyFileSync(pic, path.join(dir, `${newTemplate}${path.extname(pic)}`));
}

function diagramPath(template) {
  if (!isLabName(template)) return null;
  for (const ext of ['jpg', 'png']) {
    const p = path.join(config.catalogDir, `${template}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Replace a template's diagram with an uploaded PNG or JPEG (type taken from the file's own bytes).
function setDiagram(template, buf) {
  const ext = buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' ? 'png'
    : (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpg' : null);
  if (!ext) throw Object.assign(new Error('The diagram must be a PNG or JPEG image.'), { status: 400 });
  fs.mkdirSync(config.catalogDir, { recursive: true });
  const file = path.join(config.catalogDir, `${template}.${ext}`);
  fs.writeFileSync(file + '.tmp', buf);
  fs.renameSync(file + '.tmp', file);
  // drop the other format so diagramPath() serves the new one
  fs.rmSync(path.join(config.catalogDir, `${template}.${ext === 'png' ? 'jpg' : 'png'}`), { force: true });
}

// ---- inventory -------------------------------------------------------------
let state = { templates: [], instances: [], capacity: null, updatedAt: null, error: null, refreshing: false };
let pending = null;

function runInventory() {
  if (pending) return pending;
  state.refreshing = true;
  pending = new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(config.root, 'ps', 'inventory.ps1')],
      { cwd: config.root, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => ps.kill(), 180000);
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => { err += `could not start PowerShell: ${e.message}`; });
    ps.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out.slice(out.indexOf('{')));
        const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
        state = {
          templates: arr(data.templates).sort((a, b) => a.name.localeCompare(b.name)),
          instances: arr(data.instances).sort((a, b) => a.name.localeCompare(b.name)),
          capacity: data.capacity || null, updatedAt: new Date().toISOString(), error: null, refreshing: false,
        };
        syncLabs();
      } catch {
        state.error = (err || out || 'inventory failed').trim().slice(0, 2000);
        state.refreshing = false;
        console.error('[inventory] failed:', state.error);
      }
      pending = null;
      resolve(state);
    });
  });
  return pending;
}

// Keep the labs table in step with ONTAP: add new clones (unowned), drop deleted ones.
function syncLabs() {
  const names = new Set(state.instances.map((i) => i.name));
  // a "Split clone" target is a clone only until its split finishes; it becomes a template, not a copy
  const splitting = new Set(db.prepare(`SELECT args FROM jobs WHERE action = 'lab-split' AND status IN ('queued','running')`).all()
    .map((j) => JSON.parse(j.args).newName));
  const insert = db.prepare('INSERT OR IGNORE INTO labs (name, template) VALUES (?, ?)');
  for (const i of state.instances) if (!splitting.has(i.name)) insert.run(i.name, i.parent || '');
  const active = db.prepare(`SELECT 1 FROM jobs WHERE target = ? AND status IN ('queued','running')`);
  const lastRename = db.prepare(`SELECT args FROM jobs WHERE action = 'lab-rename' AND target = ? ORDER BY id DESC LIMIT 1`);
  for (const row of db.prepare('SELECT name FROM labs').all()) {
    // a copy being provisioned isn't in ONTAP yet; keep its row (and owner) until the job ends
    if (names.has(row.name) || active.get(row.name)) continue;
    // renamed: carry the row (owner, created date) over to the new name, and remember the old one
    const r = lastRename.get(row.name);
    const to = r && JSON.parse(r.args).newName;
    if (to && names.has(to)) {
      db.prepare('DELETE FROM labs WHERE name = ?').run(to);   // the unowned row added above
      db.prepare(`UPDATE labs SET name = ?, former_names = trim(former_names || ',' || name, ',') WHERE name = ?`).run(to, row.name);
      continue;
    }
    db.prepare('DELETE FROM labs WHERE name = ?').run(row.name);
  }
}

function startPolling() {
  runInventory();
  setInterval(runInventory, config.inventoryIntervalSec * 1000).unref();
}

// Next free copy name: <template>_<n>, n above every existing suffix and labs.firstId.
function nextInstanceName(template) {
  let max = parseInt(config.labs.firstId, 10) || 1000;
  const used = new Set([...state.instances.map((i) => i.name), ...state.templates.map((t) => t.name)]);
  for (const r of db.prepare('SELECT name FROM labs').all()) used.add(r.name);
  for (const n of used) {
    const m = /_(\d+)$/.exec(n);
    if (m && n.startsWith(template + '_')) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (used.has(`${template}_${n}`)) n++;
  return `${template}_${n}`;
}

module.exports = {
  isLabName, descriptions, setDescription, rdpCredentials, adoptTemplateFiles, diagramPath, setDiagram,
  inventory: () => state, runInventory, startPolling, nextInstanceName,
};
