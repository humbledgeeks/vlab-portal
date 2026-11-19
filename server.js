'use strict';
// vLab Portal: multi-user web portal for FlexClone-based lab copies on vSphere + ONTAP.
process.chdir(__dirname);
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./lib/config');
const { db, audit } = require('./lib/db');
const auth = require('./lib/auth');
const vlab = require('./lib/vlab');
const jobs = require('./lib/jobs');
const guac = require('./lib/guac');

// ---- first start: create an admin with a one-time password ------------------------------
if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) {
  const pw = tempPassword();
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role, max_labs, must_change_password)
    VALUES ('admin', 'Administrator', ?, 'admin', 99, 1)`).run(auth.hashPassword(pw));
  const f = path.join(__dirname, 'data', 'initial-admin-password.txt');
  fs.writeFileSync(f, `username: admin\npassword: ${pw}\n(you will be asked to change it; delete this file afterwards)\n`);
  console.log(`[setup] created user "admin"; one-time password written to ${f}`);
}

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('');
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(auth.loadUser);

// Cross-site request guard: every state-changing API call must come from our own JS.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'vlab-portal') {
    return res.status(403).json({ error: 'Bad request origin.' });
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (req) => req.user && req.user.role === 'admin';
const userGrants = (userId) => db.prepare('SELECT template FROM grants WHERE user_id = ?').all(userId).map((r) => r.template);
const labRow = (name) => db.prepare('SELECT * FROM labs WHERE name = ?').get(name);
const ownedCount = (userId) => db.prepare('SELECT COUNT(*) n FROM labs WHERE owner_id = ?').get(userId).n;

function canUseLab(req, name) {
  const row = labRow(name);
  return row && (isAdmin(req) || row.owner_id === req.user.id) ? row : null;
}

// ---- session -------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = `${String(username).toLowerCase()}|${req.ip}`;
  if (auth.loginBlocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || u.disabled || !auth.verifyPassword(String(password || ''), u.password_hash)) {
    auth.noteFailure(key);
    audit(req, 'login.failed', String(username || '').slice(0, 64));
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  auth.clearFailures(key);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(u.id);
  auth.createSession(res, u.id, config.secureCookies);
  req.user = u;
  audit(req, 'login', u.username);
  res.json({ ok: true, mustChangePassword: !!u.must_change_password });
});

app.post('/api/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

app.get('/api/me', auth.requireUser, (req, res) => {
  res.json({
    user: { id: req.user.id, username: req.user.username, displayName: req.user.display_name, role: req.user.role,
      maxLabs: req.user.max_labs, mustChangePassword: !!req.user.must_change_password },
    site: { name: config.site.name || 'vLab Portal', guacamole: guac.enabled(), maxSnapshotsPerLab: config.labs.maxSnapshotsPerLab },
  });
});

app.post('/api/me/password', auth.requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  const problem = auth.passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (next === current) return res.status(400).json({ error: 'Choose a password different from the current one.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(next), u.id);
  audit(req, 'password.changed', u.username);
  res.json({ ok: true });
});

// ---- inventory views -------------------------------------------------------------------
app.get('/api/inventory', auth.requireUser, (req, res) => {
  const inv = vlab.inventory();
  const admin = isAdmin(req);
  const desc = vlab.descriptions();
  const granted = new Set(admin ? inv.templates.map((t) => t.name) : userGrants(req.user.id));
  const users = new Map(db.prepare('SELECT id, username, display_name FROM users').all().map((u) => [u.id, u]));
  const activeJobs = new Map(db.prepare(`SELECT target, action, id FROM jobs WHERE status IN ('queued','running')`).all().map((j) => [j.target, j]));

  const templates = inv.templates.filter((t) => granted.has(t.name)).map((t) => ({
    name: t.name, description: desc[t.name] || '', hasDiagram: !!vlab.diagramPath(t.name),
    ...(admin ? { status: t.vapp ? t.vapp.status : 'Disabled', sizeGB: t.sizeGB, job: activeJobs.get(t.name) || null,
      gatewayIp: t.vapp ? t.vapp.gatewayIp : null, vms: t.vapp ? (t.vapp.vms || []) : [] } : {}),
  }));

  const instByName = new Map(inv.instances.map((i) => [i.name, i]));
  const rows = admin ? db.prepare('SELECT * FROM labs ORDER BY name').all()
    : db.prepare('SELECT * FROM labs WHERE owner_id = ? ORDER BY name').all(req.user.id);
  const labs = rows.map((r) => {
    const i = instByName.get(r.name);
    const owner = r.owner_id ? users.get(r.owner_id) : null;
    return {
      name: r.name, template: r.template, description: desc[r.template] || '',
      status: i ? (i.vapp ? i.vapp.status : 'Disabled') : 'Provisioning',
      gatewayIp: i && i.vapp ? i.vapp.gatewayIp : null, vmCount: i && i.vapp ? i.vapp.vmCount : 0,
      sizeGB: i ? i.sizeGB : null, hasDiagram: !!vlab.diagramPath(r.template),
      owner: owner ? { id: owner.id, username: owner.username } : null,
      job: activeJobs.get(r.name) || null,
      snapshots: i ? snapshotsOf(i) : [],
    };
  });

  res.json({
    templates, labs,
    quota: { used: ownedCount(req.user.id), max: admin ? null : req.user.max_labs },
    capacity: inv.capacity, updatedAt: inv.updatedAt, refreshing: inv.refreshing,
    error: admin ? inv.error : (inv.error ? 'Lab status is temporarily unavailable.' : null),
  });
});

app.post('/api/inventory/refresh', auth.requireUser, auth.requireAdmin, (req, res) => {
  vlab.runInventory();
  res.json({ ok: true });
});

app.get('/api/diagram/:template', auth.requireUser, (req, res) => {
  const p = vlab.diagramPath(req.params.template);
  if (!p) return res.status(404).end();
  res.set('Cache-Control', 'private, no-cache');   // revalidate (ETag) so an uploaded diagram shows at once
  res.sendFile(p);
});

// ---- user actions on catalog and labs ---------------------------------------------------
app.post('/api/catalog/:template/provision', auth.requireUser, (req, res) => {
  const t = req.params.template;
  const inv = vlab.inventory();
  if (!vlab.isLabName(t) || !inv.templates.some((x) => x.name === t)) return res.status(404).json({ error: 'No such catalog lab.' });
  if (!isAdmin(req) && !userGrants(req.user.id).includes(t)) return res.status(403).json({ error: 'You do not have access to this lab.' });
  if (!isAdmin(req) && ownedCount(req.user.id) >= req.user.max_labs) {
    return res.status(409).json({ error: `You already have ${req.user.max_labs} lab(s), your limit. Destroy one first.` });
  }
  const name = vlab.nextInstanceName(t);
  db.prepare('INSERT INTO labs (name, template, owner_id) VALUES (?,?,?)').run(name, t, req.user.id);
  try {
    const id = jobs.enqueue(req.user.id, 'provision', name, { lab: name, template: t });
    audit(req, 'lab.provision', name, { template: t, job: id });
    res.json({ ok: true, name, jobId: id });
  } catch (e) {
    db.prepare('DELETE FROM labs WHERE name = ?').run(name);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/labs/:name/:action', auth.requireUser, (req, res, next) => {
  const { name, action } = req.params;
  if (!['start', 'stop', 'kill', 'destroy'].includes(action)) return next();   // e.g. /snapshots has its own route
  if (!vlab.isLabName(name) || !canUseLab(req, name)) return res.status(404).json({ error: 'No such lab.' });
  if (!vlab.inventory().instances.some((i) => i.name === name)) return res.status(409).json({ error: 'This lab is not ready yet.' });
  try {
    const id = jobs.enqueue(req.user.id, action, name, { lab: name });
    audit(req, `lab.${action}`, name, { job: id });
    res.json({ ok: true, jobId: id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/labs/:name/connect', auth.requireUser, (req, res) => {
  const { name } = req.params;
  const row = vlab.isLabName(name) && canUseLab(req, name);
  if (!row) return res.status(404).json({ error: 'No such lab.' });
  if (!guac.enabled()) return res.status(503).json({ error: 'Remote desktop is not configured yet.' });
  const inst = vlab.inventory().instances.find((i) => i.name === name);
  sendConnectUrl(req, res, inst, name, row.template);
});

// Guacamole link to a running lab (copy or template) through its gateway's WAN address.
function sendConnectUrl(req, res, inst, name, template) {
  if (!inst || !inst.vapp || inst.vapp.status !== 'Started') return res.status(409).json({ error: 'Start the lab first.' });
  if (!inst.vapp.gatewayIp) return res.status(409).json({ error: 'The lab gateway has no address yet. Try again in a minute.' });
  const url = guac.connectUrl({
    username: req.user.username, connectionName: name, hostname: inst.vapp.gatewayIp,
    rdp: vlab.rdpCredentials(template),
  });
  audit(req, 'lab.connect', name);
  res.json({ url });
}

// ---- lab snapshots (per lab copy, on its FlexClone volume) ------------------------------
// The clone's inherited base snapshot is the "original" (state when the copy was made);
// portal snapshots are named vlab_<UTC timestamp> and carry the user's label as the ONTAP comment.
function snapshotsOf(inst) {
  return (inst.snapshots || []).map((s) => ({
    name: s.name, created: s.created, label: s.name === inst.baseSnapshot ? 'Original (as deployed)' : (s.comment || ''),
    sizeMB: s.sizeMB, original: s.name === inst.baseSnapshot,
  })).sort((a, b) => (a.original ? -1 : b.original ? 1 : String(b.created).localeCompare(String(a.created))));
}

function labForSnapshots(req, res) {
  const { name } = req.params;
  if (!vlab.isLabName(name) || !canUseLab(req, name)) { res.status(404).json({ error: 'No such lab.' }); return null; }
  const inst = vlab.inventory().instances.find((i) => i.name === name);
  if (!inst) { res.status(409).json({ error: 'This lab is not ready yet.' }); return null; }
  return inst;
}

app.post('/api/labs/:name/snapshots', auth.requireUser, (req, res) => {
  const inst = labForSnapshots(req, res); if (!inst) return;
  const own = snapshotsOf(inst).filter((s) => !s.original).length;
  if (own >= config.labs.maxSnapshotsPerLab) {
    return res.status(409).json({ error: `This lab already has ${config.labs.maxSnapshotsPerLab} snapshots, the limit. Delete one first.` });
  }
  const label = String((req.body || {}).label || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const snapshot = 'vlab_' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  try {
    const id = jobs.enqueue(req.user.id, 'lab-snapshot', inst.name, { lab: inst.name, snapshot, label: label || 'Snapshot', maxSnapshots: config.labs.maxSnapshotsPerLab });
    audit(req, 'lab.snapshot', inst.name, { snapshot, label, job: id });
    res.json({ ok: true, jobId: id, snapshot });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/labs/:name/snapshots/:snap/restore', auth.requireUser, (req, res) => {
  const inst = labForSnapshots(req, res); if (!inst) return;
  const snap = snapshotsOf(inst).find((s) => s.name === req.params.snap);
  if (!snap) return res.status(404).json({ error: 'No such snapshot.' });
  try {
    const id = jobs.enqueue(req.user.id, 'lab-restore', inst.name, { lab: inst.name, template: inst.parent, snapshot: snap.name });
    audit(req, 'lab.restore', inst.name, { snapshot: snap.name, original: snap.original, job: id });
    res.json({ ok: true, jobId: id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/labs/:name/snapshots/:snap', auth.requireUser, (req, res) => {
  const inst = labForSnapshots(req, res); if (!inst) return;
  const snap = snapshotsOf(inst).find((s) => s.name === req.params.snap);
  if (!snap) return res.status(404).json({ error: 'No such snapshot.' });
  if (snap.original) return res.status(400).json({ error: 'The original snapshot cannot be deleted.' });
  try {
    const id = jobs.enqueue(req.user.id, 'lab-snapdelete', inst.name, { lab: inst.name, snapshot: snap.name });
    audit(req, 'lab.snapshot-delete', inst.name, { snapshot: snap.name, job: id });
    res.json({ ok: true, jobId: id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- jobs --------------------------------------------------------------------------------
app.get('/api/jobs', auth.requireUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const target = typeof req.query.target === 'string' ? req.query.target : null;
  const where = []; const args = [];
  if (!isAdmin(req)) { where.push('j.user_id = ?'); args.push(req.user.id); }
  if (target) { where.push('j.target = ?'); args.push(target); }
  const rows = db.prepare(`SELECT j.id, j.action, j.target, j.status, j.created_at, j.started_at, j.finished_at, u.username
    FROM jobs j LEFT JOIN users u ON u.id = j.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY j.id DESC LIMIT ${limit}`).all(...args);
  res.json(rows);
});

app.get('/api/jobs/:id', auth.requireUser, (req, res) => {
  const j = db.prepare(`SELECT j.*, u.username FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ?`).get(parseInt(req.params.id, 10) || 0);
  if (!j || (!isAdmin(req) && j.user_id !== req.user.id)) return res.status(404).json({ error: 'No such job.' });
  delete j.args;
  res.json(j);
});

// ---- admin: catalog maintenance -----------------------------------------------------------
app.get('/api/catalog/:template/connect', auth.requireUser, auth.requireAdmin, (req, res) => {
  const t = req.params.template;
  if (!guac.enabled()) return res.status(503).json({ error: 'Remote desktop is not configured yet.' });
  const inst = vlab.isLabName(t) && vlab.inventory().templates.find((x) => x.name === t);
  if (!inst) return res.status(404).json({ error: 'No such catalog lab.' });
  sendConnectUrl(req, res, inst, t, t);
});

// UI action -> engine action for catalog templates
const TEMPLATE_ACTIONS = { enable: 'template-enable', disable: 'template-disable', snapshot: 'template-master', start: 'start', stop: 'stop', kill: 'kill' };
app.post('/api/catalog/:template/:action', auth.requireUser, auth.requireAdmin, (req, res) => {
  const { template: t, action } = req.params;
  if (!Object.hasOwn(TEMPLATE_ACTIONS, action)) return res.status(404).json({ error: 'Unknown action.' });
  if (!vlab.isLabName(t) || !vlab.inventory().templates.some((x) => x.name === t)) return res.status(404).json({ error: 'No such catalog lab.' });
  try {
    const id = jobs.enqueue(req.user.id, TEMPLATE_ACTIONS[action], t, { lab: t });
    audit(req, `template.${action}`, t, { job: id });
    res.json({ ok: true, jobId: id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/catalog/:template/diagram', auth.requireUser, auth.requireAdmin,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: '10mb' }), (req, res) => {
    const t = req.params.template;
    if (!vlab.isLabName(t) || !vlab.inventory().templates.some((x) => x.name === t)) return res.status(404).json({ error: 'No such catalog lab.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a PNG or JPEG image.' });
    try { vlab.setDiagram(t, req.body); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    audit(req, 'template.diagram', t, { bytes: req.body.length });
    res.json({ ok: true });
  });

app.put('/api/catalog/:template/description', auth.requireUser, auth.requireAdmin, (req, res) => {
  const t = req.params.template;
  if (!vlab.isLabName(t)) return res.status(400).json({ error: 'Bad name.' });
  vlab.setDescription(t, String((req.body || {}).description || ''));
  audit(req, 'template.describe', t);
  res.json({ ok: true });
});

// ---- admin: users, grants, ownership, audit ------------------------------------------------
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

app.get('/api/users', auth.requireUser, auth.requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT id, username, display_name, role, max_labs, disabled, must_change_password,
    created_at, last_login_at, (SELECT COUNT(*) FROM labs l WHERE l.owner_id = users.id) AS labs FROM users ORDER BY username`).all();
  const grants = db.prepare('SELECT user_id, template FROM grants').all();
  for (const u of users) u.grants = grants.filter((g) => g.user_id === u.id).map((g) => g.template);
  res.json(users);
});

