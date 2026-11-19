'use strict';
/* vLab Portal front end. No framework: h() builds DOM nodes (text is always set via textContent). */

// ---------- tiny DOM helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;   // CSSOM, allowed by our CSP (style attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = (sel) => document.querySelector(sel);
const view = () => $('#view');
// replaceChildren() would print null/false as text; drop them (views pass optional blocks)
const render = (...nodes) => view().replaceChildren(...nodes.flat().filter((x) => x != null && x !== false));

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 4000);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vlab-portal' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !opts.allow401) { state.me = null; go('#/login'); throw new Error('Please sign in.'); }
  if (res.status === 403 && data && data.mustChangePassword) { go('#/account'); throw new Error(data.error); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---------- state & routing ----------
const state = { me: null, inv: null, timers: [] };
const isAdmin = () => state.me && state.me.user.role === 'admin';

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
// Views register their auto-refresh with every(). A soft refresh re-runs the view function,
// so every() must not add another timer then (otherwise timers double on each refresh).
function every(ms, fn) { if (state.softRefreshing !== state.navId) state.timers.push(setInterval(fn, ms)); }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

const routes = [
  [/^#\/login$/, viewLogin, true],
  [/^#\/?$/, viewDashboard],
  [/^#\/catalog$/, viewCatalog],
  [/^#\/catalog\/([\w.-]+)$/, viewTemplate, false, true],
  [/^#\/labs$/, viewLabs],
  [/^#\/labs\/([\w.-]+)$/, viewLab],
  [/^#\/jobs$/, viewJobs],
  [/^#\/jobs\/(\d+)$/, viewJob],
  [/^#\/account$/, viewAccount],
  [/^#\/admin\/users$/, viewUsers, false, true],
  [/^#\/admin\/audit$/, viewAudit, false, true],
  [/^#\/admin\/settings$/, viewSettings, false, true],
];

async function route() {
  clearTimers();
  state.navId = (state.navId || 0) + 1;
  state.softRefreshing = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const hash = location.hash || '#/';
  if (!state.me && hash !== '#/login') {
    try { state.me = await api('/api/me', { allow401: true }); } catch (e) { if (!state.me) return go('#/login'); }
  }
  renderChrome(hash);
  if (state.me && state.me.user.mustChangePassword && hash !== '#/account' && hash !== '#/login') return go('#/account');
  for (const [re, fn, open, adminOnly] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    if (!open && !state.me) return go('#/login');
    if (adminOnly && !isAdmin()) return go('#/');
    render(h('div', { class: 'muted' }, 'Loading…'));
    try { await fn(...m.slice(1)); } catch (e) { render(errorBox(e.message)); }
    return;
  }
  go('#/');
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.me = null; go('#/login');
  });
  route();
});

function renderChrome(hash) {
  const bar = $('#topbar');
  if (!state.me || hash === '#/login') { bar.hidden = true; return; }
  bar.hidden = false;
  const site = state.me.site.name;
  $('#site-name').textContent = site;
  document.title = site;
  $('#who-name').textContent = state.me.user.displayName || state.me.user.username;
  const links = [['#/', 'Dashboard'], ['#/catalog', 'Catalog'], ['#/labs', isAdmin() ? 'All labs' : 'My labs'], ['#/jobs', 'Activity']];
  if (isAdmin()) links.push(['#/admin/users', 'Users'], ['#/admin/audit', 'Audit log'], ['#/admin/settings', 'Settings']);
  if (state.me.user.mustChangePassword) links.length = 0;
  $('#nav').replaceChildren(...links.map(([href, label]) => {
    const active = href === '#/' ? (hash === '#/' || hash === '') : hash.startsWith(href);
    return h('a', { href, class: active ? 'active' : '' }, label);
  }));
}

function errorBox(msg) { return h('div', { class: 'notice bad' }, msg); }
function pageHead(title, subtitle, ...tools) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    h('div', { class: 'toolbar' }, ...tools));
}

// ---------- formatting ----------
function statusPill(status, job) {
  if (job) return h('span', { class: 'pill warn busy' }, jobLabel(job.action) + '…');
  const map = { Started: ['ok', 'Running'], Stopped: ['idle', 'Stopped'], Disabled: ['idle', 'Not imported'], Provisioning: ['warn busy', 'Provisioning'] };
  const [cls, label] = map[status] || ['warn', status || 'Unknown'];
  return h('span', { class: 'pill ' + cls }, label);
}
const JOB_LABELS = { provision: 'Provisioning', start: 'Starting', stop: 'Shutting down', kill: 'Powering off', destroy: 'Destroying',
  'lab-snapshot': 'Taking snapshot', 'lab-restore': 'Restoring', 'lab-snapdelete': 'Deleting snapshot',
  'template-enable': 'Enabling', 'template-disable': 'Disabling', 'template-master': 'Snapshotting template' };
const jobLabel = (a) => JOB_LABELS[a] || a;
function jobPill(status) {
  const cls = { succeeded: 'ok', failed: 'bad', running: 'warn busy', queued: 'idle' }[status] || 'idle';
  return h('span', { class: 'pill ' + cls }, status);
}
function when(sqlTime) {
  if (!sqlTime) return '';
  const d = new Date(sqlTime.replace(' ', 'T') + 'Z');
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleString();
}
function diagram(template, hasDiagram) {
  return hasDiagram
    ? h('img', { src: `/api/diagram/${encodeURIComponent(template)}`, alt: `${template} topology`, loading: 'lazy' })
    : h('span', { class: 'placeholder' }, 'No diagram');
}

// ---------- dialogs ----------
function dialog(title, body, buttons) {
  const d = h('dialog', {},
    h('div', { class: 'd-head' }, h('h2', {}, title)),
    h('div', { class: 'd-body' }, body),
    h('div', { class: 'd-foot' }, ...buttons));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
function confirmBox(title, message, okLabel, danger, typeToConfirm) {
  return new Promise((resolve) => {
    const input = typeToConfirm ? h('input', { type: 'text', autocomplete: 'off', placeholder: typeToConfirm }) : null;
    const ok = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), disabled: !!typeToConfirm }, okLabel);
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typeToConfirm; });
    const body = h('div', {}, h('p', {}, message),
      input ? h('label', { class: 'field' }, h('span', {}, `Type ${typeToConfirm} to confirm`), input) : null);
    const d = dialog(title, body, [h('button', { class: 'btn', onclick: () => { d.close(); resolve(false); } }, 'Cancel'), ok]);
    ok.addEventListener('click', () => { d.close(); resolve(true); });
    d.addEventListener('cancel', () => resolve(false));
  });
}
function showSecret(title, username, pw) {
  const d = dialog(title, h('div', {},
    h('p', {}, `Give this one-time password to `, h('b', {}, username), `. They must change it when they first sign in. It won't be shown again.`),
    h('div', { class: 'secret' }, pw)),
  [h('button', { class: 'btn', onclick: () => navigator.clipboard && navigator.clipboard.writeText(pw).then(() => toast('Copied')) }, 'Copy'),
    h('button', { class: 'btn primary', onclick: () => d.close() }, 'Done')]);
}

// ---------- shared lab actions ----------
async function labAction(lab, action) {
  const words = { start: ['Start', `Power on all VMs in ${lab.name}?`],
    stop: ['Shut down', `Ask every VM in ${lab.name} to shut down its guest OS?`],
    kill: ['Power off', `Hard power-off every VM in ${lab.name}? Unsaved work inside the lab is lost.`],
    destroy: ['Destroy', `Permanently delete ${lab.name}: its VMs, networks and storage. This cannot be undone.`] }[action];
  const danger = action === 'kill' || action === 'destroy';
  if (!await confirmBox(`${words[0]} lab`, words[1], words[0], danger, action === 'destroy' ? lab.name : null)) return;
  try {
    const r = await api(`/api/labs/${encodeURIComponent(lab.name)}/${action}`, { method: 'POST' });
    toast(`${words[0]} queued (job #${r.jobId})`);
    route();
  } catch (e) { toast(e.message, true); }
}
async function connect(lab, isTemplate) {
  // open the tab synchronously (popup blockers), then point it at Guacamole
  const win = window.open('', '_blank');
  try {
    const { url } = await api(`/api/${isTemplate ? 'catalog' : 'labs'}/${encodeURIComponent(lab.name)}/connect`);
    if (win) { win.opener = null; win.location = url; } else location.href = url;
  } catch (e) { if (win) win.close(); toast(e.message, true); }
}
function connectButton(lab, compact, isTemplate) {
  return h('button', { class: 'btn primary' + (compact ? ' small' : ''), disabled: !!lab.job || !state.me.site.guacamole || !lab.gatewayIp,
    title: !state.me.site.guacamole ? 'Remote desktop not configured' : (!lab.gatewayIp ? 'Gateway has no address yet' : 'Open the lab desktop'),
    onclick: () => connect(lab, isTemplate) }, 'Connect');
}
function labButtons(lab, compact) {
  const cls = 'btn' + (compact ? ' small' : '');
  const busy = !!lab.job || lab.status === 'Provisioning';
  const running = lab.status === 'Started';
  return [
    running ? connectButton(lab, compact, false) : null,
    !running ? h('button', { class: cls, disabled: busy, onclick: () => labAction(lab, 'start') }, 'Start') : null,
    running ? h('button', { class: cls, disabled: busy, onclick: () => labAction(lab, 'stop') }, 'Shut down') : null,
    running ? h('button', { class: cls + ' danger', disabled: busy, onclick: () => labAction(lab, 'kill') }, 'Power off') : null,
    compact ? h('a', { class: cls, href: `#/labs/${encodeURIComponent(lab.name)}` }, 'Snapshots') : null,
    h('button', { class: cls + ' danger', disabled: busy, onclick: () => labAction(lab, 'destroy') }, 'Destroy'),
  ];
}

async function loadInventory() { state.inv = await api('/api/inventory'); return state.inv; }
function inventoryNotice(inv) {
  if (inv.error) return h('div', { class: 'notice' }, inv.error);
  if (!inv.updatedAt) return h('div', { class: 'notice' }, 'Reading lab status from vCenter and ONTAP… this takes about 30 seconds after the portal starts.');
  return null;
}

// ---------- views ----------
async function viewLogin() {
  const siteLine = h('p', {}, 'Lab Portal');
  api('/api/site', { allow401: true }).then((s) => { siteLine.textContent = s.name; document.title = s.name; }).catch(() => {});
  const user = h('input', { type: 'text', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'error-text' });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Sign in');
  const form = h('form', { class: 'card auth-card' },
    h('h1', {}, 'Sign in'), siteLine,
    h('label', { class: 'field' }, h('span', {}, 'Username'), user),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
    err, btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value }, allow401: true });
      state.me = await api('/api/me', { allow401: true }).catch(() => null);
      go(r.mustChangePassword ? '#/account' : '#/');
    } catch (e) { err.textContent = e.message; btn.disabled = false; pass.select(); }
  });
  render(h('div', { class: 'auth-wrap' }, form));
}

