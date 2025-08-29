// Manually create missing data bundles for phone user 0796694562
const http = require('http');

function createDataBundle(bundleMB, reason) {
  const postData = JSON.stringify({
    identifier: '0796694562',
    bundleMB: bundleMB,
    routerId: 'video-milestone-fix',
    source: 'manual_milestone_fix'
  });

  const options = {
    hostname: '10.5.48.94',
    port: 3150,
    path: '/api/bundle/grant',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  console.log(`🛠️ Creating ${bundleMB}MB bundle for 0796694562 (${reason})`);

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`📊 Status: ${res.statusCode}`);
      console.log(`📄 Response: ${data}`);
      
      try {
        const parsed = JSON.parse(data);
        if (parsed.ok) {
          console.log(`✅ Successfully created ${bundleMB}MB bundle!`);
        } else {
          console.log(`❌ Failed to create bundle: ${parsed.message}`);
        }
      } catch (e) {
        console.log(`❌ Parse error: ${e.message}`);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Request error: ${e.message}`);
  });

  req.write(postData);
  req.end();
}

console.log('🔧 FIXING MISSING DATA BUNDLES FOR PHONE USER 0796694562');
console.log('=======================================================');
console.log('User has 12+ videos watched but missing data bundles');
console.log('Creating milestone bundles manually...');

// User should have 250MB for 10+ videos milestone
createDataBundle(250, 'Missing 10+ videos milestone (250MB)');
