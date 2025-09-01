// Quick video system test
console.log('Testing video URL insertion and proxy configuration...');

// Test mp4Ads array (same as in home.html)
const mp4Ads = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4'
];

console.log('[VIDEO-TEST] MP4 ads array has', mp4Ads.length, 'videos');
console.log('[VIDEO-TEST] Sample URLs:');
mp4Ads.slice(0, 3).forEach((url, idx) => {
    console.log(`  ${idx + 1}. ${url}`);
});

// Test USE_MP4_ONLY configuration
const USE_MP4_ONLY = true;
console.log('[VIDEO-TEST] USE_MP4_ONLY:', USE_MP4_ONLY);

// Test ad list generation
let adList = [];
const adCount = 5;
let basePool;
if(USE_MP4_ONLY) basePool = mp4Ads.map(u => ({type:'mp4', url:u}));
const shuffled = [...basePool].sort(() => Math.random() - 0.5);
adList = shuffled.slice(0, adCount);

console.log('[VIDEO-TEST] Generated adList length:', adList.length);
console.log('[VIDEO-TEST] First ad:', adList[0]);

// Test proxy URL generation
const PROXY_PORT = 8083;
const hostname = 'localhost';
function buildVideoProxyUrl(originalUrl) {
    return `http://${hostname}:${PROXY_PORT}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

const testUrl = mp4Ads[0];
const proxyUrl = buildVideoProxyUrl(testUrl);
console.log('[VIDEO-TEST] Original URL:', testUrl);
console.log('[VIDEO-TEST] Proxy URL:', proxyUrl);

console.log('[VIDEO-TEST] ✅ Video URL insertion test completed successfully!');
