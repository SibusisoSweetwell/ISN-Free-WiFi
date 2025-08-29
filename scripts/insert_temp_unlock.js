const db = require('../sqlite-db');
const path = require('path');
(async function(){
  const dbPath = path.join(__dirname, '..', 'data.sqlite');
  const ok = db.init(dbPath);
  if(!ok){
    console.error('DB init failed'); process.exit(2);
  }
  const expiry = Date.now() + (2*60*60*1000);
  const saved = db.saveTempUnlock('test@example.com', 'dev-abcdef1234', expiry);
  console.log('saveTempUnlock ->', saved);
  const rows = db.loadTempUnlocks();
  console.log('temp_unlocks rows:', rows);
})();
