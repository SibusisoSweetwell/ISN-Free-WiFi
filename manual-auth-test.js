const http = require('http');

console.log('=== Manual Authentication Test for Phone User ===');

const phoneUser = '0796694562';

// Create a manual authentication request
const authData = {
  identifier: phoneUser,
  action: 'authenticate',
  reason: 'user_has_data_bundles'
};

const options = {
  hostname: '10.5.48.94',
  port: 3150,
  method: 'POST',
  path: '/api/device/register',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; phone-auth-test)'
  }
};

console.log('Attempting to authenticate phone user:', phoneUser);
console.log('Request data:', authData);

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', res.headers);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('Authentication Response:');
      console.log(JSON.stringify(response, null, 2));
      
      if (response.ok) {
        console.log('\n✅ Phone user successfully authenticated!');
        console.log('Session token:', response.sessionToken);
        
        // Now test proxy access
        setTimeout(() => {
          console.log('\n=== Testing Proxy Access After Authentication ===');
          testProxyAccess();
        }, 1000);
      } else {
        console.log('\n❌ Authentication failed:', response.error || 'Unknown error');
      }
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
});

req.write(JSON.stringify(authData));
req.end();

function testProxyAccess() {
  const testOptions = {
    hostname: '10.5.48.94',
    port: 8082,
    method: 'GET',
    path: 'http://example.com',
    headers: {
      'Host': 'example.com',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; phone-test-authenticated)'
    }
  };
  
  console.log('Testing proxy access to example.com...');
  
  const proxyReq = http.request(testOptions, (res) => {
    console.log('Proxy Response Status:', res.statusCode);
    console.log('Proxy Response Headers:', res.headers);
    
    if (res.statusCode === 200) {
      console.log('✅ SUCCESS: Phone user can now access the internet through proxy!');
    } else if (res.statusCode === 302) {
      console.log('❌ STILL BLOCKED: Phone user redirected to:', res.headers.location);
    } else {
      console.log('❓ UNEXPECTED: Status', res.statusCode);
    }
    
    let proxyData = '';
    res.on('data', (chunk) => {
      proxyData += chunk.toString().substring(0, 200); // First 200 chars
    });
    
    res.on('end', () => {
      console.log('Response preview:', proxyData);
    });
  });
  
  proxyReq.on('error', (err) => {
    console.error('Proxy test error:', err.message);
  });
  
  proxyReq.setTimeout(10000, () => {
    console.log('Proxy test timeout');
    proxyReq.destroy();
  });
  
  proxyReq.end();
}
