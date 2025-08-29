// Test script to verify the new data bundle and video tracking system
const axios = require('axios');

const baseURL = 'http://10.5.48.94:3150';
const testUser = 'sbusisosweetwell15@gmail.com';

async function testVideoEarningSystem() {
  try {
    console.log('🎬 Testing Video-Based Data Earning System\n');
    
    // 1. Check initial usage (should show 0 videos, 0 data, needs unlock)
    console.log('1. Checking initial usage...');
    const initialUsage = await axios.get(`${baseURL}/api/me/usage?identifier=${testUser}`);
    console.log('Initial state:', {
      videosWatched: initialUsage.data.videosWatched,
      videoEarnedMB: initialUsage.data.videoEarnedMB,
      remainingMB: initialUsage.data.remainingMB,
      needsVideoUnlock: initialUsage.data.needsVideoUnlock
    });
    
    // 2. Simulate watching first video (should unlock social media)
    console.log('\n2. Simulating first video completion...');
    const firstVideo = await axios.post(`${baseURL}/api/video/complete`, {
      identifier: testUser,
      videoUrl: 'https://example.com/video1.mp4',
      duration: 45,
      deviceId: 'test-device-123'
    });
    console.log('First video result:', firstVideo.data);
    
    // 3. Check usage after first video
    console.log('\n3. Checking usage after first video...');
    const afterFirstVideo = await axios.get(`${baseURL}/api/me/usage?identifier=${testUser}`);
    console.log('After first video:', {
      videosWatched: afterFirstVideo.data.videosWatched,
      videoEarnedMB: afterFirstVideo.data.videoEarnedMB,
      remainingMB: afterFirstVideo.data.remainingMB,
      needsVideoUnlock: afterFirstVideo.data.needsVideoUnlock,
      nextMilestone: afterFirstVideo.data.nextMilestone
    });
    
    // 4. Simulate watching 4 more videos to reach 5 total (100MB milestone)
    console.log('\n4. Simulating 4 more videos to reach 100MB milestone...');
    for (let i = 2; i <= 5; i++) {
      const video = await axios.post(`${baseURL}/api/video/complete`, {
        identifier: testUser,
        videoUrl: `https://example.com/video${i}.mp4`,
        duration: 50,
        deviceId: 'test-device-123'
      });
      console.log(`Video ${i}:`, video.data.milestone ? video.data.milestone.message : 'No milestone');
    }
    
    // 5. Check usage after 5 videos
    console.log('\n5. Checking usage after 5 videos...');
    const after5Videos = await axios.get(`${baseURL}/api/me/usage?identifier=${testUser}`);
    console.log('After 5 videos:', {
      videosWatched: after5Videos.data.videosWatched,
      videoEarnedMB: after5Videos.data.videoEarnedMB,
      remainingMB: after5Videos.data.remainingMB,
      breakdown: after5Videos.data.breakdown,
      nextMilestone: after5Videos.data.nextMilestone
    });
    
    console.log('\n✅ Video earning system test completed!');
    console.log('📊 Expected behavior:');
    console.log('- Users start with 0 data and need to watch videos');
    console.log('- First video unlocks social media + 20MB');
    console.log('- Progressive rewards: 5 videos = 100MB, 10 = 250MB, 15 = 500MB, 25 = 1GB');
    console.log('- Data tracking works per device for strict isolation');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testVideoEarningSystem();
