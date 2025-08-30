const path = require('path');
const fs = require('fs');
const sqlite = require('../sqlite-db');

// Test: legacy plaintext password migration on validateLogin
(async ()=>{
  const dbFile = path.join(__dirname, 'test_migration.db');
  try {
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  } catch(e){}
  console.log('Init DB:', dbFile);
  sqlite.init(dbFile);

  // Insert a legacy user directly with plaintext password using underlying DB handle
  const DB = sqlite._db();
  const email = 'legacy@example.com';
  const plain = 'LegacyPass!23';
  const dateISO = new Date().toISOString();
  const info = DB.prepare('INSERT INTO users (email,phone,password_hash,password,firstName,surname,dob,dateCreatedISO,dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email, null, null, plain, 'Legacy', 'User', null, dateISO, new Date().toString());

  console.log('Inserted legacy user id=', info.lastInsertRowid);

  // Validate login using plaintext - this should trigger migration to password_hash and nullify password
  const ok = sqlite.validateLogin(email, plain);
  console.log('validateLogin returned:', ok);

  const row = DB.prepare('SELECT id,email,password_hash,password FROM users WHERE lower(email)=lower(?)').get(email);
  const hashPresent = !!(row && row.password_hash);
  const plaintextCleared = !(row && row.password);

  console.log('password_hash present:', hashPresent);
  console.log('plaintext password cleared (null):', plaintextCleared);

  if (ok && hashPresent && plaintextCleared) {
  console.log('\u2705 Plaintext migration test PASSED');
  fs.writeFileSync(path.join(__dirname,'test_plaintext_migration.result.json'), JSON.stringify({ok:true}), 'utf8');
  process.exit(0);
  } else {
  console.error('\u274c Plaintext migration test FAILED');
  fs.writeFileSync(path.join(__dirname,'test_plaintext_migration.result.json'), JSON.stringify({ok:false,row}), 'utf8');
  process.exit(2);
  }
})();
