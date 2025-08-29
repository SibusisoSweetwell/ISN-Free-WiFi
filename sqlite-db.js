// Lightweight synchronous SQLite adapter using better-sqlite3 and bcryptjs
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let DB = null;

function init(dbPath) {
  try {
    const Database = require('better-sqlite3');
    // default DB filename used by scripts in this repo is 'logins.db'
    const file = dbPath || path.join(__dirname, 'logins.db');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    DB = new Database(file);
    DB.pragma('journal_mode = WAL');

    DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      phone TEXT,
      password_hash TEXT,
      password TEXT,
      firstName TEXT,
      surname TEXT,
      dob TEXT,
      dateCreatedISO TEXT,
      dateCreatedLocal TEXT
    )`).run();

    DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT,
      type TEXT,
      tsISO TEXT,
      ip TEXT,
      ua TEXT,
      data TEXT
    )`).run();

    return true;
  } catch (err) {
    console.error('[SQLITE-INIT-ERROR]', err && err.message);
    DB = null;
    return false;
  }
}

function hashPassword(p) {
  return bcrypt.hashSync(p, 10);
}

function validateLogin(identifier, password) {
  if (!DB) {
    console.warn('[SQLITE-DBG] validateLogin called but DB not initialized');
    return false;
  }
  const id = String(identifier || '').trim();
  const pw = String(password || '');
  const maskedPw = pw.length > 2 ? pw[0] + '***' + pw[pw.length-1] : '***';
  const isEmail = id.includes('@');
  console.log('[SQLITE-DBG] validateLogin input:', { identifier: id, password: maskedPw });
  const row = isEmail
    ? DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(id)
    : DB.prepare('SELECT * FROM users WHERE phone=?').get(id);
  if (!row) {
    console.log('[SQLITE-DBG] user not found for', id);
    return false;
  }

  if (row.password_hash) {
    try {
      const ok = bcrypt.compareSync(pw, row.password_hash);
      console.log('[SQLITE-DBG] user found, password_hash present, bcrypt.compareSync ->', ok);
      return ok;
    } catch (err) {
      console.warn('[SQLITE-DBG] bcrypt.compareSync error', err && err.message);
      return false;
    }
  }

  // legacy: if password_hash missing, allow plain-text match then migrate
  if (row.password && row.password === pw) {
    console.log('[SQLITE-DBG] legacy plaintext password matched; migrating to hash');
    const newHash = hashPassword(pw);
    DB.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, row.id);
    return true;
  }
  return false;
}

function findUser(identifier) {
  if (!DB) return null;
  if (!identifier) return null;
  const id = String(identifier || '').trim();
  if (id.includes('@')) {
    return DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(id);
  }
  return DB.prepare('SELECT * FROM users WHERE phone=?').get(identifier);
}

function changePassword(identifier, newPassword) {
  if (!DB) return { ok: false, message: 'DB not initialized' };
  const user = findUser(identifier);
  if (!user) return { ok: false, message: 'User not found' };
  const hash = hashPassword(newPassword);
  DB.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
  return { ok: true };
}

function createUser(obj) {
  if (!DB) return { ok: false, message: 'DB not initialized' };
  const dateISO = new Date().toISOString();
  const hash = obj.password ? hashPassword(obj.password) : null;
  const emailNorm = obj.email ? String(obj.email).trim().toLowerCase() : null;
  const info = DB.prepare(`INSERT INTO users (email,phone,password_hash,password,firstName,surname,dob,dateCreatedISO,dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(emailNorm, obj.phone || null, hash, obj.password || null, obj.firstName || null, obj.surname || null, obj.dob || null, dateISO, new Date().toString());
  return { ok: true, id: info.lastInsertRowid };
}

function appendAccessEvent(evt) {
  if (!DB) return;
  try {
    DB.prepare('INSERT INTO events (identifier,type,tsISO,ip,ua,data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(evt.identifier || null, evt.type || null, evt.tsISO || new Date().toISOString(), evt.ip || null, evt.ua || null, JSON.stringify(evt.data || {}));
  } catch (err) {
    console.warn('[SQLITE-APPEND-EVENT-FAILED]', err && err.message);
  }
}

module.exports = {
  init,
  validateLogin,
  findUser,
  changePassword,
  createUser,
  appendAccessEvent,
  _db: () => DB
};

