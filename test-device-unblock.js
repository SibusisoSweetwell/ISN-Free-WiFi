const http = require('http');

const data = JSON.stringify({
    identifier: '0796694562',
    deviceId: 'c21f969b',
    reason: 'User completed videos but device blocked'
});

const options = {
    hostname: 'localhost',
    port: 3150,
    path: '/api/admin/device-unblock',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

console.log('Testing device unblock for user 0796694562...');

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers:`, res.headers);
    
    let responseData = '';
    res.on('data', (chunk) => {
        responseData += chunk;
    });
    
    res.on('end', () => {
        console.log('Response:', responseData);
    });
});

req.on('error', (error) => {
    console.error('Request failed:', error);
});

req.write(data);
req.end();
