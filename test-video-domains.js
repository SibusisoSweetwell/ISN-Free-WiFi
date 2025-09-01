// Quick test to verify video proxy is working
const testDomains = [
  'googlevideo.com',
  'r1---sn-abc123.googlevideo.com',
  'youtube.com',
  'www.youtube.com',
  'ytimg.com',
  'manifest.googlevideo.com',
  'video.google.com',
  'vimeo.com',
  'player.vimeo.com'
];

console.log('Testing video domain detection...');

// Import the isVideoAdCDN function (would need to be extracted from server.js)
function testIsVideoAdCDN(hostHeader) {
  const videoAdDomains = [
    'googleads.g.doubleclick.net','pagead2.googlesyndication.com','tpc.googlesyndication.com',
    'securepubads.g.doubleclick.net','video-ad-stats.googlesyndication.com',
    'imasdk.googleapis.com','www.gstatic.com','ssl.gstatic.com',
    'storage.googleapis.com','commondatastorage.googleapis.com',
    'yt3.ggpht.com','ytimg.com','googlevideo.com','manifest.googlevideo.com',
    'youtube.com','www.youtube.com','m.youtube.com','youtu.be',
    'video.google.com','play.google.com','googleusercontent.com',
    'gvt1.com','gvt2.com','gvt3.com','blogger.googleusercontent.com',
    'vimeo.com','player.vimeo.com','i.vimeocdn.com','f.vimeocdn.com',
    'jwpcdn.com','cdn.jwplayer.com','content.jwplatform.com',
    'brightcove.com','edge.api.brightcove.com','players.brightcove.net',
    'facebook.com','www.facebook.com','m.facebook.com','web.facebook.com',
    'instagram.com','www.instagram.com','cdninstagram.com',
    'fbcdn.net','scontent.com','video.xx.fbcdn.net',
    'spotify.com','open.spotify.com','audio-ak-spotify-com.akamaized.net',
    'scdn.co','spotifycdn.com','audio4-ak-spotify-com.akamaized.net',
    'tiktok.com','www.tiktok.com','v16-webapp.tiktok.com',
    'musically.ly','musical.ly','byteoversea.com',
    'cloudfront.net','amazonaws.com','akamai.net','akamaized.net',
    'fastly.com','cloudflare.com','jsdelivr.net','unpkg.com',
    'doubleclick.net','googletagmanager.com','googletagservices.com'
  ];
  
  // Direct match
  if (videoAdDomains.includes(hostHeader)) {
    return { match: true, type: 'direct' };
  }
  
  // Check for subdomain matches
  for (const domain of videoAdDomains) {
    if (hostHeader.endsWith('.' + domain) || hostHeader === domain) {
      return { match: true, type: 'subdomain', domain };
    }
    if (domain.includes('googlevideo.com') && /^r\d+---sn-[^.]+\.googlevideo\.com$/i.test(hostHeader)) {
      return { match: true, type: 'google-video-cdn' };
    }
  }
  
  // Special patterns
  if (/^.*\.google(apis|usercontent|video|syndication)\.com$/i.test(hostHeader) ||
      /^.*\.gvt[0-9]\.com$/i.test(hostHeader) ||
      /^.*\.youtube(-nocookie)?\.com$/i.test(hostHeader) ||
      /^.*\.ytimg\.com$/i.test(hostHeader)) {
    return { match: true, type: 'google-regex-pattern' };
  }
  
  // Emergency fallback
  if (hostHeader.includes('video') || hostHeader.includes('cdn') || hostHeader.includes('stream') || 
      hostHeader.includes('media') || hostHeader.includes('content') || hostHeader.includes('youtube') ||
      hostHeader.includes('googlevideo') || hostHeader.includes('vimeo') || hostHeader.includes('facebook')) {
    return { match: true, type: 'emergency-video-fallback' };
  }
  
  return { match: false };
}

testDomains.forEach(domain => {
  const result = testIsVideoAdCDN(domain);
  console.log(`${domain}: ${result.match ? 'ALLOWED' : 'BLOCKED'} (${result.type || 'no match'})`);
});

console.log('\nAll test domains should show as ALLOWED for video proxy to work properly.');
