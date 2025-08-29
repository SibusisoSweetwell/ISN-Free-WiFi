// Lightweight synchronous SQLite adapter using better-sqlite3 and bcryptjs
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
let DB;
function init(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const file = dbPath || path.join(__dirname, 'data.sqlite');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    DB = new Database(file);
    DB.pragma('journal_mode = WAL');

    DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      phone TEXT,
      password_hash TEXT,
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
  if (!DB) return false;
  const isEmail = identifier.includes('@');
  const row = isEmail ? DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(identifier) : DB.prepare('SELECT * FROM users WHERE phone=?').get(identifier);
  if (!row) return false;

  if (row.password_hash) {
    return bcrypt.compareSync(password, row.password_hash);
  }

  // legacy: if password_hash missing, allow plain-text match then migrate
  if (row.password === password) {
    const newHash = hashPassword(password);
    DB.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, row.id);
    return true;
  }
  return false;
}

function findUser(identifier) {
  if (!DB) return null;
  if (!identifier) return null;
  if (identifier.includes('@')) {
    return DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(identifier);
  }
  return DB.prepare('SELECT * FROM users WHERE phone=?').get(identifier);
}

function changePassword(identifier, newPassword) {
  if (!DB) return { ok:false, message:'DB not initialized' };
  const user = findUser(identifier);
  if (!user) return { ok:false, message:'User not found' };
  const hash = hashPassword(newPassword);
  DB.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
  return { ok:true };
}

function createUser(obj) {
  if (!DB) return { ok:false, message:'DB not initialized' };
  const dateISO = new Date().toISOString();
  const hash = obj.password ? hashPassword(obj.password) : null;
  const info = DB.prepare(`INSERT INTO users (email,phone,password_hash,firstName,surname,dob,dateCreatedISO,dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(obj.email||null, obj.phone||null, hash, obj.firstName||null, obj.surname||null, obj.dob||null, dateISO, new Date().toString());
  return { ok:true, id: info.lastInsertRowid };
}

function appendAccessEvent(evt) {
  if (!DB) return;
  try {
    DB.prepare('INSERT INTO events (identifier,type,tsISO,ip,ua,data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(evt.identifier||null, evt.type||null, evt.tsISO||new Date().toISOString(), evt.ip||null, evt.ua||null, JSON.stringify(evt.data||{}));
  } catch (err) {
    console.warn('[SQLITE-APPEND-EVENT-FAILED]', err && err.message);
  }
}

module.exports = {
  init, validateLogin, findUser, changePassword, createUser, appendAccessEvent, _db: ()=>DB
};
