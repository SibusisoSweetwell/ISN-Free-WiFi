const http = require('http');
const crypto = require('crypto');

console.log('=== Testing Phone User Authentication Debug ===');

const phoneUser = '0796694562';

// Test what device fingerprint would be generated
const testUserAgent = 'Mozilla/5.0 (Linux; Android 10; SM-A505F) AppleWebKit/537.36';
const testRouterId = '192.168.1.100'; // Simulated phone IP
const deviceFingerprint = crypto.createHash('md5').update(testUserAgent + testRouterId).digest('hex').slice(0,16);

console.log('Phone user:', phoneUser);
console.log('Test User Agent:', testUserAgent);
console.log('Test Router ID:', testRouterId);
console.log('Generated Device Fingerprint:', deviceFingerprint);

// Check if this device fingerprint exists in the Excel data
const XLSX = require('xlsx');
try {
  const wb = XLSX.readFile('logins.xlsx');
  if (wb.SheetNames.includes('AdEvents')) {
    const ws = wb.Sheets['AdEvents'];
    const data = XLSX.utils.sheet_to_json(ws, {header: 1});
    
    console.log('\n=== Searching for device fingerprints in Excel data ===');
    
    let foundEvents = [];
    data.forEach((row, index) => {
      if (row[2] === phoneUser) { // identifier in column 2
        const deviceId = row[3]; // device ID in column 3
        foundEvents.push({
          row: index + 1,
          identifier: row[2],
          deviceId: deviceId,
          eventType: row[4],
          timestamp: row[7]
        });
      }
    });
    
    console.log('Found events for phone user:', foundEvents.length);
    if (foundEvents.length > 0) {
      console.log('Sample events:');
      foundEvents.slice(0, 5).forEach(event => {
        console.log(`  Row ${event.row}: Device ${event.deviceId.slice(0,8)}... Event: ${event.eventType}`);
      });
      
      // Get unique device IDs for this user
      const uniqueDevices = [...new Set(foundEvents.map(e => e.deviceId))];
      console.log('\nUnique device IDs for', phoneUser + ':', uniqueDevices.map(d => d.slice(0,8) + '...'));
      
      // Test authentication API with the phone user's actual device ID
      if (uniqueDevices.length > 0) {
        const actualDeviceId = uniqueDevices[0];
        console.log('\n=== Testing Authentication with Actual Device ID ===');
        console.log('Using device ID:', actualDeviceId);
        
        // Test the access check API with the correct identifier
        const options = {
          hostname: '10.5.48.94',
          port: 3150,
          method: 'GET',
          path: '/api/access/check?identifier=' + encodeURIComponent(phoneUser),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (phone-test-with-device-id)',
            'X-Device-ID': actualDeviceId
          }
        };
        
        const req = http.request(options, (res) => {
          console.log('Access Check Status:', res.statusCode);
          
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            try {
              const response = JSON.parse(data);
              console.log('Access Check Response:');
              console.log(JSON.stringify(response, null, 2));
            } catch (e) {
              console.log('Raw response:', data);
            }
          });
        });
        
        req.on('error', (err) => {
          console.error('Request error:', err.message);
        });
        
        req.end();
      }
    }
  }
} catch (error) {
  console.error('Error reading Excel file:', error.message);
}
