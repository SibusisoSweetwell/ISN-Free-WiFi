const sqliteDB = require('../sqlite-db');
const path = require('path');
(async ()=>{
  const dbPath = path.join(__dirname, '..', 'data.sqlite');
  console.log('Initializing DB at', dbPath);
  const ok = sqliteDB.init(dbPath);
  if(!ok){ console.error('DB init failed'); process.exit(2); }
  const now = Date.now();
  const expiry = now + (2*60*60*1000); // 2 hours
  console.log('Saving temp unlock for e2e-test@example.com / device-e2e-1 expiry=', new Date(expiry).toISOString());
  const saved = sqliteDB.saveTempUnlock('e2e-test@example.com','device-e2e-1', expiry);
  console.log('saved:', saved);
  const rows = sqliteDB.loadTempUnlocks();
  console.log('DB rows:', rows);

  // Simulate server startup loading into memory
  const tempFullAccess = new Map();
  const loaded = [];
  for(const r of rows){
    if(r && r.expiry && Number(r.expiry) > Date.now()){
      if(r.identifier) tempFullAccess.set((r.identifier||'').toLowerCase(), Number(r.expiry));
      if(r.deviceId) tempFullAccess.set(r.deviceId, Number(r.expiry));
      loaded.push(r);
    }
  }
  console.log('Simulated in-memory map entries:');
  for(const [k,v] of tempFullAccess.entries()){
    console.log('  key=',k,'expiry=',new Date(v).toISOString());
  }

  // Now revoke
  console.log('Revoking by identifier+deviceId...');
  const removed = sqliteDB.deleteTempUnlock('e2e-test@example.com','device-e2e-1');
  console.log('removed rows count:', removed);
  console.log('Rows after revoke:', sqliteDB.loadTempUnlocks());
})();
