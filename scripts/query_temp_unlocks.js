const Database = require('better-sqlite3');
const db = new Database('./data.sqlite');
const rows = db.prepare('SELECT id, identifier, deviceId, expiry FROM temp_unlocks').all();
console.log('found', rows.length, 'rows');
rows.forEach(r=> console.log(r));
