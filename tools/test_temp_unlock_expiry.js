const path = require('path');
const fs = require('fs');
const sqlite = require('../sqlite-db');

// Test: temp-unlock expiry simulation
(async ()=>{
  const dbFile = path.join(__dirname, 'test_temp_unlock.db');
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch(e){}
  console.log('Init DB:', dbFile);
  sqlite.init(dbFile);
  const DB = sqlite._db();

  // Create a temp unlock that expires in 3 seconds
  const routerId = 'test-router-1';
  const deviceFingerprint = 'fp-1';
  const expiresAt = Date.now() + 3000; // 3s
  const createdAt = Date.now();

  const insert = DB.prepare('INSERT INTO temp_unlocks (routerId,deviceFingerprint,reason,expiresAt,createdAt) VALUES (?,?,?,?,?)');
  const info = insert.run(routerId, deviceFingerprint, 'test-expiry', expiresAt, createdAt);
  console.log('Inserted temp_unlock id=', info.lastInsertRowid, 'expiresAt(ms)=', expiresAt);

  // Load unlocks - should find it
  let list = sqlite.loadTempUnlocks(routerId);
  console.log('Loaded unlocks count (should be 1):', list.filter(u=>u.deviceFingerprint===deviceFingerprint).length);

  // Wait 4 seconds then run cleanup
  await new Promise(r=>setTimeout(r, 4000));
  console.log('Running removeExpiredTempUnlocks...');
  sqlite.removeExpiredTempUnlocks();

  list = sqlite.loadTempUnlocks(routerId);
  const stillThere = list.some(u=>u.deviceFingerprint===deviceFingerprint);
  console.log('Unlock still present after expiry (should be false):', stillThere);

  if (!stillThere) {
  console.log('\u2705 Temp-unlock expiry test PASSED');
  fs.writeFileSync(path.join(__dirname,'test_temp_unlock_expiry.result.json'), JSON.stringify({ok:true}), 'utf8');
  process.exit(0);
  } else {
  console.error('\u274c Temp-unlock expiry test FAILED');
  fs.writeFileSync(path.join(__dirname,'test_temp_unlock_expiry.result.json'), JSON.stringify({ok:false,list}), 'utf8');
  process.exit(2);
  }
})();
