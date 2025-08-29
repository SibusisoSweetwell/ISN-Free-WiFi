const crypto = require('crypto');
const deviceIsolation = require('./device-isolation-enhancement');

// Test device fingerprint calculation
console.log('=== TESTING ENHANCED DEVICE ISOLATION SYSTEM ===\n');

// Test 1: Basic device fingerprinting
console.log('1. Testing Device Fingerprinting:');
const userAgent1 = 'Mozilla/5.0 (Android 10; Mobile; rv:81.0) Gecko/81.0 Firefox/81.0';
const userAgent2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15';
const routerId = '10.5.48.94';

const device1 = {
  deviceId: crypto.createHash('sha256').update(userAgent1 + routerId).digest('hex').slice(0,32),
  mac: '00:11:22:33:44:55',
  ip: '192.168.1.100',
  userAgent: userAgent1,
  routerId: routerId
};

const device2 = {
  deviceId: crypto.createHash('sha256').update(userAgent2 + routerId).digest('hex').slice(0,32),
  mac: '00:11:22:33:44:66',
  ip: '192.168.1.101',
  userAgent: userAgent2,
  routerId: routerId
};

console.log('Device 1:', {
  id: device1.deviceId.slice(0, 8) + '...',
  mac: device1.mac,
  userAgent: device1.userAgent.slice(0, 50) + '...'
});

console.log('Device 2:', {
  id: device2.deviceId.slice(0, 8) + '...',
  mac: device2.mac,
  userAgent: device2.userAgent.slice(0, 50) + '...'
});

// Test 2: Device earning access
console.log('\n2. Testing Device Access Token Generation:');
try {
  const accessToken1 = deviceIsolation.deviceEarnAccess('testuser@example.com', device1, routerId, 5, 100);
  console.log('Device 1 Access Token:', accessToken1 ? 'Generated ✅' : 'Failed ❌');
  
  const accessToken2 = deviceIsolation.deviceEarnAccess('testuser@example.com', device2, routerId, 3, 0);
  console.log('Device 2 Access Token:', accessToken2 ? 'Generated ✅' : 'Failed ❌');
} catch (error) {
  console.log('Access Token Generation Error:', error.message);
}

// Test 3: Device validation
console.log('\n3. Testing Device Access Validation:');
const validation1 = deviceIsolation.validateDeviceAccess(device1, routerId);
console.log('Device 1 Validation:', validation1.valid ? '✅ Valid' : `❌ ${validation1.reason}`);

const validation2 = deviceIsolation.validateDeviceAccess(device2, routerId);
console.log('Device 2 Validation:', validation2.valid ? '✅ Valid' : `❌ ${validation2.reason}`);

// Test 4: Router blocking (if enabled)
console.log('\n4. Testing Router-level Device Blocking:');
if (deviceIsolation.DEVICE_ISOLATION_CONFIG.ROUTER_DEVICE_BLOCKING) {
  console.log('Router blocking enabled - Device 1 should block Device 2');
  
  // Try to validate device 2 again (should be blocked by device 1)
  const validationAfterBlocking = deviceIsolation.validateDeviceAccess(device2, routerId);
  console.log('Device 2 After Router Blocking:', validationAfterBlocking.valid ? '✅ Valid' : `❌ ${validationAfterBlocking.reason}`);
} else {
  console.log('Router blocking disabled');
}

// Test 5: Status overview
console.log('\n5. Device Access Status Overview:');
const status = deviceIsolation.getDeviceAccessStatus();
console.log('Total Devices:', status.totalDevices);
console.log('Active Devices:', status.activeDevices);
console.log('Devices Pending Revalidation:', status.pendingRevalidation);
console.log('Router Blocking Status:', JSON.stringify(status.routerBlocking, null, 2));

console.log('\n=== DEVICE ISOLATION TEST COMPLETE ===');
console.log('\nConfiguration:');
console.log('- Strict Device Isolation:', deviceIsolation.DEVICE_ISOLATION_CONFIG.STRICT_DEVICE_ISOLATION);
console.log('- MAC Binding:', deviceIsolation.DEVICE_ISOLATION_CONFIG.MAC_BINDING_ENABLED);
console.log('- Router Blocking:', deviceIsolation.DEVICE_ISOLATION_CONFIG.ROUTER_DEVICE_BLOCKING);
console.log('- Token TTL:', deviceIsolation.DEVICE_ISOLATION_CONFIG.ACCESS_TOKEN_TTL_HOURS, 'hours');
console.log('- Revalidation Interval:', deviceIsolation.DEVICE_ISOLATION_CONFIG.REVALIDATION_INTERVAL_HOURS, 'hours');
