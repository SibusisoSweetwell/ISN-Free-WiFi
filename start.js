// start.js - seed DB if needed then start server
const fs = require('fs');
const path = require('path');

const dbFile = process.env.SQLITE_PATH || path.join(__dirname, 'logins.db');

function dbExistsAndNonEmpty(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const stats = fs.statSync(file);
    return stats.size > 0;
  } catch (err) {
    return false;
  }
}

(async function(){
  try {
    if (!dbExistsAndNonEmpty(dbFile)) {
      console.log('[start] DB missing or empty. Running seed script...');
      // Run the seed script (it uses sqlite-db internally)
      await require('./scripts/seed_logins_db');
      console.log('[start] Seed complete');
    } else {
      console.log('[start] DB exists, skipping seed');
    }
  } catch (err) {
    console.warn('[start] Seed step failed:', err && err.message);
    // Continue to start server even if seeding fails
  }

  // Finally start the server
  require('./server');
})();
