// Small helper to inspect purchases in data.sqlite for a given identifier/phone
const path = require('path');
const args = process.argv.slice(2);
const id = (args[0] || 'theuseridentifier').toString().trim();
const dbModule = require('./sqlite-db');

const dbPath = path.join(__dirname, 'data.sqlite');
if (!dbModule.init(dbPath)) {
  console.error('[CHECK-SQLITE] Failed to open sqlite DB at', dbPath);
  process.exit(2);
}

const rows = dbModule.getPurchasesByPhone(id);
console.log(JSON.stringify({ identifier: id, count: rows.length, purchases: rows }, null, 2));
process.exit(0);
