// Test FIXED video completion for phone user 0796694562
const http = require('http');

console.log('Testing FIXED video completion system for phone user 0796694562...');
console.log('This should create ACTUAL data bundles, not just track videos!');

const videos = [
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
];

let videoIndex = 0;

function completeNextVideo() {
  if (videoIndex >= videos.length) {
    console.log('\n=================================');
    console.log('🎉 TEST COMPLETE! All 5 videos watched!');
    console.log('=================================');
    console.log('✅ Phone user should now have 100MB data bundle');
    console.log('✅ User should be auto-authenticated for proxy access');
    console.log('✅ Videos should load through proxy even with no prior data');
    return;
  }

  const postData = JSON.stringify({
    identifier: '0796694562',
    videoUrl: videos[videoIndex],
    duration: 35, // Complete video (30+ seconds)
    deviceId: 'fba9de8d12345678'
  });

  const options = {
    hostname: '10.5.48.94',
    port: 3150,
    path: '/api/video/complete',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; MED-LX9 Build/HUAW)'
    }
  };

  console.log(`\n📹 [VIDEO ${videoIndex + 1}/5] ${videos[videoIndex]}`);

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        console.log(`✅ Status: ${res.statusCode}`);
        console.log(`📊 Response:`, {
          ok: parsed.ok,
          earnedMB: parsed.earnedMB,
          totalVideos: parsed.totalVideos,
          totalEarnedMB: parsed.totalEarnedMB,
          bundleCreated: parsed.bundleCreated,
          bundleAmount: parsed.bundleAmount,
          milestone: parsed.milestone
        });
        
        if (parsed.bundleCreated) {
          console.log(`🎁 BUNDLE CREATED! ${parsed.bundleAmount}MB data bundle unlocked!`);
        }
        
        if (parsed.milestone) {
          console.log(`🎯 MILESTONE: ${parsed.milestone.message} - ${parsed.milestone.data}`);
        }
        
      } catch (e) {
        console.log(`❌ Parse Error:`, e.message);
        console.log(`📄 Raw Response:`, data);
      }
      
      videoIndex++;
      setTimeout(completeNextVideo, 1500); // Wait 1.5 seconds between videos
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Request Error:`, e.message);
    videoIndex++;
    setTimeout(completeNextVideo, 1500);
  });

  req.write(postData);
  req.end();
}

// Start the test
completeNextVideo();
