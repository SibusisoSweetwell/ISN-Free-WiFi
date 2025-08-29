// EMERGENCY DEVICE UNBLOCK - User 0796694562
// ============================================

const http = require('http');

const USER_ID = '0796694562';
const DEVICE_ID = 'c21f969b'; // From the error message
const PROXY_HOST = '10.5.48.94';
const PORTAL_PORT = 3150;

console.log('🚨 EMERGENCY DEVICE UNBLOCK');
console.log('===========================');
console.log(`Unblocking device ${DEVICE_ID}... for user ${USER_ID}`);
console.log('');

// Step 1: Check user's video status
function checkUserVideos() {
  console.log('📹 Step 1: Checking user video status...');
  
  const options = {
    hostname: PROXY_HOST,
    port: PORTAL_PORT,
    path: `/api/me/usage?identifier=${USER_ID}`,
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const usage = JSON.parse(data);
        console.log('User Status:', {
          videosWatched: usage.videosWatched || 0,
          totalDataMB: usage.totalDataMB || 0,
          bundles: usage.bundles?.length || 0,
          videoEarnedMB: usage.videoEarnedMB || 0
        });
        
        if ((usage.videosWatched || 0) >= 5 || (usage.bundles || []).length > 0) {
          console.log('✅ User qualifies for access - proceeding with unblock');
          setTimeout(manualUnblock, 1000);
        } else {
          console.log('❌ User needs to watch more videos first');
          setTimeout(manualUnblock, 1000); // Try anyway
        }
      } catch (err) {
        console.log('❌ Failed to parse status, proceeding anyway');
        setTimeout(manualUnblock, 1000);
      }
    });
  });

  req.on('error', (err) => {
    console.log('❌ Status check failed:', err.message);
    setTimeout(manualUnblock, 1000);
  });

  req.end();
}

// Step 2: Manual device unblock via API
function manualUnblock() {
  console.log('');
  console.log('🔓 Step 2: Manually unblocking device...');
  
  const postData = JSON.stringify({
    action: 'unblock_device',
    identifier: USER_ID,
    deviceId: DEVICE_ID,
    reason: 'Emergency unblock - user has video access'
  });
  
  const options = {
    hostname: PROXY_HOST,
    port: PORTAL_PORT,
    path: '/api/admin/device-unblock',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`Unblock Status: ${res.statusCode}`);
      if (res.statusCode === 404) {
        console.log('⚠️  Unblock endpoint not found - trying refresh instead');
        setTimeout(refreshAccess, 1000);
      } else {
        try {
          const result = JSON.parse(data);
          console.log('Unblock Result:', result);
        } catch (err) {
          console.log('Response:', data);
        }
        setTimeout(testAccess, 2000);
      }
    });
  });

  req.on('error', (err) => {
    console.log('❌ Manual unblock failed:', err.message);
    setTimeout(refreshAccess, 1000);
  });

  req.write(postData);
  req.end();
}

// Step 3: Refresh user access as fallback
function refreshAccess() {
  console.log('');
  console.log('🔄 Step 3: Refreshing user access...');
  
  const postData = JSON.stringify({ identifier: USER_ID });
  
  const options = {
    hostname: PROXY_HOST,
    port: PORTAL_PORT,
    path: '/api/refresh-access',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`Refresh Status: ${res.statusCode}`);
      try {
        const result = JSON.parse(data);
        console.log('Refresh Result:', result);
      } catch (err) {
        console.log('Response:', data);
      }
      setTimeout(testAccess, 2000);
    });
  });

  req.on('error', (err) => {
    console.log('❌ Refresh failed:', err.message);
    setTimeout(testAccess, 2000);
  });

  req.write(postData);
  req.end();
}

// Step 4: Test internet access
function testAccess() {
  console.log('');
  console.log('🌐 Step 4: Testing internet access...');
  
  const options = {
    hostname: PROXY_HOST,
    port: 8082,
    path: 'http://httpbin.org/ip',
    method: 'GET',
    headers: {
      'Host': 'httpbin.org',
      'Cookie': `portal_token=${USER_ID}`,
      'User-Agent': 'EmergencyUnblockTest/1.0'
    }
  };

  const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
    
    if (res.statusCode === 200) {
      console.log('✅ SUCCESS! Device unblocked - internet access working!');
    } else if (res.statusCode === 302) {
      console.log('❌ Still blocked - may need server restart or manual intervention');
    } else {
      console.log('⚠️  Unexpected response');
    }
    
    res.on('data', () => {}); // Consume response
    res.on('end', () => {
      console.log('');
      console.log('🏁 Emergency unblock complete');
      console.log('');
      if (res.statusCode !== 200) {
        console.log('💡 ADDITIONAL TROUBLESHOOTING STEPS:');
        console.log('1. Check server logs for [DEVICE-BLOCKED] messages');
        console.log('2. Verify user has watched 5+ videos');
        console.log('3. Check if MAC address resolution is working');
        console.log('4. Consider restarting the server to clear device blocks');
        console.log('5. Check if device isolation is too strict');
      }
    });
  });

  req.on('error', (err) => {
    console.log('❌ Test failed:', err.message);
  });

  req.setTimeout(5000, () => {
    console.log('⏰ Test timeout');
    req.destroy();
  });

  req.end();
}

// Start the emergency unblock process
console.log('🚀 Starting emergency device unblock...');
checkUserVideos();
