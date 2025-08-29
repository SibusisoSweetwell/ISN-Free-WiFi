// Simple test to verify our fixes
const http = require('http');

console.log('🔍 Testing usage API locally...');

const req = http.get('http://localhost:3150/api/me/usage?identifier=0796694562', (res) => {
  let data = '';
  
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('📊 Status:', res.statusCode);
    console.log('📄 Response:', data);
    
    try {
      const parsed = JSON.parse(data);
      if (parsed.ok) {
        console.log('\n✅ SUCCESS! Phone user now has:');
        console.log(`📊 Total: ${parsed.totalBundleMB}MB`);
        console.log(`📋 Remaining: ${parsed.remainingMB}MB`);
        console.log(`📦 Bundles: ${parsed.purchases.length}`);
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  });
}).on('error', (e) => {
  console.log('❌ Connection error:', e.message);
});
