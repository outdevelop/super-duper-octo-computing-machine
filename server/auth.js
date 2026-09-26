'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p)
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Хэш-заглушка для выравнивания времени ответа, когда пользователь не найден.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* битый cookie */ }
  }
  return out;
}

function createAuth(db, { secureCookies = false } = {}) {
  const stmt = {
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    findSession: db.prepare(`
      SELECT u.id, u.email, u.name, u.phone, u.role, u.created_at, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?')
  };

  function cookieHeader(value, maxAgeSec) {
    const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    stmt.insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', cookieHeader(token, SESSION_TTL_MS / 1000));
    return token;
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) stmt.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', cookieHeader('', 0));
  }

  // Завершает все сессии пользователя, кроме текущей (после смены пароля).
  function endOtherSessions(req, userId) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
    stmt.deleteUserSessions.run(userId, sha256(token));
  }

  // Middleware: кладёт пользователя в req.user (или null).
  function loadUser(req, res, next) {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const tokenHash = sha256(token);
      const row = stmt.findSession.get(tokenHash);
      if (row && row.expires_at > Date.now()) {
        const { expires_at, ...user } = row;
        req.user = user;
      } else if (row) {
        stmt.deleteSession.run(tokenHash);
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
    next();
  }

  function requireManager(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  }

  const timer = setInterval(() => stmt.purgeExpired.run(Date.now()), 60 * 60 * 1000);
  timer.unref();

  return { startSession, endSession, endOtherSessions, loadUser, requireUser, requireManager };
}

// Простой лимитер попыток в памяти: не более `max` событий за `windowMs` на ключ.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return function limit(keyFn) {
    return (req, res, next) => {
      const key = keyFn(req);
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset < now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > max) {
        res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
        return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
      }
      next();
    };
  };
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, createAuth, createRateLimiter, parseCookies };
