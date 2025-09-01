// Simple video loading test script
console.log('Testing video loading...');

// Test the proxy URL generation
function proxyUrl(originalUrl) {
    if (!originalUrl) return '';
    const base = window.location.origin;
    return `${base}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

// Test URLs from our mp4Ads array
const testVideos = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://vjs.zencdn.net/v/oceans.mp4',
    'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4'
];

console.log('Testing proxy URL generation:');
testVideos.forEach(url => {
    const proxy = proxyUrl(url);
    console.log(`Original: ${url}`);
    console.log(`Proxy: ${proxy}`);
    console.log('---');
});

// Test video element creation and loading
function testVideoLoading() {
    console.log('Testing video element loading...');
    
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    
    const testUrl = proxyUrl(testVideos[0]);
    console.log('Testing with URL:', testUrl);
    
    video.addEventListener('loadstart', () => console.log('[TEST] loadstart'));
    video.addEventListener('loadedmetadata', () => console.log('[TEST] loadedmetadata'));
    video.addEventListener('loadeddata', () => console.log('[TEST] loadeddata'));
    video.addEventListener('canplay', () => console.log('[TEST] canplay'));
    video.addEventListener('canplaythrough', () => console.log('[TEST] canplaythrough'));
    video.addEventListener('playing', () => console.log('[TEST] playing'));
    video.addEventListener('error', (e) => console.error('[TEST] error:', e, video.error));
    
    video.src = testUrl;
    video.load();
    
    setTimeout(() => {
        video.play().then(() => {
            console.log('[TEST] Play successful');
        }).catch(err => {
            console.error('[TEST] Play failed:', err);
        });
    }, 1000);
    
    return video;
}

// Export for use in console
window.testVideoLoading = testVideoLoading;
console.log('Test functions ready. Call testVideoLoading() to test.');
