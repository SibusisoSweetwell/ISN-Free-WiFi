const http = require('http');

// Test if proxy usage tracking is working for the phone user
console.log('=== Testing Proxy Usage Tracking ===');

const phoneUser = '0796694562';
const testUrl = 'http://example.com'; // Simple test site

// Simulate a proxy request to test usage tracking
const options = {
  hostname: '10.5.48.94', // The proxy server
  port: 8082,
  method: 'GET',
  path: testUrl,
  headers: {
    'Host': 'example.com',
    'User-Agent': 'Mozilla/5.0 (test-proxy-usage)',
    'Cookie': `portal_token=${phoneUser}_some_token_data` // Simulate authenticated user
  }
};

console.log('Sending test request through proxy...');
console.log('Phone user:', phoneUser);
console.log('Target URL:', testUrl);
console.log('Proxy:', options.hostname + ':' + options.port);

const req = http.request(options, (res) => {
  console.log('Response status:', res.statusCode);
  console.log('Response headers:', res.headers);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
    console.log('Received data chunk:', chunk.length, 'bytes');
  });
  
  res.on('end', () => {
    console.log('Total response size:', data.length, 'bytes');
    console.log('This should be tracked as data usage for user:', phoneUser);
    console.log('\nCheck the server logs for [USAGE-TRACKED] messages');
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  console.log('\nThis might mean:');
  console.log('1. Proxy server is not running on port 8082');
  console.log('2. Phone user is not properly authenticated');
  console.log('3. Network connectivity issue');
});

req.setTimeout(10000, () => {
  console.log('Request timeout - proxy may not be responding');
  req.destroy();
});

req.end();

// Also test the usage report API
setTimeout(() => {
  console.log('\n=== Testing Usage Report API ===');
  
  const apiOptions = {
    hostname: '10.5.48.94',
    port: 3150, // Main server port
    method: 'POST',
    path: '/api/usage/report',
    headers: {
      'Content-Type': 'application/json'
    }
  };
  
  const testUsage = {
    identifier: phoneUser,
    usedMB: 0.5 // Test with 0.5MB
  };
  
  const apiReq = http.request(apiOptions, (res) => {
    console.log('API Response status:', res.statusCode);
    
    let apiData = '';
    res.on('data', (chunk) => {
      apiData += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(apiData);
        console.log('API Response:', response);
        
        if (response.quota) {
          console.log('Current quota for', phoneUser + ':');
          console.log('  Remaining MB:', response.quota.remainingMB);
          console.log('  Total Bundle MB:', response.quota.totalBundleMB);
          console.log('  Exhausted:', response.quota.exhausted);
        }
      } catch (e) {
        console.log('Raw API Response:', apiData);
      }
    });
  });
  
  apiReq.on('error', (err) => {
    console.error('API Request error:', err.message);
  });
  
  apiReq.write(JSON.stringify(testUsage));
  apiReq.end();
}, 2000);
