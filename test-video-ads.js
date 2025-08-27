// Test script to verify video ads are accessible and working
const http = require('http');
const https = require('https');

const videoUrls = [
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
];

function testVideoUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    
    console.log(`Testing video: ${url}`);
    
    const req = protocol.request(url, { method: 'HEAD' }, (res) => {
      console.log(`✓ ${url}`);
      console.log(`  Status: ${res.statusCode}`);
      console.log(`  Content-Type: ${res.headers['content-type']}`);
      console.log(`  Content-Length: ${res.headers['content-length']} bytes`);
      console.log(`  Accept-Ranges: ${res.headers['accept-ranges']}`);
      console.log('');
      
      resolve({
        url,
        status: res.statusCode,
        contentType: res.headers['content-type'],
        contentLength: res.headers['content-length'],
        acceptRanges: res.headers['accept-ranges'],
        accessible: res.statusCode === 200
      });
    });
    
    req.on('error', (err) => {
      console.log(`✗ ${url} - Error: ${err.message}`);
      console.log('');
      resolve({
        url,
        accessible: false,
        error: err.message
      });
    });
    
    req.setTimeout(10000, () => {
      console.log(`✗ ${url} - Timeout`);
      console.log('');
      req.destroy();
      resolve({
        url,
        accessible: false,
        error: 'Timeout'
      });
    });
    
    req.end();
  });
}

async function testAllVideos() {
  console.log('Testing video ad accessibility...\n');
  
  const results = [];
  
  for (const url of videoUrls) {
    const result = await testVideoUrl(url);
    results.push(result);
  }
  
  console.log('=== SUMMARY ===');
  const accessible = results.filter(r => r.accessible);
  const failed = results.filter(r => !r.accessible);
  
  console.log(`Accessible videos: ${accessible.length}/${results.length}`);
  console.log(`Failed videos: ${failed.length}/${results.length}`);
  
  if (failed.length > 0) {
    console.log('\nFailed videos:');
    failed.forEach(f => {
      console.log(`  - ${f.url}: ${f.error || 'Unknown error'}`);
    });
  }
  
  console.log('\nVideo test completed.');
  return results;
}

// Test portal accessibility
function testPortalAccess() {
  return new Promise((resolve) => {
    console.log('Testing portal access at http://10.5.48.94:3150...');
    
    const req = http.request('http://10.5.48.94:3150', { method: 'HEAD' }, (res) => {
      console.log(`✓ Portal accessible - Status: ${res.statusCode}`);
      resolve(true);
    });
    
    req.on('error', (err) => {
      console.log(`✗ Portal not accessible - Error: ${err.message}`);
      resolve(false);
    });
    
    req.setTimeout(5000, () => {
      console.log(`✗ Portal timeout`);
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

async function main() {
  console.log('ISN Free WiFi - Video Ads Test\n');
  
  // Test portal first
  const portalAccessible = await testPortalAccess();
  console.log('');
  
  if (!portalAccessible) {
    console.log('Warning: Portal not accessible. Users may not be able to watch ads.');
    console.log('');
  }
  
  // Test video URLs
  const videoResults = await testAllVideos();
  
  // Final recommendations
  console.log('\n=== RECOMMENDATIONS ===');
  
  if (portalAccessible) {
    console.log('✓ Portal is accessible');
  } else {
    console.log('✗ Portal needs to be started: node server.js');
  }
  
  const accessibleVideos = videoResults.filter(r => r.accessible).length;
  if (accessibleVideos > 0) {
    console.log(`✓ ${accessibleVideos} video(s) are accessible and should play correctly`);
  }
  
  if (accessibleVideos < videoResults.length) {
    console.log(`⚠ ${videoResults.length - accessibleVideos} video(s) may have issues`);
  }
  
  if (accessibleVideos >= 3) {
    console.log('✓ Sufficient videos available for ad rotation');
  } else {
    console.log('⚠ Limited videos available - consider adding more sources');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { testVideoUrl, testAllVideos, testPortalAccess };
