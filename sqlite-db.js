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
  admin_code_hash TEXT,
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

      // Call temp_unlocks table creation to ensure table exists at startup
      createTempUnlocksTable();

    function createTempUnlocksTable() {
      DB.prepare(`CREATE TABLE IF NOT EXISTS temp_unlocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT,
        deviceId TEXT,
        expiry INTEGER
      )`).run();
      // Indexes to speed up lookups and expiry cleanup
      DB.prepare('CREATE INDEX IF NOT EXISTS idx_temp_unlocks_expiry ON temp_unlocks(expiry)').run();
      DB.prepare('CREATE INDEX IF NOT EXISTS idx_temp_unlocks_ident_dev ON temp_unlocks(identifier, deviceId)').run();
    }
    // Purchases and Usage tables for data tracking
    DB.prepare(`CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT,
      data_amount REAL,
      bundle_type TEXT,
      video_count INTEGER,
      timestamp TEXT,
      purchase_type TEXT
    )`).run();
    DB.prepare(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT,
      data_used REAL,
      description TEXT,
      timestamp TEXT,
      session_id TEXT
    )`).run();
    DB.prepare('CREATE INDEX IF NOT EXISTS idx_purchases_phone ON purchases(phone_number)').run();
    DB.prepare('CREATE INDEX IF NOT EXISTS idx_usage_phone ON usage(phone_number)').run();
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

// Local safe logging helpers - only emit verbose SQLITE debugging when DEBUG_SQLITE=true
function _maskSecret(s){ if(!s) return '<none>'; const st=String(s); if(st.length<=6) return st[0]+'***'; return st.slice(0,3)+'...'+st.slice(-3); }
function _sqliteDbg(){ if(process.env.DEBUG_SQLITE!=='true') return; try{ console.debug.apply(console, arguments); }catch(e){} }

function validateLogin(identifier, password) {
  if (!DB) {
    console.warn('[SQLITE-DBG] validateLogin called but DB not initialized');
    return false;
  }
  const id = String(identifier || '').trim();
  const pw = String(password || '');
  const maskedPw = pw.length > 2 ? pw[0] + '***' + pw[pw.length-1] : '***';
  const isEmail = id.includes('@');
  _sqliteDbg('[SQLITE-DBG] validateLogin input:', { identifier: id, password: maskedPw });
  const row = isEmail
    ? DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(id)
    : DB.prepare('SELECT * FROM users WHERE phone=?').get(id);
  if (!row) {
    _sqliteDbg('[SQLITE-DBG] user not found for', id);
    return false;
  }

  if (row.password_hash) {
    try {
      const ok = bcrypt.compareSync(pw, row.password_hash);
      _sqliteDbg('[SQLITE-DBG] user found, password_hash present, bcrypt.compareSync ->', ok);
      return ok;
    } catch (err) {
      console.warn('[SQLITE-DBG] bcrypt.compareSync error', err && err.message);
      return false;
    }
  }

  // legacy: if password_hash missing, allow plain-text match then migrate
  if (row.password && row.password === pw) {
    _sqliteDbg('[SQLITE-DBG] legacy plaintext password matched; migrating to hash');
    const newHash = hashPassword(pw);
    DB.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, row.id);
    // Remove legacy plaintext to avoid keeping secrets in DB
    try { DB.prepare('UPDATE users SET password=NULL WHERE id=?').run(row.id); } catch(e){}
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
  // IMPORTANT: Do not store plaintext password in the users table for new accounts; keep only password_hash.
  const info = DB.prepare(`INSERT INTO users (email,phone,password_hash,password,firstName,surname,dob,dateCreatedISO,dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(emailNorm, obj.phone || null, hash, null, obj.firstName || null, obj.surname || null, obj.dob || null, dateISO, new Date().toString());
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

function saveTempUnlock(identifier, deviceId, expiry) {
  if (!DB) return false;
  try {
    // Upsert by identifier+deviceId
    const existing = DB.prepare('SELECT id FROM temp_unlocks WHERE identifier=? AND deviceId=?').get(identifier||null, deviceId||null);
    if (existing) {
      DB.prepare('UPDATE temp_unlocks SET expiry=? WHERE id=?').run(expiry, existing.id);
    } else {
      DB.prepare('INSERT INTO temp_unlocks (identifier,deviceId,expiry) VALUES (?, ?, ?)').run(identifier||null, deviceId||null, expiry);
    }
    return true;
  } catch (err) {
    console.warn('[SQLITE-SAVE-TEMP-UNLOCK-ERR]', err && err.message);
    return false;
  }
}

function loadTempUnlocks() {
  if (!DB) return [];
  try {
    // Return id as well for administrative operations
    const rows = DB.prepare('SELECT id, identifier, deviceId, expiry FROM temp_unlocks').all();
    return rows || [];
  } catch (err) {
    console.warn('[SQLITE-LOAD-TEMP-UNLOCKS-ERR]', err && err.message);
    return [];
  }
}

function deleteTempUnlockById(id) {
  if (!DB) return false;
  try {
    const res = DB.prepare('DELETE FROM temp_unlocks WHERE id=?').run(id);
    return (res.changes || 0) > 0;
  } catch (err) {
    console.warn('[SQLITE-DELETE-TEMP-UNLOCK-ERR]', err && err.message);
    return false;
  }
}

function deleteTempUnlock(identifier, deviceId) {
  if (!DB) return 0;
  try {
    const res = DB.prepare('DELETE FROM temp_unlocks WHERE identifier=? AND deviceId=?').run(identifier||null, deviceId||null);
    return res.changes || 0;
  } catch (err) {
    console.warn('[SQLITE-DELETE-TEMP-UNLOCKS-ERR]', err && err.message);
    return 0;
  }
}

function removeExpiredTempUnlocks(now) {
  if (!DB) return 0;
  try {
    const res = DB.prepare('DELETE FROM temp_unlocks WHERE expiry<?').run(now || Date.now());
    return res.changes || 0;
  } catch (err) {
    console.warn('[SQLITE-REMOVE-EXPIRED-TEMP-UNLOCKS-ERR]', err && err.message);
    return 0;
  }
}

// Data-tracking helpers
function getPurchasesByPhone(phoneNumber) {
  if (!DB) return [];
  try {
    return DB.prepare('SELECT id, phone_number as phoneNumber, data_amount as dataAmount, bundle_type as bundleType, video_count as videoCount, timestamp, purchase_type as purchaseType FROM purchases WHERE phone_number=? ORDER BY id DESC').all(phoneNumber||null);
  } catch (err) { console.warn('[SQLITE-GET-PURCHASES-ERR]', err && err.message); return []; }
}

function getUsageByPhone(phoneNumber) {
  if (!DB) return [];
  try {
    return DB.prepare('SELECT id, phone_number as phoneNumber, data_used as dataUsed, description, timestamp, session_id as sessionId FROM usage WHERE phone_number=? ORDER BY id DESC').all(phoneNumber||null);
  } catch (err) { console.warn('[SQLITE-GET-USAGE-ERR]', err && err.message); return []; }
}

function addUsageRecord(phoneNumber, dataUsed, description, sessionId) {
  if (!DB) return false;
  try {
    DB.prepare('INSERT INTO usage (phone_number, data_used, description, timestamp, session_id) VALUES (?, ?, ?, ?, ?)')
      .run(phoneNumber||null, Number(dataUsed)||0, description||'', new Date().toISOString(), sessionId||null);
    return true;
  } catch (err) { console.warn('[SQLITE-ADD-USAGE-ERR]', err && err.message); return false; }
}

function createPurchaseIfNotExists(phoneNumber, videoCount, bundleMB, bundleType) {
  if (!DB) return false;
  try {
    const exists = DB.prepare('SELECT id FROM purchases WHERE phone_number=? AND bundle_type=? AND video_count=?').get(phoneNumber||null, bundleType||null, Number(videoCount)||0);
    if (exists) return false;
    DB.prepare('INSERT INTO purchases (phone_number, data_amount, bundle_type, video_count, timestamp, purchase_type) VALUES (?, ?, ?, ?, ?, ?)')
      .run(phoneNumber||null, Number(bundleMB)||0, bundleType||null, Number(videoCount)||0, new Date().toISOString(), 'video_reward');
    return true;
  } catch (err) { console.warn('[SQLITE-CREATE-PURCHASE-ERR]', err && err.message); return false; }
}

module.exports = {
  init,
  validateLogin,
  findUser,
  changePassword,
  createUser,
  appendAccessEvent,
  saveTempUnlock,
  loadTempUnlocks,
  removeExpiredTempUnlocks,
  deleteTempUnlockById,
  deleteTempUnlock,
  getPurchasesByPhone,
  getUsageByPhone,
  addUsageRecord,
  createPurchaseIfNotExists,
  _db: () => DB
};

