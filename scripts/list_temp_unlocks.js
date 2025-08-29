const db = require('../sqlite-db');
const path = require('path');
(function(){
  const dbPath = path.join(__dirname, '..', 'data.sqlite');
  if(!db.init(dbPath)){
    console.error('DB init failed'); process.exit(2);
  }
  const rows = db.loadTempUnlocks();
  console.log('TEMP_UNLOCKS:', JSON.stringify(rows, null, 2));
})();
