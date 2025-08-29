const Database = require('better-sqlite3');
const path = require('path');
try {
  const dbPath = path.join(__dirname, '..', 'data.sqlite');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, identifier, deviceId, expiry FROM temp_unlocks').all();
  console.log(JSON.stringify(rows, null, 2));
} catch (e) {
  console.error('ERR', e && e.message);
  process.exit(2);
}
