'use strict';
// Apache Guacamole "encrypted JSON" auth: HMAC-SHA256 sign, AES-128-CBC (zero IV) encrypt, base64.
// The ticket names one user and one RDP connection; the browser never sees the RDP password.
const crypto = require('node:crypto');
const config = require('./config');

function enabled() {
  return /^[0-9a-f]{32}$/i.test(config.guacamole.jsonSecretKey || '') && !!config.guacamole.url;
}

function connectUrl({ username, connectionName, hostname, port = 3389, rdp }) {
  const key = Buffer.from(config.guacamole.jsonSecretKey, 'hex');
  const payload = Buffer.from(JSON.stringify({
    username,
    expires: Date.now() + 5 * 60 * 1000,   // ticket must be used within 5 minutes
    connections: {
      [connectionName]: {
        protocol: 'rdp',
        parameters: {
          hostname, port: String(port),
          username: rdp.username, password: rdp.password, domain: rdp.domain,
          security: 'any', 'ignore-cert': 'true', 'resize-method': 'display-update',
          'enable-wallpaper': 'false', 'enable-font-smoothing': 'true',
        },
      },
    },
  }));
  const sig = crypto.createHmac('sha256', key).update(payload).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  const data = Buffer.concat([cipher.update(Buffer.concat([sig, payload])), cipher.final()]).toString('base64');
  return `${config.guacamole.url.replace(/\/$/, '')}/#/?data=${encodeURIComponent(data)}`;
}

module.exports = { enabled, connectUrl };