async function viewDashboard() {
  const inv = await loadInventory();
  const c = inv.capacity;
  const running = inv.labs.filter((l) => l.status === 'Started').length;
  const meter = (used, total) => {
    const pct = total ? Math.round((used / total) * 100) : 0;
    return h('div', { class: 'meter' + (pct > 90 ? ' full' : pct > 75 ? ' hot' : '') }, h('i', { style: `width:${pct}%` }));
  };
  const tile = (label, value, sub, m) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null, m || null);
  const tiles = [
    tile(isAdmin() ? 'Lab copies' : 'Your labs', String(inv.labs.length), inv.quota.max != null ? `limit ${inv.quota.max}` : 'all users'),
    tile('Running now', String(running), `${inv.labs.length - running} stopped`),
  ];
  if (c) {
    tiles.push(
      tile('Cluster memory', `${Math.round(c.memUsedGB)} / ${Math.round(c.memTotalGB)} GB`, null, meter(c.memUsedGB, c.memTotalGB)),
      tile('Cluster CPU', `${Math.round(c.cpuUsedMhz / 1000)} / ${Math.round(c.cpuTotalMhz / 1000)} GHz`, null, meter(c.cpuUsedMhz, c.cpuTotalMhz)),
      tile('Lab storage', `${Math.round((c.diskTotalGB - c.diskFreeGB) / 1024)} / ${Math.round(c.diskTotalGB / 1024)} TB`, null, meter(c.diskTotalGB - c.diskFreeGB, c.diskTotalGB)));
  }
  const jobs = await api('/api/jobs?limit=8');
  render(
    pageHead(`Welcome, ${state.me.user.displayName || state.me.user.username}`, inv.updatedAt ? `Status updated ${when(inv.updatedAt.replace('T', ' ').replace(/\..*/, ''))}` : null,
      h('a', { class: 'btn primary', href: '#/catalog' }, 'Browse catalog')),
    inventoryNotice(inv),
    h('div', { class: 'tiles' }, tiles),
    h('div', { class: 'section' }, h('h2', {}, isAdmin() ? 'Lab copies' : 'Your labs'),
      inv.labs.length ? labsTable(inv.labs.slice(0, 8), true)
        : h('div', { class: 'card empty' }, h('h2', {}, 'No labs yet'), h('p', {}, 'Pick one from the catalog to get your own copy.'),
          h('a', { class: 'btn primary', href: '#/catalog' }, 'Open catalog'))),
    h('div', { class: 'section' }, h('h2', {}, 'Recent activity'), jobsTable(jobs)));
  every(15000, () => { if (location.hash === '#/' || location.hash === '') softRefresh(viewDashboard); });
}

