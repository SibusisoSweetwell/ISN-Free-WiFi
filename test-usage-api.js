// Test the My Usage API for phone user 0796694562
const http = require('http');

function testUsageAPI() {
  const options = {
    hostname: '10.5.48.94',
    port: 3150,
    path: '/api/me/usage?identifier=0796694562',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; MED-LX9 Build/HUAW)',
      'X-Router-ID': 'default-router'
    }
  };

  console.log('🔍 Testing "My Usage" API for phone user 0796694562...');
  console.log('This should show why user sees 0MB in portal');

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`📊 Status: ${res.statusCode}`);
      
      try {
        const parsed = JSON.parse(data);
        
        if (parsed.ok) {
          console.log('\n📱 MY USAGE API RESPONSE:');
          console.log('==========================');
          console.log(`📊 Total Bundles: ${parsed.totalBundleMB}MB`);
          console.log(`📉 Used: ${parsed.totalUsedMB}MB`);
          console.log(`📋 Remaining: ${parsed.remainingMB}MB`);
          console.log(`📹 Videos Watched: ${parsed.videosWatched}`);
          console.log(`🎯 Video Earned: ${parsed.videoEarnedMB}MB`);
          console.log(`🆔 Device ID: ${parsed.deviceId}`);
          console.log(`📦 Device Bundles Found: ${parsed.purchases.length}`);
          
          if (parsed.purchases.length > 0) {
            console.log('\n🎁 FOUND BUNDLES:');
            parsed.purchases.forEach((bundle, i) => {
              console.log(`  ${i+1}. ${bundle.bundleMB}MB (used: ${bundle.usedMB}MB, remaining: ${bundle.bundleMB - bundle.usedMB}MB)`);
              console.log(`     Device: ${bundle.deviceId}, Granted: ${bundle.grantedAtISO}`);
            });
          } else {
            console.log('\n❌ NO BUNDLES FOUND FOR THIS DEVICE!');
            console.log('This is why user sees 0MB in portal');
          }
          
          if (parsed.nextMilestone) {
            console.log(`\n🎯 Next Milestone: ${parsed.nextMilestone.needed} more videos for ${parsed.nextMilestone.reward}`);
          }
          
        } else {
          console.log(`❌ API Error: ${parsed.message}`);
        }
        
      } catch (e) {
        console.log('❌ Parse Error:', e.message);
        console.log('📄 Raw Response:', data);
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Request Error:', e.message);
  });

  req.end();
}

testUsageAPI();
