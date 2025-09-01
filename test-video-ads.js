// Video Ad Testing Script - Updated with current playlist
// Tests each video URL individually to check which ones are working
const http = require('http');
const https = require('https');

const videoUrls = [
    // Google CDN Videos (commondatastorage.googleapis.com)
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    
    // Other CDN Videos
    'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4',
    'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
    'https://archive.org/download/SampleVideo1280x7205mb/SampleVideo_1280x720_5mb.mp4',
    'https://vjs.zencdn.net/v/oceans.mp4',
    'https://media.w3.org/2010/05/sintel/trailer_hd.mp4'
];

// Test through proxy
const PROXY_PORT = 3150;
const proxyUrls = videoUrls.map(url => 
    `http://localhost:${PROXY_PORT}/proxy?url=${encodeURIComponent(url)}`
);

function testVideoUrl(url, index, isProxy = false) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, { method: 'HEAD' }, (res) => {
            const status = res.statusCode;
            const contentType = res.headers['content-type'] || '';
            const contentLength = res.headers['content-length'] || 'unknown';
            
            console.log(`${index + 1}. ${isProxy ? '[PROXY] ' : '[DIRECT]'} ${url}`);
            console.log(`   Status: ${status}`);
            console.log(`   Content-Type: ${contentType}`);
            console.log(`   Content-Length: ${contentLength}`);
            
            if (status >= 200 && status < 300) {
                console.log(`   ✅ WORKING`);
                resolve({ url, status, working: true, contentType, contentLength });
            } else {
                console.log(`   ❌ NOT WORKING`);
                resolve({ url, status, working: false, contentType, contentLength });
            }
            console.log('');
        });
        
        req.on('error', (err) => {
            console.log(`${index + 1}. ${isProxy ? '[PROXY] ' : '[DIRECT]'} ${url}`);
            console.log(`   ❌ ERROR: ${err.message}`);
            console.log('');
            resolve({ url, status: 0, working: false, error: err.message });
        });
        
        req.setTimeout(10000, () => {
            console.log(`${index + 1}. ${isProxy ? '[PROXY] ' : '[DIRECT]'} ${url}`);
            console.log(`   ❌ TIMEOUT`);
            console.log('');
            req.destroy();
            resolve({ url, status: 0, working: false, error: 'timeout' });
        });
        
        req.end();
    });
}

async function testAllVideos() {
    console.log('🎬 TESTING VIDEO ADS - DIRECT ACCESS\n');
    console.log('='.repeat(60));
    
    // Test direct URLs first
    const directResults = [];
    for (let i = 0; i < videoUrls.length; i++) {
        const result = await testVideoUrl(videoUrls[i], i, false);
        directResults.push(result);
    }
    
    console.log('\n🔄 TESTING VIDEO ADS - THROUGH PROXY\n');
    console.log('='.repeat(60));
    
    // Test proxy URLs
    const proxyResults = [];
    for (let i = 0; i < proxyUrls.length; i++) {
        const result = await testVideoUrl(proxyUrls[i], i, true);
        proxyResults.push(result);
    }
    
    // Summary
    console.log('\n📊 SUMMARY RESULTS\n');
    console.log('='.repeat(60));
    
    const directWorking = directResults.filter(r => r.working).length;
    const proxyWorking = proxyResults.filter(r => r.working).length;
    
    console.log(`Direct Access: ${directWorking}/${videoUrls.length} working`);
    console.log(`Proxy Access: ${proxyWorking}/${proxyUrls.length} working`);
    
    console.log('\n✅ WORKING VIDEOS (Direct):');
    directResults.filter(r => r.working).forEach((r, i) => {
        const originalUrl = videoUrls[directResults.indexOf(r)];
        console.log(`${i + 1}. ${originalUrl}`);
    });
    
    console.log('\n❌ FAILED VIDEOS (Direct):');
    directResults.filter(r => !r.working).forEach((r, i) => {
        const originalUrl = videoUrls[directResults.indexOf(r)];
        console.log(`${i + 1}. ${originalUrl} (${r.error || r.status})`);
    });
    
    console.log('\n✅ WORKING VIDEOS (Proxy):');
    proxyResults.filter(r => r.working).forEach((r, i) => {
        const originalIndex = proxyResults.indexOf(r);
        const originalUrl = videoUrls[originalIndex];
        console.log(`${i + 1}. ${originalUrl}`);
    });
    
    console.log('\n❌ FAILED VIDEOS (Proxy):');
    proxyResults.filter(r => !r.working).forEach((r, i) => {
        const originalIndex = proxyResults.indexOf(r);
        const originalUrl = videoUrls[originalIndex];
        console.log(`${i + 1}. ${originalUrl} (${r.error || r.status})`);
    });
    
    return { directResults, proxyResults };
}

// Run the test if this file is executed directly
if (require.main === module) {
    testAllVideos().catch(console.error);
}

module.exports = { testVideoUrl, testAllVideos };
