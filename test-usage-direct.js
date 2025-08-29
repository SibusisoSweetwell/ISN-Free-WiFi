// Test the usage API directly with axios or fetch
const http = require('http');

function testUsageAPI() {
  console.log('🔍 Testing Usage API for phone user 0796694562...');
  
  const options = {
    hostname: 'localhost',
    port: 3150,
    path: '/api/me/usage?identifier=0796694562',
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log(`📊 Response Status: ${res.statusCode}`);
      console.log('📄 Response Body:', data);
      
      try {
        const parsed = JSON.parse(data);
        
        if (parsed.ok) {
          console.log('\n✅ SUCCESS! API Response:');
          console.log(`📱 Phone User: ${parsed.identifier || 'Unknown'}`);
          console.log(`📊 Total Bundles: ${parsed.totalBundleMB}MB`);
          console.log(`📉 Total Used: ${parsed.totalUsedMB}MB`);
          console.log(`📋 Remaining: ${parsed.remainingMB}MB`);
          console.log(`📹 Videos Watched: ${parsed.videosWatched}`);
          console.log(`🎁 Bundles Found: ${parsed.purchases ? parsed.purchases.length : 0}`);
          
          if (parsed.remainingMB > 0) {
            console.log('\n🎉 ISSUE FIXED! User now has data available!');
          } else {
            console.log('\n⚠️  User still shows 0MB - issue persists');
          }
        } else {
          console.log(`❌ API Error: ${parsed.message}`);
        }
        
      } catch (e) {
        console.log('❌ JSON Parse Error:', e.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Request Error:', e.message);
  });

  req.end();
}

testUsageAPI();
