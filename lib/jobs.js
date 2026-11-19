'use strict';
// Job queue that runs Sean's vlab scripts safely: fixed script per action, `-File` with
// an argument array (no shell, no string building), validated lab names, one job per lab.
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { db } = require('./db');

// action -> script in C:\vlab and extra fixed switches. Every script takes the lab name first.
const ACTIONS = {
  provision: { script: 'new-vlabclone.ps1', label: 'Provision' },          // args: template, newName
  start:     { script: 'start-vlab.ps1', label: 'Start' },
  stop:      { script: 'stop-vlab.ps1', label: 'Shut down' },
  kill:      { script: 'stop-vlab.ps1', extra: ['-kill'], label: 'Power off' },
  destroy:   { script: 'remove-vlab.ps1', label: 'Destroy' },
  // template (catalog) maintenance, admin only
  enable:    { script: 'import-vlabtemplate.ps1', label: 'Enable template' },
  disable:   { script: 'remove-vlab.ps1', label: 'Disable template' },
  snapshot:  { script: 'new-vlabsnapshot.ps1', label: 'Snapshot template' },
  mount:     { script: 'enable-vlabauthoring.ps1', label: 'Mount for authoring' },
  unmount:   { script: 'disable-vlabauthoring.ps1', label: 'Unmount authoring' },
};

const MAX_LOG = 200000;
let running = 0;
let onFinished = () => {};

function busy(target) {
  return !!db.prepare(`SELECT 1 FROM jobs WHERE target = ? AND status IN ('queued','running')`).get(target);
}

// args: positional strings passed to the script after the action's fixed switches are appended.
function enqueue(userId, action, target, args) {
  if (!ACTIONS[action]) throw new Error(`unknown action ${action}`);
  if (busy(target)) { const e = new Error(`${target} already has a job in progress.`); e.status = 409; throw e; }
  const info = db.prepare('INSERT INTO jobs (user_id, action, target, args) VALUES (?,?,?,?)')
    .run(userId, action, target, JSON.stringify(args));
  setImmediate(pump);
  return Number(info.lastInsertRowid);
}

function pump() {
  while (running < config.maxConcurrentJobs) {
    const job = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
    if (!job) return;
    run(job);
  }
}

function run(job) {
  running++;
  const def = ACTIONS[job.action];
  const args = JSON.parse(job.args);
  db.prepare(`UPDATE jobs SET status='running', started_at=datetime('now') WHERE id = ?`).run(job.id);
  const append = db.prepare(`UPDATE jobs SET log = substr(log || ?, -${MAX_LOG}) WHERE id = ?`);
  append.run(`[${new Date().toISOString()}] ${def.label}: ${args.join(' ')}\n`, job.id);

  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(config.vlabRoot, def.script), ...args, ...(def.extra || [])],
  { cwd: config.vlabRoot, windowsHide: true });   // scripts call .\get-vlabsession.ps1, so cwd matters

  const write = (d) => append.run(String(d).replace(/\r/g, ''), job.id);
  ps.stdout.on('data', write);
  ps.stderr.on('data', write);
  ps.on('error', (e) => write(`\n[failed to start: ${e.message}]\n`));
  ps.on('close', (code) => {
    const ok = code === 0;
    write(`\n[${new Date().toISOString()}] finished, exit code ${code}\n`);
    db.prepare(`UPDATE jobs SET status = ?, finished_at = datetime('now') WHERE id = ?`).run(ok ? 'succeeded' : 'failed', job.id);
    running--;
    try { onFinished(job); } catch (e) { console.error(e); }
    pump();
  });
}

module.exports = { ACTIONS, enqueue, busy, setOnFinished: (fn) => { onFinished = fn; } };
