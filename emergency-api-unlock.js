const http = require('http');

// Emergency unlock via API call to running server
function emergencyUnlockBongilindiwe() {
    console.log('=== EMERGENCY API UNLOCK FOR BONGILINDIWE ===');
    
    const postData = JSON.stringify({
        identifier: 'bongilindiwe844@gmail.com',
        reason: 'Emergency fix - videos watched but internet not unlocked',
        grantMB: 100,
        bypassDeviceCheck: true
    });

    const options = {
        hostname: 'localhost',
        port: 3150,
        path: '/admin/unlock-emergency',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Headers: ${JSON.stringify(res.headers)}`);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log('Response:', data);
            console.log('✅ Emergency unlock request sent');
        });
    });

    req.on('error', (e) => {
        console.error('❌ Request error:', e.message);
    });

    req.write(postData);
    req.end();
}

// Also try granting device access
function grantDeviceAccess() {
    console.log('\n=== GRANTING DEVICE ACCESS ===');
    
    const deviceData = JSON.stringify({
        identifier: 'bongilindiwe844@gmail.com',
        deviceId: 'a8197ed1290741654683b68ba9743275',
        reason: 'Emergency device unlock'
    });

    const options = {
        hostname: 'localhost',
        port: 3150,
        path: '/admin/device-access-grant',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(deviceData)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`Device Access Status: ${res.statusCode}`);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log('Device Access Response:', data);
        });
    });

    req.on('error', (e) => {
        console.error('❌ Device access error:', e.message);
    });

    req.write(deviceData);
    req.end();
}

// Try video completion API
function forceVideoCompletion() {
    console.log('\n=== FORCING VIDEO COMPLETION ===');
    
    const videoData = JSON.stringify({
        identifier: 'bongilindiwe844@gmail.com',
        videoId: 'emergency_video_1',
        earnedMB: 100,
        deviceId: 'a8197ed1290741654683b68ba9743275'
    });

    const options = {
        hostname: 'localhost',
        port: 3150,
        path: '/api/video/complete',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(videoData)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`Video Complete Status: ${res.statusCode}`);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log('Video Complete Response:', data);
        });
    });

    req.on('error', (e) => {
        console.error('❌ Video completion error:', e.message);
    });

    req.write(videoData);
    req.end();
}

// Run all fixes
emergencyUnlockBongilindiwe();
setTimeout(grantDeviceAccess, 1000);
setTimeout(forceVideoCompletion, 2000);
