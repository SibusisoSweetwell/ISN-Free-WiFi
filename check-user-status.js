// Check current status of phone user 0796694562
const http = require('http');

function checkUserStatus() {
  const options = {
    hostname: '10.5.48.94',
    port: 3150,
    path: '/api/admin/overview',
    method: 'GET',
    headers: {
      'User-Agent': 'StatusChecker'
    }
  };

  console.log('Checking current status of phone user 0796694562...');

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        
        // Find the phone user
        const phoneUser = parsed.users.find(u => u.identifier === '0796694562');
        
        if (phoneUser) {
          console.log('\n📱 PHONE USER 0796694562 STATUS:');
          console.log('================================');
          console.log(`📹 Videos Watched: ${phoneUser.videosWatched || 0}`);
          console.log(`🎯 Earned from Videos: ${phoneUser.videoEarnedMB || 0}MB`);
          console.log(`💰 Purchased Bundles: ${phoneUser.purchasedMB || 0}MB`);
          console.log(`📊 Total Available: ${phoneUser.totalBundleMB || 0}MB`);
          console.log(`📉 Data Used: ${phoneUser.usedMB || 0}MB`);
          console.log(`📋 Remaining: ${phoneUser.remainingMB || 0}MB`);
          console.log(`✅ Authenticated: ${phoneUser.authenticated || false}`);
          console.log(`🔗 Has Access: ${phoneUser.hasAccess || false}`);
          
          if (phoneUser.remainingMB > 0) {
            console.log('\n✅ USER HAS DATA! Issue might be with proxy access.');
          } else {
            console.log('\n❌ USER HAS NO DATA! Video bundles not created properly.');
          }
          
        } else {
          console.log('\n❌ Phone user 0796694562 not found in admin overview');
        }
        
      } catch (e) {
        console.log('❌ Parse Error:', e.message);
        console.log('📄 Raw Response:', data.substring(0, 500));
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Request Error:', e.message);
  });

  req.end();
}

checkUserStatus();
