const http = require('http');
const fs = require('fs');

function postGrant(){
  return new Promise((resolve, reject) => {
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
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          fs.writeFileSync('grant_result.json', JSON.stringify(parsed, null, 2));
          resolve(parsed);
        } catch(e){ fs.writeFileSync('grant_result.json', body); resolve({ raw: body }); }
      });
    });
    req.on('error', err => { reject(err); });
    req.write(data);
    req.end();
  });
}

function getAccess(){
  return new Promise((resolve, reject) => {
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
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          fs.writeFileSync('access_result.json', JSON.stringify(parsed, null, 2));
          resolve(parsed);
        } catch(e){ fs.writeFileSync('access_result.json', body); resolve({ raw: body }); }
      });
    });
    req.on('error', err => { reject(err); });
    req.end();
  });
}

(async ()=>{
  try{
    console.log('Posting grant...');
    const g = await postGrant();
    console.log('Grant saved to grant_result.json');
    console.log('Grant response summary:', (g && g.ok) ? 'ok:true' : 'ok:false');

    console.log('Checking access...');
    const a = await getAccess();
    console.log('Access saved to access_result.json');
    console.log('Access summary:', a && a.ok ? 'ok:true' : 'ok:false');

    // Also capture recent server.log lines referencing tempFullAccess/deviceQuotas
    try{
      const logs = fs.readFileSync('server.log','utf8').split('\n').slice(-200).join('\n');
      fs.writeFileSync('server_recent.log', logs);
      console.log('Saved server_recent.log (last 200 lines)');
    }catch(e){ console.warn('Could not read server.log', e.message); }

  }catch(e){
    console.error('ERROR', e && e.message);
    process.exit(2);
  }
})();
