// Test video proxy configuration with port 8082
console.log('Testing video proxy configuration...');

// Simulate home.html configuration
const PROXY_HOST = 'localhost';
const PROXY_PORT = 8082;

function proxyUrl(originalUrl) {
    if (!originalUrl) return '';
    
    // Skip non-video URLs
    if (!originalUrl.includes('mp4') && !originalUrl.includes('video')) {
        return originalUrl;
    }
    
    // Create proxy URL that routes through port 8082
    const encodedUrl = encodeURIComponent(originalUrl);
    const proxyUrl = `http://${PROXY_HOST}:${PROXY_PORT}/proxy?url=${encodedUrl}`;
    
    console.log('[PROXY] Routing:', originalUrl, '→', proxyUrl);
    return proxyUrl;
}

// Test with sample video URLs
const testUrls = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://vjs.zencdn.net/v/oceans.mp4',
    'https://media.w3.org/2010/05/sintel/trailer_hd.mp4'
];

console.log('\n🎥 Testing video proxy URL generation with port 8082:');
testUrls.forEach((url, idx) => {
    const proxied = proxyUrl(url);
    console.log(`\n${idx + 1}. Original: ${url}`);
    console.log(`   Proxied:  ${proxied}`);
    
    // Verify it's using port 8082
    if (proxied.includes(':8082/proxy')) {
        console.log('   ✅ Correctly routes through port 8082');
    } else {
        console.log('   ❌ NOT using port 8082!');
    }
});

console.log('\n🚀 Video proxy configuration test completed!');
