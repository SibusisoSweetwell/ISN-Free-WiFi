// Test video completion for phone user 0796694562
const http = require('http');

function testVideoCompletion() {
  const postData = JSON.stringify({
    identifier: '0796694562',
    videoUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    duration: 35,
    deviceId: 'fba9de8d12345678' // The device ID from server logs
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

  console.log('[TEST-VIDEO-COMPLETION] Testing video completion for 0796694562...');
  console.log('[REQUEST-DATA]', postData);

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log('[RESPONSE-STATUS]', res.statusCode);
      console.log('[RESPONSE-HEADERS]', res.headers);
      console.log('[RESPONSE-BODY]', data);
      
      try {
        const parsed = JSON.parse(data);
        console.log('[PARSED-RESPONSE]', parsed);
      } catch (e) {
        console.log('[PARSE-ERROR]', e.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error('[REQUEST-ERROR]', e.message);
  });

  req.write(postData);
  req.end();
}

// Test multiple video completions to reach the 5 video milestone (100MB)
console.log('Testing 5 video completions for phone user 0796694562...');

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
    console.log('[TEST-COMPLETE] All 5 videos completed!');
    return;
  }

  const postData = JSON.stringify({
    identifier: '0796694562',
    videoUrl: videos[videoIndex],
    duration: 35,
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

  console.log(`[VIDEO-${videoIndex + 1}/5] Completing video: ${videos[videoIndex]}`);

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`[VIDEO-${videoIndex + 1}-RESPONSE]`, {
        status: res.statusCode,
        body: data
      });
      
      try {
        const parsed = JSON.parse(data);
        console.log(`[VIDEO-${videoIndex + 1}-RESULT]`, {
          ok: parsed.ok,
          earnedMB: parsed.earnedMB,
          totalVideos: parsed.totalVideos,
          totalEarnedMB: parsed.totalEarnedMB,
          milestone: parsed.milestone
        });
      } catch (e) {
        console.log(`[VIDEO-${videoIndex + 1}-PARSE-ERROR]`, e.message);
      }
      
      videoIndex++;
      setTimeout(completeNextVideo, 1000); // Wait 1 second between videos
    });
  });

  req.on('error', (e) => {
    console.error(`[VIDEO-${videoIndex + 1}-ERROR]`, e.message);
    videoIndex++;
    setTimeout(completeNextVideo, 1000);
  });

  req.write(postData);
  req.end();
}

// Start the test
completeNextVideo();
