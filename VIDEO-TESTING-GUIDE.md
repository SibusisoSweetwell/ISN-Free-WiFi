# Video Ads Testing Guide for ISN Free WiFi Portal

## Current Status ✅
- **Portal Server**: Running on port 3150
- **Proxy Server**: Running on port 9092  
- **Video Sources**: Google Test Videos (15 MP4 files)
- **Video Domains**: Whitelisted in proxy (storage.googleapis.com, youtube.com)
- **Video Player**: HTML5 with comprehensive controls
- **Bundle System**: Active and responsive

## Video Configuration Details

### Video Sources
The system uses reliable Google Cloud Storage test videos:
- ForBiggerJoyrides.mp4
- ForBiggerFun.mp4  
- ForBiggerEscapes.mp4
- ForBiggerMeltdowns.mp4
- ForBiggerBlazes.mp4
- ForBiggerSavings.mp4
- ForBiggerSchools.mp4
- SubaruOutbackOnStreetAndDirt.mp4
- VolkswagenGTIReview.mp4
- WeAreGoingOnBullrun.mp4
- WhatCarCanYouGetForAGrand.mp4
- ElephantsDream.mp4
- Sintel.mp4
- TearsOfSteel.mp4
- BigBuckBunny.mp4

### Video Features
- **Autoplay**: Enabled (starts muted per browser policy)
- **Controls**: Play/pause, mute/unmute, fullscreen, skip
- **Progress**: Real-time progress bar
- **Skip Timer**: 10-second countdown before skip is enabled
- **Watch Validation**: Tracks watch time and completion
- **Wake Lock**: Prevents screen sleep during playback
- **Responsive**: Works on mobile and desktop
- **Fallbacks**: YouTube integration for additional sources

## Testing Instructions

### Step 1: Access Portal
1. Open browser and go to: `http://10.5.48.94:3150`
2. You should see the ISN Free WiFi homepage
3. Click "Get Connected" button

### Step 2: Login
1. Use any registered account or create new one
2. Example: email@example.com, password: <redacted-example-password>
3. Complete login process

### Step 3: Select Data Bundle
1. Choose a data bundle size:
   - 100 MB (5 videos)
   - 250 MB (10 videos)  
   - 500 MB (15 videos)
2. Click on your chosen bundle

### Step 4: Video Playback Test
1. **First Video Should**:
   - Load automatically
   - Start playing (muted initially)
   - Show loading indicator briefly
   - Display video content clearly
   - Show ad sequence (e.g., "Ad 1 / 5")

2. **Controls Should Work**:
   - Mute/Unmute button toggles audio
   - Play/Pause button controls playback
   - Fullscreen button expands video
   - Skip button appears after 10 seconds

3. **Progress Should**:
   - Show real-time progress bar
   - Update smoothly during playback
   - Reset for each new video

### Step 5: Sequence Completion
1. **Between Videos**:
   - Should advance automatically when video ends
   - Or when skip button is clicked
   - Show next video in sequence
   - Update ad counter (Ad 2 / 5, etc.)

2. **After All Videos**:
   - Should show "Granting X MB..." message
   - Complete bundle activation
   - Show success message
   - Close video modal

### Step 6: Verify Data Access
1. Check that internet access is granted
2. Try browsing different websites
3. Verify proxy is working correctly

## Troubleshooting

### If Videos Don't Load:
- Check browser console for JavaScript errors
- Verify network connectivity to storage.googleapis.com
- Test with different browser (Chrome recommended)
- Disable ad blockers or extensions
- Clear browser cache and cookies

### If Videos Load But Don't Play:
- Click the play button manually
- Check if browser autoplay is blocked
- Ensure audio is not muted at system level
- Try fullscreen mode
- Refresh the page and retry

### If Videos Play But Bundle Doesn't Grant:
- Ensure you watched sufficient duration (80% minimum)
- Check that all videos in sequence completed
- Verify network connection during grant process
- Check browser console for API errors

### If Proxy Issues Occur:
- Verify proxy settings: 10.5.48.94:9092
- Check PAC file: http://10.5.48.94:3150/proxy.pac
- Ensure storage.googleapis.com is accessible
- Test direct video URL access

## Expected Behavior Summary

✅ **Videos should autoplay with muted audio**
✅ **User can unmute and control playback**  
✅ **Skip button enables after 10 seconds**
✅ **Progress bar shows real-time updates**
✅ **Sequence advances automatically or on skip**
✅ **Bundle grants after watching required videos**
✅ **Internet access activates successfully**

## Technical Notes

- Videos are served from Google Cloud Storage (reliable CDN)
- MP4 format ensures broad browser compatibility
- HTML5 video player with JavaScript controls
- Wake lock prevents screen sleep during ads
- Comprehensive error handling and fallbacks
- Real-time bandwidth monitoring active

## Support

If videos still don't work after following this guide:
1. Check server logs for errors
2. Verify firewall settings allow video domains
3. Test on different devices/networks
4. Consider adding more video sources
5. Check browser compatibility (Chrome/Firefox recommended)

The video ads system is properly configured and should work correctly when accessed through the portal!
