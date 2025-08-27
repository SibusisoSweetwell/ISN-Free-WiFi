// Debug script for joseph@gmail.com video issues
const http = require('http');

console.log('Debugging video issues for joseph@gmail.com...\n');

// Test 1: Check if user exists and has proper session
async function testUserSession() {
  console.log('1. Testing user session for joseph@gmail.com...');
  
  try {
    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        email: 'joseph@gmail.com',
        password: 'test123'
      });
      
      const req = http.request({
        hostname: '10.5.48.94',
        port: 3150,
        path: '/api/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });
      
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      req.write(postData);
      req.end();
    });
    
    console.log(`   Status: ${response.status}`);
    if (response.status === 200) {
      const result = JSON.parse(response.body);
      console.log(`   Login successful: ${result.success}`);
      console.log(`   User identifier: ${result.identifier || 'Not provided'}`);
    } else {
      console.log(`   Login failed: ${response.body}`);
    }
    
  } catch (err) {
    console.log(`   Error: ${err.message}`);
  }
}

// Test 2: Check quota status
async function testQuotaStatus() {
  console.log('\n2. Testing quota status...');
  
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '10.5.48.94',
        port: 3150,
        path: '/api/quota/status',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: data
          });
        });
      });
      
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      req.write(JSON.stringify({ identifier: 'joseph@gmail.com' }));
      req.end();
    });
    
    console.log(`   Status: ${response.status}`);
    if (response.status === 200) {
      const quota = JSON.parse(response.body);
      console.log(`   Quota exhausted: ${quota.exhausted}`);
      console.log(`   Remaining MB: ${quota.remainingMB}`);
      console.log(`   Total MB: ${quota.totalMB}`);
    } else {
      console.log(`   Quota check failed: ${response.body}`);
    }
    
  } catch (err) {
    console.log(`   Error: ${err.message}`);
  }
}

// Test 3: Try to grant a small bundle
async function testBundleGrant() {
  console.log('\n3. Testing bundle grant...');
  
  try {
    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        identifier: 'joseph@gmail.com',
        bundleMB: 100,
        routerId: 'test-router',
        source: 'manual-test',
        totalWatchTime: 60,
        videosCompleted: 3
      });
      
      const req = http.request({
        hostname: '10.5.48.94',
        port: 3150,
        path: '/api/bundle/grant',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: data
          });
        });
      });
      
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      req.write(postData);
      req.end();
    });
    
    console.log(`   Status: ${response.status}`);
    console.log(`   Response: ${response.body}`);
    
  } catch (err) {
    console.log(`   Error: ${err.message}`);
  }
}

// Test 4: Check video URL accessibility through proxy
async function testVideoAccess() {
  console.log('\n4. Testing video URL accessibility...');
  
  const testUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4';
  
  try {
    const https = require('https');
    const response = await new Promise((resolve, reject) => {
      const req = https.request(testUrl, { method: 'HEAD' }, (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers
        });
      });
      
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      req.end();
    });
    
    console.log(`   Status: ${response.status}`);
    console.log(`   Content-Type: ${response.headers['content-type']}`);
    console.log(`   Content-Length: ${response.headers['content-length']} bytes`);
    console.log(`   Accept-Ranges: ${response.headers['accept-ranges']}`);
    
    if (response.status === 200) {
      console.log('   ✓ Video URL is accessible');
    } else {
      console.log('   ✗ Video URL access failed');
    }
    
  } catch (err) {
    console.log(`   Error: ${err.message}`);
  }
}

async function runDiagnostics() {
  await testUserSession();
  await testQuotaStatus();
  await testBundleGrant();
  await testVideoAccess();
  
  console.log('\n=== RECOMMENDATIONS ===');
  console.log('');
  console.log('If videos are still failing for joseph@gmail.com:');
  console.log('1. Clear browser cache and cookies');
  console.log('2. Try incognito/private browsing mode');
  console.log('3. Disable browser extensions temporarily');
  console.log('4. Check browser console for JavaScript errors');
  console.log('5. Try different browser (Chrome recommended)');
  console.log('6. Verify system clock is accurate');
  console.log('7. Check if corporate firewall blocks video domains');
  console.log('');
  console.log('Server-side fixes applied:');
  console.log('✓ Enhanced error handling with retry mechanism');
  console.log('✓ Added CORS headers for better compatibility');
  console.log('✓ Added alternative video fallback system');
  console.log('✓ Enhanced logging for better debugging');
  console.log('');
  console.log('The user should now have better video playback reliability.');
}

runDiagnostics().catch(console.error);
