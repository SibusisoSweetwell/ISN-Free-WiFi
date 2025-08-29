// Simple test to verify the manual proxy can access portal
const http = require('http');

console.log('🔍 Testing portal access through manual proxy...');

// Simulate a manual proxy request to the portal
const options = {
  hostname: 'localhost',
  port: 8082,  // Connect to proxy port
  path: 'http://10.5.48.94:3150/login.html',  // Request portal through proxy
  method: 'GET',
  headers: {
    'Host': '10.5.48.94:3150',
    'Proxy-Connection': 'keep-alive',  // Manual proxy header
    'User-Agent': 'Test-Manual-Proxy'
  }
};

const req = http.request(options, (res) => {
  console.log(`📊 Status: ${res.statusCode}`);
  console.log('📄 Headers:', res.headers);
  
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200 && data.includes('login')) {
      console.log('✅ SUCCESS: Portal accessible through manual proxy!');
    } else {
      console.log('❌ FAILED: Portal not accessible');
      console.log('Response:', data.substring(0, 200) + '...');
    }
  });
});

req.on('error', (e) => {
  console.log('❌ Connection error:', e.message);
  console.log('💡 Make sure server is running on both ports 3150 and 8082');
});

req.end();