app.post('/api/users', auth.requireUser, auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!USERNAME.test(String(b.username || ''))) return res.status(400).json({ error: 'Username: 2-32 letters, digits, dot, dash or underscore.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) return res.status(409).json({ error: 'That username is taken.' });
  const pw = tempPassword();
  const role = b.role === 'admin' ? 'admin' : 'user';
  const maxLabs = Math.max(0, Math.min(parseInt(b.maxLabs, 10) || 1, 50));
  const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, max_labs, must_change_password)
    VALUES (?,?,?,?,?,1)`).run(b.username, String(b.displayName || '').slice(0, 80), auth.hashPassword(pw), role, maxLabs);
  audit(req, 'user.create', b.username, { role, maxLabs });
  res.json({ id: Number(info.lastInsertRowid), temporaryPassword: pw });
});

app.patch('/api/users/:id', auth.requireUser, auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  const b = req.body || {};
  if (id === req.user.id && (b.role === 'user' || b.disabled)) return res.status(400).json({ error: 'You cannot demote or disable yourself.' });
  const next = {
    display_name: b.displayName !== undefined ? String(b.displayName).slice(0, 80) : u.display_name,
    role: b.role === 'admin' || b.role === 'user' ? b.role : u.role,
    max_labs: b.maxLabs !== undefined ? Math.max(0, Math.min(parseInt(b.maxLabs, 10) || 0, 50)) : u.max_labs,
    disabled: b.disabled !== undefined ? (b.disabled ? 1 : 0) : u.disabled,
  };
  db.prepare('UPDATE users SET display_name=?, role=?, max_labs=?, disabled=? WHERE id=?')
    .run(next.display_name, next.role, next.max_labs, next.disabled, id);
  if (next.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req, 'user.update', u.username, next);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', auth.requireUser, auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  const pw = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(pw), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req, 'user.reset-password', u.username);
  res.json({ temporaryPassword: pw });
});

app.put('/api/users/:id/grants', auth.requireUser, auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  const list = Array.isArray((req.body || {}).templates) ? req.body.templates.filter(vlab.isLabName) : [];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM grants WHERE user_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO grants (user_id, template) VALUES (?,?)');
    for (const t of list) ins.run(id, t);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req, 'user.grants', u.username, list);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth.requireUser, auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);   // their labs fall back to the admin pool
  audit(req, 'user.delete', u.username);
  res.json({ ok: true });
});

app.put('/api/labs/:name/owner', auth.requireUser, auth.requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!labRow(name)) return res.status(404).json({ error: 'No such lab.' });
  const uid = req.body && req.body.userId ? parseInt(req.body.userId, 10) : null;
  const target = uid ? db.prepare('SELECT username FROM users WHERE id = ?').get(uid) : null;
  if (uid && !target) return res.status(404).json({ error: 'No such user.' });
  db.prepare('UPDATE labs SET owner_id = ? WHERE name = ?').run(uid, name);
  audit(req, 'lab.assign', name, { owner: target ? target.username : null });
  res.json({ ok: true });
});

app.get('/api/audit', auth.requireUser, auth.requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  res.json(db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ${limit}`).all());
});

// ---- static front end ---------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

jobs.setOnFinished(() => vlab.runInventory());
vlab.startPolling();
app.listen(config.port, () => console.log(`[portal] listening on http://0.0.0.0:${config.port} (vCenter ${config.vcenter.server}, ONTAP ${config.ontap.cluster}/${config.ontap.svm})`));
