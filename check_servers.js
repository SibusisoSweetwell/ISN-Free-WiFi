const http = require('http');
const options = [
  { host: '127.0.0.1', port: 3150, path: '/home.html', name: 'portal home' },
  { host: '127.0.0.1', port: 3150, path: '/proxy.pac', name: 'proxy pac' }
];

function check(opt){
  return new Promise((resolve)=>{
    const req = http.request({ hostname: opt.host, port: opt.port, path: opt.path, method: 'GET', timeout: 2000 }, res=>{
      resolve({ name: opt.name, status: res.statusCode });
    });
    req.on('error', e=> resolve({ name: opt.name, error: e.message }));
    req.on('timeout', ()=> { req.destroy(); resolve({ name: opt.name, error: 'timeout' }); });
    req.end();
  });
}

(async ()=>{
  for(const o of options){
    const r = await check(o);
    console.log(r);
  }
})();