// re-render without flashing "Loading…" and without stealing focus from open dialogs
async function softRefresh(fn) {
  if (document.querySelector('dialog[open]') || state.softRefreshing || document.hidden) return;
  const y = window.scrollY;
  const keep = Array.from(view().childNodes);
  state.softRefreshing = state.navId;   // marks "this page is refreshing itself"
  try { await fn(); window.scrollTo(0, y); } catch { view().replaceChildren(...keep); }
  finally { state.softRefreshing = null; }
}

function labsTable(labs, compact) {
  if (!labs.length) return h('div', { class: 'card empty' }, 'No labs.');
  const admin = isAdmin();
  return h('div', { class: 'card table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Lab'), h('th', {}, 'Status'), h('th', {}, 'Gateway'), admin ? h('th', {}, 'Owner') : null, h('th', { class: 'right' }, ''))),
    h('tbody', {}, labs.map((l) => h('tr', {},
      h('td', {}, h('a', { class: 'lab-name', href: `#/labs/${encodeURIComponent(l.name)}` }, l.name), h('div', { class: 'lab-sub' }, l.description || l.template)),
      h('td', {}, statusPill(l.status, l.job), l.job ? h('div', {}, h('a', { class: 'lab-sub', href: `#/jobs/${l.job.id}` }, 'view progress')) : null),
      h('td', { class: 'mono' }, l.gatewayIp || '—'),
      admin ? h('td', {}, compact ? (l.owner ? l.owner.username : h('span', { class: 'muted' }, 'unassigned')) : ownerSelect(l)) : null,
      h('td', {}, h('div', { class: 'actions' }, labButtons(l, true))))))));
}

