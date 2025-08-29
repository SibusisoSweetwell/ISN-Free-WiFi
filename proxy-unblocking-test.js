// PROXY UNBLOCKING VERIFICATION - Video Access Test
// ==================================================

const http = require('http');
const https = require('https');

// Test Configuration
const PROXY_HOST = '10.5.48.94';  // Your proxy server
const PROXY_PORT = 8082;          // HTTP proxy port
const TEST_IDENTIFIER = '0796694562'; // Test user who should have video access

console.log('🔍 PROXY UNBLOCKING VERIFICATION SCRIPT');
console.log('==========================================');
console.log(`Testing user: ${TEST_IDENTIFIER}`);
console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
console.log('');

// Function to test HTTP access through proxy
function testHTTPAccess(testUrl, callback) {
  console.log(`📡 Testing HTTP access to: ${testUrl}`);
  
  const url = new URL(testUrl);
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: testUrl,
    method: 'GET',
    headers: {
      'Host': url.hostname,
      'User-Agent': 'VideoAccessTest/1.0',
      'Cookie': `portal_token=test_token_${TEST_IDENTIFIER}`,
      'X-Router-ID': 'router-1'
    }
  };

  const req = http.request(options, (res) => {
    console.log(`   Status: ${res.statusCode} ${res.statusMessage}`);
    console.log(`   Headers:`, res.headers);
    
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('   ✅ SUCCESS - Request allowed through proxy');
      } else if (res.statusCode === 302) {
        console.log('   ❌ BLOCKED - Redirected to:', res.headers.location);
      } else {
        console.log('   ⚠️  UNEXPECTED - Status not 200 or 302');
      }
      console.log('');
      callback();
    });
  });

  req.on('error', (err) => {
    console.log('   ❌ ERROR:', err.message);
    console.log('');
    callback();
  });

  req.setTimeout(5000, () => {
    console.log('   ⏰ TIMEOUT - Request took too long');
    req.destroy();
    callback();
  });

  req.end();
}

// Function to check video access status
function checkVideoAccessStatus() {
  console.log('🎬 CHECKING VIDEO ACCESS STATUS');
  console.log('================================');
  
  const options = {
    hostname: PROXY_HOST,
    port: 3150, // Portal port
    path: `/api/me/usage?identifier=${TEST_IDENTIFIER}`,
    method: 'GET',
    headers: {
      'User-Agent': 'VideoAccessTest/1.0'
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const usage = JSON.parse(data);
        console.log('📊 Usage Data:', {
          videosWatched: usage.videosWatched || 0,
          totalDataMB: usage.totalDataMB || 0,
          videoEarnedMB: usage.videoEarnedMB || 0,
          nextMilestone: usage.nextMilestone
        });
        console.log('');
        
        // Start actual proxy tests
        runProxyTests();
      } catch (err) {
        console.log('❌ Failed to parse usage data:', err.message);
        runProxyTests();
      }
    });
  });

  req.on('error', (err) => {
    console.log('❌ Failed to check usage:', err.message);
    runProxyTests();
  });

  req.end();
}

// Run the actual proxy tests
function runProxyTests() {
  console.log('🌐 TESTING INTERNET ACCESS THROUGH PROXY');
  console.log('=========================================');
  
  const testSites = [
    'http://httpbin.org/ip',           // Test basic HTTP
    'http://example.com',              // Test simple site
    'http://www.google.com',           // Test major site
    'http://facebook.com',             // Test social media
    'http://whatsapp.com'              // Test WhatsApp access
  ];
  
  let testIndex = 0;
  
  function runNextTest() {
    if (testIndex >= testSites.length) {
      console.log('🏁 ALL TESTS COMPLETED');
      console.log('======================');
      console.log('');
      console.log('EXPECTED RESULTS FOR VIDEO ACCESS USERS:');
      console.log('✅ All HTTP requests should return 200 (success)');
      console.log('✅ No 302 redirects to login page');
      console.log('✅ Internet access until data limit reached');
      console.log('');
      console.log('If seeing 302 redirects, check:');
      console.log('1. User has watched 5+ videos (100MB access)');
      console.log('2. User hasn\'t exceeded their data allowance');
      console.log('3. Device isolation isn\'t blocking access');
      console.log('4. Proxy is running and configured correctly');
      return;
    }
    
    testHTTPAccess(testSites[testIndex], () => {
      testIndex++;
      setTimeout(runNextTest, 1000); // 1 second delay between tests
    });
  }
  
  runNextTest();
}

// Start the verification
console.log('🚀 Starting proxy unblocking verification...');
console.log('');

// First check video access status, then run proxy tests
checkVideoAccessStatus();
