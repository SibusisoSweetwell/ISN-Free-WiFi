const path = require('path');
const fs = require('fs');

(async function(){
  try {
    const sqlite = require('../sqlite-db');
    const dbFile = process.env.SQLITE_PATH || path.join(__dirname, '..', 'logins.db');
    sqlite.init(dbFile);
    console.log('Using DB:', dbFile);
    const users = [
      { email: 'alice@example.com', phone: '0710000001', password: 'Alice@1234', firstName: 'Alice', surname: 'Test' },
      { email: 'bob@example.com', phone: '0710000002', password: 'Bob@1234', firstName: 'Bob', surname: 'Test' }
    ];

    users.forEach(u=>{
      const existing = sqlite.findUser(u.email) || sqlite.findUser(u.phone);
      if (existing) {
        console.log('Skipping existing user', u.email);
      } else {
        const r = sqlite.createUser(u);
        console.log('Inserted user', u.email, r);
      }
    });
    console.log('Seed complete');
  } catch (err) {
    console.error('Seed failed', err.message || err);
    process.exit(1);
  }
})();