let usersCache = null;
function ownerSelect(lab) {
  const sel = h('select', { style: 'min-width:140px', onchange: async () => {
    try {
      await api(`/api/labs/${encodeURIComponent(lab.name)}/owner`, { method: 'PUT', body: { userId: sel.value ? Number(sel.value) : null } });
      toast(`${lab.name} assigned to ${sel.value ? sel.selectedOptions[0].textContent : 'nobody'}`);
    } catch (e) { toast(e.message, true); }
  } }, h('option', { value: '' }, '— unassigned —'),
  (usersCache || []).map((u) => h('option', { value: u.id }, u.username)));
  sel.value = lab.owner ? String(lab.owner.id) : '';
  return sel;
}

async function viewCatalog() {
  const inv = await loadInventory();
  const admin = isAdmin();
  const quotaFull = inv.quota.max != null && inv.quota.used >= inv.quota.max;
  const cards = inv.templates.map((t) => {
    const busy = !!t.job;
    const foot = [h('button', { class: 'btn primary', disabled: quotaFull || (admin && t.status === 'Disabled'),
      title: quotaFull ? `You're at your limit of ${inv.quota.max} lab(s)` : '', onclick: () => provision(t) }, 'Get a copy')];
    if (admin && t.status === 'Started') foot.push(connectButton(t, true, true));
    if (admin) foot.push(templateMenu(t));
    return h('div', { class: 'card lab-card' },
      h('div', { class: 'thumb' }, diagram(t.name, t.hasDiagram)),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, admin ? h('a', { class: 'lab-name', href: `#/catalog/${encodeURIComponent(t.name)}` }, t.name) : h('span', {}, t.name),
          admin ? statusPill(t.status, t.job) : null),
        h('div', { class: 'desc' }, t.description || 'No description yet.'),
        admin && busy ? h('a', { class: 'lab-sub', href: `#/jobs/${t.job.id}` }, 'view progress') : null),
      h('div', { class: 'foot' }, foot));
  });
  render(
    pageHead('Catalog', admin ? 'Lab templates. Users only see the ones you grant them.'
      : `Labs you can launch. You are using ${inv.quota.used} of ${inv.quota.max} lab slot(s).`,
    admin ? h('button', { class: 'btn', onclick: async () => { await api('/api/inventory/refresh', { method: 'POST' }); toast('Refreshing status…'); } }, 'Refresh status') : null),
    inventoryNotice(inv),
    cards.length ? h('div', { class: 'grid' }, cards)
      : h('div', { class: 'card empty' }, h('h2', {}, 'Nothing here yet'), h('p', {}, admin ? 'No lab templates were found on ONTAP.' : 'Ask an administrator to give you access to a lab.')));
}

async function provision(t) {
  if (!await confirmBox('Get a copy', `Create your own copy of ${t.name}? It's ready to start in a few minutes.`, 'Create copy')) return;
  try {
    const r = await api(`/api/catalog/${encodeURIComponent(t.name)}/provision`, { method: 'POST' });
    toast(`Creating ${r.name}…`);
    go(`#/jobs/${r.jobId}`);
  } catch (e) { toast(e.message, true); }
}

function templateMenu(t) {
  const sel = h('select', { style: 'width:auto;flex:1', disabled: !!t.job, onchange: async () => {
    const action = sel.value; sel.value = '';
    if (action === 'describe') return editDescription(t);
    if (action === 'diagram') return uploadDiagram(t);
    const text = { enable: 'Register the template VMs in vCenter (as a vApp) so the template can be started, edited and copied.',
      disable: 'Remove the template vApp from vCenter. The ONTAP volume, its snapshots and port groups are kept; Enable brings it back.',
      snapshot: "Take a new 'master' snapshot (the previous one is kept, renamed). New copies start from this point; existing copies are not affected.",
      start: 'Power on the template VMs, e.g. to edit the template.', stop: 'Shut down the template VMs.', kill: 'Hard power-off the template VMs.' }[action];
    if (!await confirmBox(`${sel.querySelector(`option[value=${action}]`).textContent}: ${t.name}`, text, 'Run', ['disable', 'kill'].includes(action))) return;
    try { const r = await api(`/api/catalog/${encodeURIComponent(t.name)}/${action}`, { method: 'POST' }); toast(`Queued job #${r.jobId}`); route(); }
    catch (e) { toast(e.message, true); }
  } },
  h('option', { value: '' }, 'Manage…'),
  [['describe', 'Edit description'], ['diagram', t.hasDiagram ? 'Replace diagram' : 'Upload diagram'], ['snapshot', 'New master snapshot'], ['enable', 'Enable (import)'], ['disable', 'Disable'],
    ['start', 'Start template'], ['stop', 'Shut down template'], ['kill', 'Power off template']]
    .map(([v, l]) => h('option', { value: v }, l)));
  return sel;
}

