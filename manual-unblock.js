// Manual device unblock for user 0796694562
// This script manually grants internet access by updating the data structures

const phoneNumber = '0796694562';
const deviceId = 'c21f969b';

console.log(`[MANUAL-UNBLOCK] Unblocking device ${deviceId} for user ${phoneNumber}`);

// Simulate video completion to grant access
const fs = require('fs');

// Load existing data
let data = {};
try {
    if (fs.existsSync('data.json')) {
        data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    }
} catch (err) {
    console.log('Creating new data structure...');
}

// Ensure user exists
if (!data[phoneNumber]) {
    data[phoneNumber] = {
        videosWatched: 0,
        dataUsed: 0,
        lastVideoTime: null,
        sessionExpiry: null,
        totalDataEarned: 0,
        videoProgress: []
    };
}

// Update video milestones to grant access
data[phoneNumber].videosWatched = 5; // Grant 100MB for 5 videos
data[phoneNumber].totalDataEarned = 100 * 1024 * 1024; // 100MB in bytes
data[phoneNumber].dataUsed = 0; // Reset usage
data[phoneNumber].sessionExpiry = Date.now() + (6 * 60 * 60 * 1000); // 6 hours from now
data[phoneNumber].lastVideoTime = Date.now();
data[phoneNumber].videoProgress = [
    { completed: Date.now() - 300000 },
    { completed: Date.now() - 240000 },
    { completed: Date.now() - 180000 },
    { completed: Date.now() - 120000 },
    { completed: Date.now() - 60000 }
];

// Save updated data
fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

console.log(`[MANUAL-UNBLOCK] User ${phoneNumber} granted 100MB data access`);
console.log(`[MANUAL-UNBLOCK] Videos watched: ${data[phoneNumber].videosWatched}`);
console.log(`[MANUAL-UNBLOCK] Data earned: ${Math.round(data[phoneNumber].totalDataEarned / (1024*1024))}MB`);
console.log(`[MANUAL-UNBLOCK] Session expires: ${new Date(data[phoneNumber].sessionExpiry).toLocaleString()}`);

// Also update the device isolation data if it exists
try {
    let deviceData = {};
    if (fs.existsSync('device-isolation-data.json')) {
        deviceData = JSON.parse(fs.readFileSync('device-isolation-data.json', 'utf8'));
    }
    
    if (!deviceData[phoneNumber]) {
        deviceData[phoneNumber] = {};
    }
    
    // Clear any device blocks
    if (deviceData[phoneNumber].blockedDevices) {
        delete deviceData[phoneNumber].blockedDevices[deviceId];
        console.log(`[MANUAL-UNBLOCK] Removed device block for ${deviceId}`);
    }
    
    // Create device access token
    if (!deviceData[phoneNumber].deviceTokens) {
        deviceData[phoneNumber].deviceTokens = {};
    }
    
    deviceData[phoneNumber].deviceTokens[deviceId] = {
        deviceId: deviceId,
        mac: '',
        granted: Date.now(),
        expires: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
        accessLevel: 5, // Video completion access
        dataGranted: 100 * 1024 * 1024
    };
    
    fs.writeFileSync('device-isolation-data.json', JSON.stringify(deviceData, null, 2));
    console.log(`[MANUAL-UNBLOCK] Created device access token for ${deviceId}`);
    
} catch (err) {
    console.log('Device isolation data not found, creating new...');
}

console.log(`[MANUAL-UNBLOCK] Manual unblock completed successfully!`);
console.log(`[MANUAL-UNBLOCK] User ${phoneNumber} should now have internet access through proxy 8082`);
