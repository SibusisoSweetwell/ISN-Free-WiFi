// Quick test to verify the device isolation bypass fix
const deviceIsolation = require('./device-isolation-enhancement.js');

console.log('[TEST] Testing device isolation bypass for user 0796694562...');

// Test the validateDeviceAccess function directly
const deviceInfo = {
  deviceId: '031f0b64',
  mac: '',
  ip: '10.5.48.94',
  identifier: '0796694562'
};

const result = deviceIsolation.validateDeviceAccess(deviceInfo, 'default-router');

console.log('[TEST] Validation result:', result);

if (result.valid && result.emergencyAccess) {
  console.log('[TEST] ✅ Emergency bypass working! User 0796694562 should have access.');
} else {
  console.log('[TEST] ❌ Emergency bypass not working. Result:', result);
}

console.log('[TEST] Test complete.');