// admin: one catalog template, its state and the VMs inside it
async function viewTemplate(name) {
  const inv = await loadInventory();
  const t = inv.templates.find((x) => x.name === name);
  if (!t) { render(errorBox('Template not found.')); return; }
  const jobs = await api(`/api/jobs?target=${encodeURIComponent(name)}&limit=20`);
  const running = t.status === 'Started';
  const rows = t.vms.map((vm) => h('tr', {},
    h('td', {}, h('div', { class: 'lab-name' }, vm.name), vm.os ? h('div', { class: 'lab-sub' }, vm.os) : null),
    h('td', {}, statusPill(vm.power === 'PoweredOn' ? 'Started' : 'Stopped')),
    h('td', { class: 'mono' }, vm.ip || '—'),
    h('td', {}, `${vm.cpu} vCPU · ${vm.memGB} GB`)));
  render(
    pageHead(t.name, t.description || 'Catalog template', running ? connectButton(t, false, true) : null, templateMenu(t)),
    inventoryNotice(inv),
    h('div', { class: 'tiles' },
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Status'), h('div', { style: 'margin-top:8px' }, statusPill(t.status, t.job))),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Gateway (WAN)'), h('div', { class: 'value mono', style: 'font-size:20px' }, t.gatewayIp || '—')),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Virtual machines'), h('div', { class: 'value' }, String(t.vms.length))),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Volume size'), h('div', { class: 'value' }, t.sizeGB != null ? `${t.sizeGB} GB` : '—'))),
    h('div', { class: 'section' }, h('h2', {}, 'Virtual machines'),
      t.vms.length ? h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'VM'), h('th', {}, 'Power'), h('th', {}, 'IP address'), h('th', {}, 'Size'))),
        h('tbody', {}, rows)))
        : h('div', { class: 'card empty' }, h('p', {}, t.status === 'Disabled' ? 'This template is not enabled in vCenter. Use Manage → Enable to import its VMs.' : 'No VMs found.'))),
    t.hasDiagram ? h('div', { class: 'section card', style: 'overflow:hidden' }, h('img', { src: `/api/diagram/${encodeURIComponent(t.name)}`, alt: 'Lab topology', style: 'width:100%;display:block' })) : null,
    h('div', { class: 'section' }, h('h2', {}, 'History'), jobsTable(jobs)));
  every(10000, () => { if (location.hash === `#/catalog/${encodeURIComponent(name)}` || location.hash === `#/catalog/${name}`) softRefresh(() => viewTemplate(name)); });
}

function uploadDiagram(t) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
  const d = dialog(`Diagram: ${t.name}`, h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'PNG or JPEG, up to 10 MB'), file),
    h('p', { class: 'muted' }, t.hasDiagram ? 'This replaces the current diagram. ' : '', 'It shows on the catalog card and on every copy of this lab.')), [
    h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const f = file.files[0];
      if (!f) return toast('Choose an image first.', true);
      if (f.size > 10 * 1024 * 1024) return toast('That image is larger than 10 MB.', true);
      try {
        const res = await fetch(`/api/catalog/${encodeURIComponent(t.name)}/diagram`, { method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': f.type === 'image/png' ? 'image/png' : 'image/jpeg', 'X-Requested-With': 'vlab-portal' }, body: f });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        d.close(); toast('Diagram saved'); route();
      } catch (e) { toast(e.message, true); }
    } }, 'Upload')]);
}

function editDescription(t) {
  const ta = h('textarea', { maxlength: 300 }, t.description || '');
  const d = dialog(`Description: ${t.name}`, h('label', { class: 'field' }, h('span', {}, 'Shown on the catalog card'), ta), [
    h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api(`/api/catalog/${encodeURIComponent(t.name)}/description`, { method: 'PUT', body: { description: ta.value } }); d.close(); toast('Saved'); route(); }
      catch (e) { toast(e.message, true); }
    } }, 'Save')]);
}

async function viewLabs() {
  if (isAdmin()) usersCache = await api('/api/users');
  const inv = await loadInventory();
  render(
    pageHead(isAdmin() ? 'All lab copies' : 'My labs',
      isAdmin() ? 'Every provisioned copy. Assign an owner to hand a lab to a user.' : `${inv.quota.used} of ${inv.quota.max} lab slot(s) used.`,
      h('a', { class: 'btn primary', href: '#/catalog' }, 'Get another lab')),
    inventoryNotice(inv),
    inv.labs.length ? labsTable(inv.labs, false)
      : h('div', { class: 'card empty' }, h('h2', {}, 'No labs yet'), h('a', { class: 'btn primary', href: '#/catalog' }, 'Open catalog')));
  every(15000, () => { if (location.hash === '#/labs') softRefresh(viewLabs); });
}

