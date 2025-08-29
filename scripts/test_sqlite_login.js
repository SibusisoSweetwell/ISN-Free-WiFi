const path = require('path');
const fs = require('fs');
const http = require('http');

(async function(){
  try {
    // Ensure DB exists and create test user
    const sqlite = require('../sqlite-db');
    const dbFile = path.join(__dirname, 'test_data.sqlite');
    if(fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    sqlite.init(dbFile);
    // Create test user
    const res = sqlite.createUser({ email: 'testuser@example.com', phone: '0812345678', password: 'TestPass123', firstName: 'Test', surname: 'User' });
    console.log('Created user', res);

    // Attempt login via HTTP to local server using native http
    const postData = JSON.stringify({ email: 'testuser@example.com', password: 'TestPass123' });
    const req = http.request({ hostname: 'localhost', port: 3150, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk.toString());
      res.on('end', () => {
        try {
          console.log('Login response:', JSON.parse(body));
          process.exit(0);
        } catch(e) { console.log('Login response (raw):', body); process.exit(0); }
      });
    });
    req.on('error', err => { console.error('Request error', err.message); process.exit(1); });
    req.write(postData);
    req.end();
  } catch (err) {
    console.error('Test failed', err.message || err);
    process.exit(1);
  }
})();
