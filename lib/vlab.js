'use strict';
// Read-only access to Sean's vlab files (settings.cfg, cmdb/*) plus the inventory poller.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { db } = require('./db');

const LAB_NAME = /^lab_[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const isLabName = (s) => typeof s === 'string' && LAB_NAME.test(s);

// settings.cfg / *.conf / descriptions.tbl are PowerShell ConvertFrom-StringData files: key=value per line.
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

const settings = () => readKV(path.join(config.vlabRoot, 'settings.cfg'));
const descriptionsFile = () => path.join(config.vlabRoot, 'cmdb', 'descriptions.tbl');
const descriptions = () => readKV(descriptionsFile());

// Update one key in descriptions.tbl, keeping every other line as-is (the old portal reads it too).
function setDescription(template, text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  const file = descriptionsFile();
  let lines = [];
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

// RDP login for a lab's jumphost: settings.cfg defaults, overridden by cmdb/<template>.conf
function rdpCredentials(template) {
  const s = settings();
  const o = isLabName(template) ? readKV(path.join(config.vlabRoot, 'cmdb', `${template}.conf`)) : {};
  return {
    domain: o.rdpdomain || s.rdpdomain || '',
    username: o.rdpuser || s.rdpuser || 'administrator',
    password: o.rdppassword || s.rdppassword || '',
  };
}

function diagramPath(template) {
  if (!isLabName(template)) return null;
  for (const ext of ['jpg', 'png']) {
    const p = path.join(config.vlabRoot, 'cmdb', `${template}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- inventory -------------------------------------------------------------
let state = { templates: [], instances: [], capacity: null, updatedAt: null, error: null, refreshing: false };
let pending = null;

function runInventory() {
  if (pending) return pending;
  state.refreshing = true;
  pending = new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'ps', 'inventory.ps1'), '-VlabRoot', config.vlabRoot],
      { cwd: config.vlabRoot, windowsHide: true });
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
  const insert = db.prepare('INSERT OR IGNORE INTO labs (name, template) VALUES (?, ?)');
  for (const i of state.instances) insert.run(i.name, i.parent || '');
  const active = db.prepare(`SELECT 1 FROM jobs WHERE target = ? AND status IN ('queued','running')`);
  for (const row of db.prepare('SELECT name FROM labs').all()) {
    // a copy being provisioned isn't in ONTAP yet; keep its row (and owner) until the job ends
    if (!names.has(row.name) && !active.get(row.name)) db.prepare('DELETE FROM labs WHERE name = ?').run(row.name);
  }
}

function startPolling() {
  runInventory();
  setInterval(runInventory, config.inventoryIntervalSec * 1000).unref();
}

// Next free copy name: <template>_<n>, n above every existing suffix and settings newID.
function nextInstanceName(template) {
  let max = parseInt(settings().newID, 10) || 1000;
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
  isLabName, settings, descriptions, setDescription, rdpCredentials, diagramPath,
  inventory: () => state, runInventory, startPolling, nextInstanceName,
};
