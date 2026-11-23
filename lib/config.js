'use strict';
// Portal settings: config.json next to server.js (written by install.ps1; see config.example.json).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const file = path.join(root, 'config.json');
const defaults = {
  port: 8090,
  inventoryIntervalSec: 60,
  maxConcurrentJobs: 2,
  secureCookies: false,          // set true once the portal is served over HTTPS
  site: { name: 'vLab Portal' },
  vcenter: { server: '', cluster: '', vswitch: 'vSwitch0', wanPortgroup: 'VM Network', vlanBase: 1000 },
  ontap: { cluster: '', svm: '', datastore: '', junctionRoot: '' },
  labs: { firstId: 1000, autostart: false, maxSnapshotsPerLab: 5 },
  rdp: { domain: '', user: 'administrator', password: '' },
  guacamole: { url: '', jsonSecretKey: '' },
  legacyCmdbDir: 'C:\\vlab\\cmdb',   // vlab 1.x cmdb: <lab>.conf files there are honoured too (blank = don't look)
};

let user = {};
if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const merged = { ...defaults, ...user };
for (const k of ['site', 'vcenter', 'ontap', 'labs', 'rdp', 'guacamole']) merged[k] = { ...defaults[k], ...(user[k] || {}) };
merged.root = root;
merged.catalogDir = path.join(root, 'catalog');   // descriptions.tbl, <template>.jpg|png, <template>.conf
module.exports = merged;
