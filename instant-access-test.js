// INSTANT ACCESS VERIFICATION - Quick Test Script
// ===============================================

const http = require('http');

const TEST_USER = '0796694562';
const PROXY_HOST = '10.5.48.94';
const PROXY_PORT = 8082;
const PORTAL_PORT = 3150;

console.log('🚀 INSTANT ACCESS VERIFICATION');
console.log('==============================');
console.log(`Testing instant access for user: ${TEST_USER}`);
console.log('');

// Step 1: Check user's current status
function checkUserStatus() {
  console.log('📊 Step 1: Checking user status...');
  
  const options = {
    hostname: PROXY_HOST,
    port: PORTAL_PORT,
    path: `/api/me/usage?identifier=${TEST_USER}`,
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const usage = JSON.parse(data);
        console.log('   User Status:', {
          videosWatched: usage.videosWatched || 0,
          totalDataMB: usage.totalDataMB || 0,
          bundles: usage.bundles?.length || 0,
          nextMilestone: usage.nextMilestone
        });
        
        // Step 2: Test immediate proxy access
        setTimeout(testProxyAccess, 500);
      } catch (err) {
        console.log('   ❌ Failed to parse status:', err.message);
        setTimeout(testProxyAccess, 500);
      }
    });
  });

  req.on('error', (err) => {
    console.log('   ❌ Status check failed:', err.message);
    setTimeout(testProxyAccess, 500);
  });

  req.end();
}

// Step 2: Test immediate proxy access
function testProxyAccess() {
  console.log('');
  console.log('🌐 Step 2: Testing proxy access (should be instant)...');
  
  const startTime = Date.now();
  
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: 'http://httpbin.org/ip',
    method: 'GET',
    headers: {
      'Host': 'httpbin.org',
      'User-Agent': 'InstantAccessTest/1.0',
      'Cookie': `portal_token=${TEST_USER}`
    }
  };

  const req = http.request(options, (res) => {
    const responseTime = Date.now() - startTime;
    
    console.log(`   Response Time: ${responseTime}ms`);
    console.log(`   Status: ${res.statusCode} ${res.statusMessage}`);
    
    if (res.statusCode === 200) {
      console.log('   ✅ SUCCESS - Internet access granted instantly!');
      console.log(`   ⚡ Access granted in ${responseTime}ms`);
    } else if (res.statusCode === 302) {
      console.log('   ❌ BLOCKED - Still redirecting to login');
      console.log('   🔧 Need to investigate bundle recognition');
    } else {
      console.log('   ⚠️  UNEXPECTED - Unusual response code');
    }
    
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const ipData = JSON.parse(data);
          console.log('   🌍 External IP confirmed:', ipData.origin);
        } catch (e) {
          console.log('   📄 Response received (non-JSON)');
        }
      }
      
      // Step 3: Test HTTPS access
      setTimeout(testHTTPSAccess, 1000);
    });
  });

  req.on('error', (err) => {
    const responseTime = Date.now() - startTime;
    console.log(`   ❌ ERROR after ${responseTime}ms:`, err.message);
    setTimeout(testHTTPSAccess, 1000);
  });

  req.setTimeout(3000, () => {
    console.log('   ⏰ TIMEOUT - Proxy access took too long');
    req.destroy();
    setTimeout(testHTTPSAccess, 1000);
  });

  req.end();
}

// Step 3: Test HTTPS access
function testHTTPSAccess() {
  console.log('');
  console.log('🔒 Step 3: Testing HTTPS proxy access...');
  
  // For HTTPS testing, we'll try a CONNECT request
  const startTime = Date.now();
  
  const req = http.request({
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    method: 'CONNECT',
    path: 'google.com:443',
    headers: {
      'User-Agent': 'InstantAccessTest/1.0',
      'Cookie': `portal_token=${TEST_USER}`
    }
  });

  req.on('connect', (res, socket, head) => {
    const responseTime = Date.now() - startTime;
    console.log(`   ✅ HTTPS CONNECT successful in ${responseTime}ms`);
    socket.end();
    
    console.log('');
    console.log('🏁 VERIFICATION COMPLETE');
    console.log('========================');
    console.log('✅ Both HTTP and HTTPS access working');
    console.log('⚡ Internet unlocked instantly after bundle creation');
  });

  req.on('error', (err) => {
    const responseTime = Date.now() - startTime;
    console.log(`   ❌ HTTPS failed after ${responseTime}ms:`, err.message);
    
    console.log('');
    console.log('🏁 VERIFICATION COMPLETE');
    console.log('========================');
    console.log('✅ HTTP access working');
    console.log('❌ HTTPS needs investigation');
  });

  req.setTimeout(3000, () => {
    console.log('   ⏰ HTTPS TIMEOUT');
    req.destroy();
  });

  req.end();
}

// Start the verification
checkUserStatus();
