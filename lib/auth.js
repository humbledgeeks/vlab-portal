'use strict';
// Local accounts: scrypt password hashes, random session tokens stored hashed in SQLite.
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_HOURS = 12;
const COOKIE = 'vlab_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId, secureCookie) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), userId, expires);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: SESSION_HOURS * 3600 * 1000, path: '/' });
}

function destroySession(req, res) {
  const token = readCookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Attaches req.user when a valid session cookie is present.
function loadUser(req, _res, next) {
  const token = readCookie(req);
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.max_labs, u.disabled, u.must_change_password
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
    if (row && !row.disabled) req.user = row;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  // Until a temporary password is changed, only allow the password change itself.
  if (req.user.must_change_password && !['/api/me', '/api/me/password', '/api/logout'].includes(req.path)) {
    return res.status(403).json({ error: 'You must change your password first.', mustChangePassword: true });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

// Simple in-memory login throttle: 5 failures per user+IP -> 15 minute lockout.
const failures = new Map();
function loginBlocked(key) {
  const f = failures.get(key);
  return f && f.count >= 5 && Date.now() - f.last < 15 * 60 * 1000;
}
function noteFailure(key) {
  const f = failures.get(key) || { count: 0, last: 0 };
  if (Date.now() - f.last > 15 * 60 * 1000) f.count = 0;
  f.count++; f.last = Date.now();
  failures.set(key, f);
}
function clearFailures(key) { failures.delete(key); }

module.exports = {
  hashPassword, verifyPassword, passwordProblem, createSession, destroySession,
  loadUser, requireUser, requireAdmin, loginBlocked, noteFailure, clearFailures,
};
