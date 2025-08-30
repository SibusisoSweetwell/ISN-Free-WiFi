const http = require('http');

function postGrant(cb){
  const data = JSON.stringify({
    identifier: 'joseph@gmail.com',
    bundleMB: 100,
    routerId: 'test-router',
    source: 'manual-test',
    totalWatchTime: 60,
    videosCompleted: 5
  });

  const opts = {
    hostname: '127.0.0.1',
    port: 3150,
    path: '/api/bundle/grant',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Router-Id': 'test-router'
    }
  };

  const req = http.request(opts, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('\n--- BUNDLE GRANT RESPONSE ---');
      console.log('STATUS', res.statusCode);
      try { console.log(JSON.parse(body)); }
      catch(e){ console.log(body); }
      cb();
    });
  });
  req.on('error', (err) => { console.error('ERROR', err.message); cb(); });
  req.write(data);
  req.end();
}

function checkAccess(){
  const path = '/api/access/check?identifier=' + encodeURIComponent('joseph@gmail.com');
  const opts = {
    hostname: '127.0.0.1',
    port: 3150,
    path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Router-Id': 'test-router'
    }
  };

  const req = http.request(opts, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('\n--- ACCESS CHECK RESPONSE ---');
      console.log('STATUS', res.statusCode);
      try { console.log(JSON.parse(body)); }
      catch(e){ console.log(body); }
    });
  });
  req.on('error', (err) => { console.error('ERROR', err.message); });
  req.end();
}

postGrant(checkAccess);
