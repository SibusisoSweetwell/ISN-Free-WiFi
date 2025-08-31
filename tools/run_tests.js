(async()=>{
  const endpoints = [
    { method: 'GET', url: 'http://localhost:3150/api/ads/playlist?count=3' },
    { method: 'POST', url: 'http://localhost:3150/api/admin/grant', body: { identifier: 'testadmin@example.com', mb: 50, durationHours: 1 }, headers: { 'x-admin-token': 'admin_secret_dev' } },
    { method: 'GET', url: 'http://localhost:3150/api/admin/temp-access', headers: { 'x-admin-token': 'admin_secret_dev' } },
    { method: 'POST', url: 'http://localhost:3150/api/ad/event', body: { identifier: 'testadmin@example.com', deviceId: 'test-device-1', eventType: 'complete', watchSeconds: 31 } }
  ];

  for (const ep of endpoints) {
    try {
      const opts = { method: ep.method, headers: Object.assign({ 'Content-Type': 'application/json' }, ep.headers || {}) };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      console.log('\n--- Request:', ep.method, ep.url);
      const resp = await fetch(ep.url, opts);
      const text = await resp.text();
      console.log('Status:', resp.status, resp.statusText);
      try { console.log('Body:', JSON.parse(text)); } catch(e){ console.log('Body(Text):', text); }
    } catch (err) {
      console.error('Request error for', ep.url, err && err.message);
    }
  }
})();
