const http = require('http');
const https = require('https');
function get(path){
  return new Promise((resolve,reject)=>{
    const opts = { hostname: '127.0.0.1', port: 3150, path, method: 'GET', headers: {'Accept':'application/json'} };
    const req = http.request(opts, res=>{
      let body=''; res.setEncoding('utf8'); res.on('data',d=>body+=d); res.on('end',()=>resolve({status:res.statusCode, body}));
    });
    req.on('error', reject); req.end();
  });
}
function post(path, obj, headers={}){
  return new Promise((resolve,reject)=>{
    const payload = JSON.stringify(obj);
    const opts = { hostname: '127.0.0.1', port: 3150, path, method: 'POST', headers: Object.assign({'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}, headers) };
    const req = http.request(opts, res=>{ let body=''; res.setEncoding('utf8'); res.on('data',d=>body+=d); res.on('end',()=>resolve({status:res.statusCode, body})); });
    req.on('error', reject); req.write(payload); req.end();
  });
}
(async ()=>{
  try{
    console.log('-> GET /api/ads/playlist');
    const p = await get('/api/ads/playlist?count=3');
    console.log('status', p.status); console.log('body', p.body.substring(0,1000));
  }catch(e){ console.error('GET playlist error', e.message); }

  try{
    console.log('\n-> POST /api/admin/grant');
    const grant = await post('/api/admin/grant', { identifier:'testadmin@example.com', mb:50, durationHours:1 }, { 'x-admin-token': 'admin_secret_dev' });
    console.log('status', grant.status); console.log('body', grant.body.substring(0,1000));
  }catch(e){ console.error('POST grant error', e.message); }

  try{
    console.log('\n-> POST /api/ad/event');
    const ev = await post('/api/ad/event', { adId:'vid_sample', identifier:'testadmin@example.com', eventType:'complete', watchSeconds:60 }, {});
    console.log('status', ev.status); console.log('body', ev.body.substring(0,1000));
  }catch(e){ console.error('POST ad event error', e.message); }
})();
