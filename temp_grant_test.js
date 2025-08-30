const http = require('http');
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
    'Content-Length': Buffer.byteLength(data)
  },
  timeout: 7000
};

const req = http.request(opts, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    try { console.log('BODY', JSON.parse(body)); }
    catch(e){ console.log('BODY', body); }
  });
});
req.on('error', (err) => { console.error('ERROR', err.message); });
req.write(data);
req.end();
