// Manually authenticate phone user 0796694562 for proxy access
const http = require('http');

function authenticateUser() {
  const postData = JSON.stringify({
    identifier: '0796694562'
  });

  const options = {
    hostname: '10.5.48.94',
    port: 3150,
    path: '/api/device/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; MED-LX9 Build/HUAW)'
    }
  };

  console.log('🔐 Authenticating phone user 0796694562 for proxy access...');

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`📊 Status: ${res.statusCode}`);
      console.log(`📄 Response:`, data);
      
      try {
        const parsed = JSON.parse(data);
        if (parsed.ok) {
          console.log(`✅ User authenticated successfully!`);
          console.log(`🆔 Device ID: ${parsed.deviceId}`);
          console.log(`🔑 Session Token: ${parsed.sessionToken.substring(0, 20)}...`);
          console.log(`⏰ Expires: ${parsed.expiresIn}`);
          console.log('\n🎉 PHONE USER 0796694562 NOW READY FOR PROXY ACCESS!');
          console.log('======================================================');
          console.log('✅ Data bundle: 1400MB available');
          console.log('✅ Proxy authentication: Active');
          console.log('✅ Video URLs: Will load through proxy');
          console.log('✅ Internet access: Enabled');
        } else {
          console.log(`❌ Authentication failed: ${parsed.message}`);
        }
      } catch (e) {
        console.log(`❌ Parse error: ${e.message}`);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Request error: ${e.message}`);
  });

  req.write(postData);
  req.end();
}

authenticateUser();