async function viewLab(name) {
  const inv = await loadInventory();
  const lab = inv.labs.find((l) => l.name === name);
  if (!lab) { render(errorBox('Lab not found, or you do not have access to it.')); return; }
  const jobs = await api(`/api/jobs?target=${encodeURIComponent(name)}&limit=20`);
  render(
    pageHead(lab.name, lab.description || `Copy of ${lab.template}`, ...labButtons(lab, false)),
    inventoryNotice(inv),
    h('div', { class: 'tiles' },
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Status'), h('div', { style: 'margin-top:8px' }, statusPill(lab.status, lab.job))),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Gateway (WAN)'), h('div', { class: 'value mono', style: 'font-size:20px' }, lab.gatewayIp || '—')),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Virtual machines'), h('div', { class: 'value' }, String(lab.vmCount || 0))),
      h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Template'), h('div', { class: 'value', style: 'font-size:18px' }, lab.template),
        isAdmin() ? h('div', { class: 'sub' }, lab.owner ? `owner: ${lab.owner.username}` : 'unassigned') : null)),
    snapshotsSection(lab),
    lab.hasDiagram ? h('div', { class: 'section card', style: 'overflow:hidden' }, h('img', { src: `/api/diagram/${encodeURIComponent(lab.template)}`, alt: 'Lab topology', style: 'width:100%;display:block' })) : null,
    h('div', { class: 'section' }, h('h2', {}, 'History'), jobsTable(jobs)));
  every(10000, () => { if (location.hash === `#/labs/${encodeURIComponent(name)}` || location.hash === `#/labs/${name}`) softRefresh(() => viewLab(name)); });
}

// ---------- lab snapshots ----------
function snapshotsSection(lab) {
  const max = state.me.site.maxSnapshotsPerLab;
  const own = lab.snapshots.filter((x) => !x.original);
  const busy = !!lab.job || lab.status === 'Provisioning';
  const take = h('button', { class: 'btn primary small', disabled: busy || own.length >= max,
    title: own.length >= max ? `Limit of ${max} reached; delete one first` : '', onclick: () => takeSnapshot(lab) }, 'Take snapshot');
  const rows = lab.snapshots.map((x) => h('tr', {},
    h('td', {}, h('div', { class: 'lab-name' }, x.label || 'Snapshot'), h('div', { class: 'lab-sub mono' }, x.name)),
    h('td', { class: 'muted' }, x.created ? new Date(x.created).toLocaleString() : ''),
    h('td', {}, h('div', { class: 'actions' },
      h('button', { class: 'btn small', disabled: busy, onclick: () => restoreSnapshot(lab, x) }, x.original ? 'Reset to original' : 'Restore'),
      x.original ? null : h('button', { class: 'btn small danger', disabled: busy, onclick: () => deleteSnapshot(lab, x) }, 'Delete')))));
  return h('div', { class: 'section' },
    h('div', { class: 'page-head', style: 'margin-bottom:12px' },
      h('div', {}, h('h2', { style: 'margin:0' }, 'Snapshots'),
        h('p', { class: 'muted', style: 'margin:2px 0 0' }, `Save this lab's state and roll back to it. ${own.length} of ${max} used; the original is always kept.`)),
      take),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Snapshot'), h('th', {}, 'Taken'), h('th', {}, ''))),
      h('tbody', {}, rows))));
}

async function takeSnapshot(lab) {
  const label = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Before upgrading ONTAP' });
  const running = lab.status === 'Started';
  const go_ = async () => {
    try {
      const r = await api(`/api/labs/${encodeURIComponent(lab.name)}/snapshots`, { method: 'POST', body: { label: label.value } });
      d.close(); toast(`Snapshot queued (job #${r.jobId})`); route();
    } catch (e) { toast(e.message, true); }
  };
  const d = dialog(`Snapshot ${lab.name}`, h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Name for this snapshot'), label),
    running ? h('div', { class: 'notice' }, "The lab is running. The snapshot is taken instantly but is crash-consistent, like pulling the power plug. For a clean snapshot, shut the lab down first.") : null,
    h('p', { class: 'muted' }, 'Only this lab copy is affected. The catalog template and other people\'s labs are not touched.')),
  [h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go_ }, 'Take snapshot')]);
  label.focus();
}

async function restoreSnapshot(lab, snap) {
  const newer = lab.snapshots.filter((x) => !x.original && x.created > snap.created).length;
  const msg = (snap.original
    ? `Reset ${lab.name} to exactly how it was when it was created. Everything changed since then is lost.`
    : `Roll ${lab.name} back to "${snap.label || snap.name}". Everything changed since then is lost.`)
    + ' The lab is powered off first and stays off afterwards.'
    + (newer ? ` ${newer} newer snapshot(s) will be deleted too (ONTAP removes snapshots taken after the one you restore).` : '');
  if (!await confirmBox(snap.original ? 'Reset to original' : 'Restore snapshot', msg, snap.original ? 'Reset lab' : 'Restore', true, lab.name)) return;
  try {
    const r = await api(`/api/labs/${encodeURIComponent(lab.name)}/snapshots/${encodeURIComponent(snap.name)}/restore`, { method: 'POST' });
    toast('Restore queued'); go(`#/jobs/${r.jobId}`);
  } catch (e) { toast(e.message, true); }
}

async function deleteSnapshot(lab, snap) {
  if (!await confirmBox('Delete snapshot', `Delete "${snap.label || snap.name}" from ${lab.name}? The lab itself is not changed.`, 'Delete', true)) return;
  try {
    await api(`/api/labs/${encodeURIComponent(lab.name)}/snapshots/${encodeURIComponent(snap.name)}`, { method: 'DELETE' });
    toast('Delete queued'); route();
  } catch (e) { toast(e.message, true); }
}

