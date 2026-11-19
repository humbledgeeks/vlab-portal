'use strict';
// Portal settings: config.json next to server.js (not in git; see config.example.json).
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'config.json');
const defaults = {
  port: 8090,
  vlabRoot: 'C:\\vlab',
  inventoryIntervalSec: 60,
  maxConcurrentJobs: 2,
  secureCookies: false,          // set true once the portal is served over HTTPS
  guacamole: {
    url: '',                     // e.g. http://<guacamole-host>:8085/guacamole
    jsonSecretKey: '',           // 32 hex chars, same as JSON_SECRET_KEY on the Guacamole host
  },
};

let user = {};
if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
module.exports = { ...defaults, ...user, guacamole: { ...defaults.guacamole, ...(user.guacamole || {}) } };
