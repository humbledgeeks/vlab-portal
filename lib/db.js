'use strict';
// SQLite storage (node:sqlite, built into Node 24). One file: data/portal.db
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'portal.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  max_labs      INTEGER NOT NULL DEFAULT 1,
  disabled      INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- which catalog templates a user may provision copies of
CREATE TABLE IF NOT EXISTS grants (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template  TEXT NOT NULL,
  PRIMARY KEY (user_id, template)
);

-- lab copies (FlexClone instances) and who owns them; owner NULL = admin pool
CREATE TABLE IF NOT EXISTS labs (
  name        TEXT PRIMARY KEY,
  template    TEXT NOT NULL,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '[]',     -- JSON array passed to the script
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|succeeded|failed
  log         TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  user_id   INTEGER,
  username  TEXT,
  ip        TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT
);
`);

// Jobs left running when the portal stopped can never finish; mark them.
db.prepare(`UPDATE jobs SET status='failed', finished_at=datetime('now'),
  log = log || '\n[portal restarted while this job was running; check the lab state]'
  WHERE status IN ('queued','running')`).run();

function audit(req, action, target = null, detail = null) {
  const u = req && req.user;
  db.prepare('INSERT INTO audit (user_id, username, ip, action, target, detail) VALUES (?,?,?,?,?,?)')
    .run(u ? u.id : null, u ? u.username : null, req ? req.ip : null, action, target,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

module.exports = { db, audit };