function jobsTable(jobs) {
  if (!jobs.length) return h('div', { class: 'card empty' }, 'Nothing yet.');
  return h('div', { class: 'card table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Action'), h('th', {}, 'Lab'), h('th', {}, 'Status'), isAdmin() ? h('th', {}, 'By') : null, h('th', {}, 'When'))),
    h('tbody', {}, jobs.map((j) => h('tr', {},
      h('td', {}, h('a', { href: `#/jobs/${j.id}` }, `#${j.id}`)),
      h('td', {}, jobLabel(j.action)),
      h('td', { class: 'mono' }, j.target),
      h('td', {}, jobPill(j.status)),
      isAdmin() ? h('td', {}, j.username || '') : null,
      h('td', { class: 'muted' }, when(j.created_at)))))));
}

async function viewJobs() {
  const jobs = await api('/api/jobs?limit=100');
  render(pageHead('Activity', isAdmin() ? 'Every provisioning and power job.' : 'Your provisioning and power jobs.'), jobsTable(jobs));
  every(10000, () => { if (location.hash === '#/jobs') softRefresh(viewJobs); });
}

async function viewJob(id) {
  const pre = h('pre', { class: 'log' });
  const head = h('div');
  // admins also see template jobs; those link to the template page, not a lab copy
  const templates = isAdmin() ? new Set((await loadInventory()).templates.map((t) => t.name)) : new Set();
  const refresh = async () => {
    const j = await api(`/api/jobs/${id}`);
    head.replaceChildren(pageHead(`${jobLabel(j.action)} · ${j.target}`,
      `Job #${j.id}${j.username ? ` by ${j.username}` : ''} · started ${when(j.started_at || j.created_at)}`,
      jobPill(j.status), templates.has(j.target)
        ? h('a', { class: 'btn', href: `#/catalog/${encodeURIComponent(j.target)}` }, 'Open template')
        : h('a', { class: 'btn', href: `#/labs/${encodeURIComponent(j.target)}` }, 'Open lab')));
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = j.log || '(waiting to start…)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    return j.status === 'queued' || j.status === 'running';
  };
  const live = await refresh();
  render(head, h('div', { class: 'card' }, h('div', { class: 'card pad', style: 'border:0;box-shadow:none' }, h('b', {}, 'Output')), pre));
  pre.scrollTop = pre.scrollHeight;
  if (live) every(2000, async () => { if (location.hash === `#/jobs/${id}` && !(await refresh())) clearTimers(); });
}

async function viewAccount() {
  const must = state.me.user.mustChangePassword;
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'error-text' });
  const form = h('form', { class: 'card auth-card' },
    h('h1', {}, must ? 'Choose a new password' : 'Change password'),
    h('p', {}, must ? 'You signed in with a temporary password. Pick your own to continue.' : `Signed in as ${state.me.user.username}.`),
    h('label', { class: 'field' }, h('span', {}, must ? 'Temporary password' : 'Current password'), cur),
    h('label', { class: 'field' }, h('span', {}, 'New password (10+ characters)'), n1),
    h('label', { class: 'field' }, h('span', {}, 'New password again'), n2),
    err, h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Save password'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); err.textContent = '';
    if (n1.value !== n2.value) { err.textContent = "The new passwords don't match."; return; }
    try {
      await api('/api/me/password', { method: 'POST', body: { current: cur.value, next: n1.value } });
      state.me = await api('/api/me');
      toast('Password changed');
      go('#/');
    } catch (e) { err.textContent = e.message; }
  });
  render(h('div', { class: 'auth-wrap' }, form));
}

async function viewUsers() {
  const [users, inv] = await Promise.all([api('/api/users'), loadInventory()]);
  const templates = inv.templates.map((t) => t.name);
  render(
    pageHead('Users', 'Create accounts, choose which catalog labs each person can launch, and how many copies they may hold.',
      h('button', { class: 'btn primary', onclick: () => editUser(null, templates) }, 'New user')),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Labs'), h('th', {}, 'Access'), h('th', {}, 'Last sign-in'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('div', { class: 'lab-name' }, u.username), h('div', { class: 'lab-sub' }, u.display_name || '')),
        h('td', {}, u.disabled ? h('span', { class: 'pill bad' }, 'disabled') : h('span', { class: 'pill ' + (u.role === 'admin' ? 'warn' : 'idle') }, u.role)),
        h('td', {}, u.role === 'admin' ? `${u.labs}` : `${u.labs} / ${u.max_labs}`),
        h('td', { class: 'lab-sub' }, u.role === 'admin' ? 'everything' : (u.grants.length ? u.grants.join(', ') : 'none')),
        h('td', { class: 'muted' }, u.last_login_at ? when(u.last_login_at) : (u.must_change_password ? 'never (temp password)' : 'never')),
        h('td', {}, h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => editUser(u, templates) }, 'Edit')))))))));
}

