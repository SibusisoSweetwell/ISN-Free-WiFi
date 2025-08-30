const http = require('http');
const fs = require('fs');

// Simple programmatic verifier to avoid PowerShell interactive issues.
// Posts a grant for 5 videos -> 100MB then checks access.

const SERVER_HOST = process.env.VERIFY_HOST || '127.0.0.1';
const SERVER_PORT = process.env.VERIFY_PORT || 3150;

function post(path, data, headers={}, cb){
  const postData = JSON.stringify(data);
  const options = {
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    path,
    method: 'POST',
    headers: Object.assign({ 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(postData) }, headers)
  };
  const req = http.request(options, res=>{
    let body='';
    res.on('data', c=> body+=c);
    res.on('end', ()=> cb(null, res.statusCode, body));
  });
  req.on('error', e=> cb(e));
  req.write(postData);
  req.end();
}

function get(path, headers={}, cb){
  const options = { hostname: SERVER_HOST, port: SERVER_PORT, path, method: 'GET', headers };
  const req = http.request(options, res=>{
    let body='';
    res.on('data', c=> body+=c);
    res.on('end', ()=> cb(null, res.statusCode, body));
  });
  req.on('error', e=> cb(e));
  req.end();
}

// Use a stable device fingerprint: User-Agent + X-Router-Id
const UA = 'programmatic-verifier/1.0';
const ROUTER = 'verifier-router-12345';
const headers = { 'User-Agent': UA, 'X-Router-Id': ROUTER };

const grantPayload = {
  identifier: '0796694562',
  deviceId: 'dev-verifier-1',
  videosCompleted: 5,
  bundleMB: 100,
  source: 'verifier'
};

console.log('Posting grant...');
post('/api/bundle/grant', grantPayload, headers, (err, status, body) => {
  if(err) return console.error('Grant POST failed', err.message);
  console.log('Grant status', status);
  try { fs.writeFileSync('grant_result.json', JSON.stringify({ status, body: JSON.parse(body) }, null, 2)); } catch(e){ fs.writeFileSync('grant_result.json', JSON.stringify({ status, body }, null, 2)); }

  // Now check access
  setTimeout(()=>{
    get('/api/access/check', headers, (gerr, gstatus, gbody)=>{
      if(gerr) return console.error('Access GET failed', gerr.message);
      console.log('Access status', gstatus);
      try { fs.writeFileSync('access_result.json', JSON.stringify({ status: gstatus, body: JSON.parse(gbody) }, null, 2)); } catch(e){ fs.writeFileSync('access_result.json', JSON.stringify({ status: gstatus, body: gbody }, null, 2)); }
      console.log('Wrote grant_result.json and access_result.json');
    });
  }, 500);
});
