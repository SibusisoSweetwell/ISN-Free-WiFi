const http = require('http');
const https = require('https');

// Simple arg parsing (no deps). Usage:
// node admin_health_check.js <token> [--host=hostname] [--port=3150] [--tls] [--target-host=host] [--target-port=443] [--target-tls]
function parseArgs(argv) {
  const out = {
    token: null,
    host: '127.0.0.1',
    port: 3150,
    tls: false,
    targetHost: 'isn-free-wifi.onrender.com',
    targetPort: 443,
    targetTls: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--host=')) out.host = a.split('=')[1];
    else if (a.startsWith('--port=')) out.port = Number(a.split('=')[1]) || out.port;
    else if (a === '--tls' || a === '--https') out.tls = true;
    else if (a.startsWith('--target-host=')) out.targetHost = a.split('=')[1];
    else if (a.startsWith('--target-port=')) out.targetPort = Number(a.split('=')[1]) || out.targetPort;
    else if (a === '--target-tls' || a === '--target-https') out.targetTls = true;
    else if (!a.startsWith('--') && !out.token) out.token = a;
  }
  // allow PORTAL_SECRET env var as fallback for token
  if (!out.token) out.token = process.env.PORTAL_SECRET || null;
  return out;
}

function get(opts) {
  // opts: { hostname, port, path, token, tls }
  return new Promise((resolve, reject) => {
    const mod = opts.tls ? https : http;
    const requestOpts = {
      hostname: opts.hostname || '127.0.0.1',
      port: opts.port || 3150,
      path: opts.path || '/',
      method: 'GET',
      headers: {
        'X-Admin-Token': opts.token || process.env.PORTAL_SECRET || ''
      },
      timeout: 5000
    };
    const req = mod.request(requestOpts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { const j = JSON.parse(b); return resolve({ status: res.statusCode, body: j }); }
        catch(e) { return resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.end();
  });
}

(async function(){
  const args = parseArgs(process.argv.slice(2));
  const token = args.token;
  if(!token) {
    console.error('No admin token provided via arg or PORTAL_SECRET');
    console.error('Usage: node admin_health_check.js <token> [--host=hostname] [--port=PORT] [--tls] [--target-host=host] [--target-port=PORT] [--target-tls]');
    process.exit(1);
  }

  try {
    // check-remote on the target from the portal server
    const checkPath = `/admin/check-remote?host=${encodeURIComponent(args.targetHost)}&port=${encodeURIComponent(args.targetPort)}&tls=${args.targetTls?1:0}`;
    const r1 = await get({ hostname: args.host, port: args.port, path: checkPath, token, tls: args.tls });
    console.log('/admin/check-remote ->', r1.status, r1.body);
    if(!r1.body || r1.body.ok !== true) {
      console.error('check-remote failed');
      process.exit(1);
    }

    const r2 = await get({ hostname: args.host, port: args.port, path: '/admin/metrics', token, tls: args.tls });
    console.log('/admin/metrics ->', r2.status, r2.body);
    if(!r2.body || typeof r2.body.totalUsers === 'undefined') {
      console.error('metrics failed');
      process.exit(1);
    }

    console.log('Health checks OK');
    process.exit(0);
  } catch (err) {
    console.error('Health check error', err && err.message);
    process.exit(1);
  }
})();