function editUser(u, templates) {
  const isNew = !u;
  const username = h('input', { type: 'text', value: u ? u.username : '', disabled: !isNew, autocomplete: 'off' });
  const display = h('input', { type: 'text', value: u ? u.display_name : '' });
  const role = h('select', {}, h('option', { value: 'user' }, 'User'), h('option', { value: 'admin' }, 'Admin'));
  role.value = u ? u.role : 'user';
  const maxLabs = h('input', { type: 'number', min: 0, max: 50, value: u ? u.max_labs : 1 });
  const disabled = h('input', { type: 'checkbox', checked: u && u.disabled });
  const boxes = templates.map((t) => h('input', { type: 'checkbox', value: t, checked: u && u.grants.includes(t) }));
  const grants = h('div', { class: 'grants' }, boxes.map((b) => h('label', { class: 'check' }, b, h('span', { class: 'mono' }, b.value))));
  const grantsField = h('div', { class: 'field' }, h('span', { style: 'display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:5px' }, 'Catalog labs this user can launch'), grants);
  const syncRole = () => { grantsField.hidden = role.value === 'admin'; };
  role.addEventListener('change', syncRole); syncRole();

  const body = h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Username'), username),
    h('label', { class: 'field' }, h('span', {}, 'Full name'), display),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
      h('label', { class: 'field' }, h('span', {}, 'Role'), role),
      h('label', { class: 'field' }, h('span', {}, 'Max lab copies'), maxLabs)),
    grantsField,
    !isNew ? h('label', { class: 'check' }, disabled, h('span', {}, 'Account disabled (cannot sign in)')) : null);

  const save = async () => {
    try {
      let id = u && u.id;
      if (isNew) {
        const r = await api('/api/users', { method: 'POST', body: { username: username.value.trim(), displayName: display.value, role: role.value, maxLabs: maxLabs.value } });
        id = r.id;
        await api(`/api/users/${id}/grants`, { method: 'PUT', body: { templates: boxes.filter((b) => b.checked).map((b) => b.value) } });
        d.close(); showSecret('User created', username.value.trim(), r.temporaryPassword);
      } else {
        await api(`/api/users/${id}`, { method: 'PATCH', body: { displayName: display.value, role: role.value, maxLabs: maxLabs.value, disabled: disabled.checked } });
        await api(`/api/users/${id}/grants`, { method: 'PUT', body: { templates: boxes.filter((b) => b.checked).map((b) => b.value) } });
        d.close(); toast('Saved');
      }
      viewUsers();
    } catch (e) { toast(e.message, true); }
  };
  const buttons = [];
  if (!isNew) {
    buttons.push(h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: async () => {
      d.close();
      if (!await confirmBox('Delete user', `Delete ${u.username}? Their lab copies stay and become unassigned.`, 'Delete', true, u.username)) return;
      try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('User deleted'); viewUsers(); } catch (e) { toast(e.message, true); }
    } }, 'Delete'));
    buttons.push(h('button', { class: 'btn', onclick: async () => {
      d.close();
      if (!await confirmBox('Reset password', `Give ${u.username} a new temporary password? Their current sessions are signed out.`, 'Reset')) return;
      try { const r = await api(`/api/users/${u.id}/reset-password`, { method: 'POST' }); showSecret('Password reset', u.username, r.temporaryPassword); viewUsers(); }
      catch (e) { toast(e.message, true); }
    } }, 'Reset password'));
  }
  buttons.push(h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, isNew ? 'Create user' : 'Save'));
  const d = dialog(isNew ? 'New user' : `Edit ${u.username}`, body, buttons);
}

async function viewSettings() {
  const cfg = await api('/api/settings');
  const name = h('input', { type: 'text', maxlength: 60, value: cfg.siteName, placeholder: cfg.defaultSiteName });
  const form = h('form', { class: 'card pad', style: 'max-width:560px' },
    h('label', { class: 'field' }, h('span', {}, 'Portal name'), name),
    h('p', { class: 'muted' }, `Shown in the top-left corner, the browser tab and the sign-in page. Leave it blank to use the name from config.json (${cfg.defaultSiteName}).`),
    h('button', { class: 'btn primary', type: 'submit' }, 'Save'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { siteName: name.value } });
      state.me.site.name = r.siteName; name.value = r.siteName;
      renderChrome(location.hash); toast('Saved');
    } catch (e) { toast(e.message, true); }
  });
  render(pageHead('Settings', 'Portal-wide settings. Changes apply immediately for everyone.'), form);
}

async function viewAudit() {
  const rows = await api('/api/audit?limit=300');
  render(pageHead('Audit log', 'Sign-ins and every change made through the portal.'),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'User'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'From'), h('th', {}, 'Detail'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'muted', style: 'white-space:nowrap' }, new Date(r.at.replace(' ', 'T') + 'Z').toLocaleString()),
        h('td', {}, r.username || '—'),
        h('td', {}, h('span', { class: 'pill ' + (r.action.includes('failed') ? 'bad' : 'idle') }, r.action)),
        h('td', { class: 'mono' }, r.target || ''),
        h('td', { class: 'mono muted' }, (r.ip || '').replace('::ffff:', '')),
        h('td', { class: 'lab-sub mono' }, r.detail || '')))))));
}
