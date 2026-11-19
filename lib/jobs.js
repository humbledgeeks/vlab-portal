'use strict';
// Job queue for the PowerShell engine (ps/engine.ps1). Each job = one engine action with named,
// validated parameters, run with `-File` and an argument list (no shell, no string building).
// One job per lab at a time.
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const { db } = require('./db');

const ACTIONS = {
  provision:          { engine: 'provision', label: 'Provision' },
  start:              { engine: 'start', label: 'Start' },
  stop:               { engine: 'stop', label: 'Shut down' },
  kill:               { engine: 'kill', label: 'Power off' },
  destroy:            { engine: 'destroy', label: 'Destroy' },
  'lab-snapshot':     { engine: 'lab-snapshot', label: 'Take snapshot' },
  'lab-restore':      { engine: 'lab-restore', label: 'Restore snapshot' },
  'lab-snapdelete':   { engine: 'lab-snapdelete', label: 'Delete snapshot' },
  'template-enable':  { engine: 'template-enable', label: 'Enable template' },
  'template-disable': { engine: 'template-disable', label: 'Disable template' },
  'template-master':  { engine: 'template-master', label: 'Snapshot template' },
};
const PARAMS = { lab: '-Lab', template: '-Template', snapshot: '-Snapshot', label: '-Label', maxSnapshots: '-MaxSnapshots' };

const MAX_LOG = 200000;
let running = 0;
let onFinished = () => {};

function busy(target) {
  return !!db.prepare(`SELECT 1 FROM jobs WHERE target = ? AND status IN ('queued','running')`).get(target);
}

// params: { lab, template?, snapshot?, label? } -> engine parameters
function enqueue(userId, action, target, params) {
  if (!ACTIONS[action]) throw new Error(`unknown action ${action}`);
  if (busy(target)) { const e = new Error(`${target} already has a job in progress.`); e.status = 409; throw e; }
  const info = db.prepare('INSERT INTO jobs (user_id, action, target, args) VALUES (?,?,?,?)')
    .run(userId, action, target, JSON.stringify(params));
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
  const params = JSON.parse(job.args || '{}');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(config.root, 'ps', 'engine.ps1'), '-Action', def.engine];
  for (const [k, flag] of Object.entries(PARAMS)) if (params[k]) args.push(flag, String(params[k]));

  db.prepare(`UPDATE jobs SET status='running', started_at=datetime('now') WHERE id = ?`).run(job.id);
  const append = db.prepare(`UPDATE jobs SET log = substr(log || ?, -${MAX_LOG}) WHERE id = ?`);
  const write = (d) => append.run(String(d).replace(/\r/g, ''), job.id);
  write(`[${new Date().toISOString()}] ${def.label}: ${params.lab || ''}\n`);

  const ps = spawn('powershell.exe', args, { cwd: config.root, windowsHide: true });
  ps.stdout.on('data', write);
  ps.stderr.on('data', write);
  ps.on('error', (e) => write(`\n[failed to start: ${e.message}]\n`));
  ps.on('close', (code) => {
    const ok = code === 0;
    write(`\n[${new Date().toISOString()}] finished, exit code ${code}\n`);
    db.prepare(`UPDATE jobs SET status = ?, finished_at = datetime('now') WHERE id = ?`).run(ok ? 'succeeded' : 'failed', job.id);
    running--;
    try { onFinished(job, ok); } catch (e) { console.error(e); }
    pump();
  });
}

module.exports = { ACTIONS, enqueue, busy, setOnFinished: (fn) => { onFinished = fn; } };
