# 🐛 Netflix Preview Troubleshooting Guide

## 📋 DEBUGGING STEPS

The Netflix preview has been updated with enhanced debugging. Here's how to troubleshoot:

## 🌐 **BROWSER CONSOLE DEBUGGING**

### **Step 1: Open Browser Console**
- **Chrome/Edge**: Press `F12` → Click "Console" tab
- **Firefox**: Press `F12` → Click "Console" tab  
- **Safari**: Press `Cmd+Option+I` → Click "Console" tab

### **Step 2: Load Home Page**
- Go to your ISN Free WiFi portal
- Watch console for Netflix preview logs

### **Step 3: Look for These Messages**
```
[NETFLIX-PREVIEW] Starting initialization...
[NETFLIX-PREVIEW] Elements found: {heroVideo: true, heroImage: true, heroVideoSource: true}
[NETFLIX-PREVIEW] Device detected: Mobile/Desktop - Initializing Netflix-style preview
[NETFLIX-PREVIEW] Scheduling preview in 4 seconds
[NETFLIX-PREVIEW] Timer fired - starting preview
[NETFLIX-PREVIEW] Getting random video...
[NETFLIX-PREVIEW] Selected random GOOGLE video 1/5: [URL]
```

## 🔍 **MANUAL TESTING FUNCTIONS**

### **Test Netflix Preview Manually**
In browser console, type:
```javascript
window.testNetflixPreview()
```
This will manually trigger the Netflix preview

### **Get Debug Information**  
In browser console, type:
```javascript
window.debugNetflixPreview()
```
This shows detailed debug info about all components

## 🚨 **COMMON ISSUES & SOLUTIONS**

### **Issue 1: "Required elements not found"**
**Problem**: HTML elements missing  
**Check**: Look for `heroVideo: false` in console  
**Solution**: Verify video element exists in hero-image section

### **Issue 2: "No videos available"**
**Problem**: Video arrays not loaded  
**Check**: Look for `mp4Ads: undefined` in debug info  
**Solution**: Video arrays might load after Netflix init - timing issue

### **Issue 3: Video loads but doesn't play**
**Problem**: Browser autoplay restrictions  
**Check**: Look for video play errors in console  
**Solution**: Try manual trigger with `window.testNetflixPreview()`

### **Issue 4: No console messages at all**
**Problem**: Netflix init not running  
**Check**: JavaScript errors preventing initialization  
**Solution**: Look for JavaScript errors in console

## 📱🖥️ **DEVICE-SPECIFIC TESTING**

### **Mobile Testing**
1. Open site on phone
2. Open mobile browser dev tools (Chrome mobile)
3. Look for `Device detected: Mobile` message
4. Should use 2 Google CDN videos

### **Desktop Testing**  
1. Open site on desktop
2. Open browser console
3. Look for `Device detected: Desktop` message
4. Should use 5 Google CDN videos

## 🎬 **EXPECTED BEHAVIOR**

### **Normal Flow:**
1. Page loads → Static hero image visible
2. 4 seconds pass → Console shows timer fired
3. Video element fades in over image  
4. Video starts playing (muted, looped)
5. User interaction → Video stops

### **Console Log Flow:**
```
[NETFLIX-PREVIEW] Starting initialization...
[NETFLIX-PREVIEW] Elements found: {heroVideo: true, heroImage: true, heroVideoSource: true}
[NETFLIX-PREVIEW] Device detected: Desktop - Initializing Netflix-style preview
[NETFLIX-PREVIEW] Scheduling preview in 4 seconds
[NETFLIX-PREVIEW] Timer fired - starting preview
[NETFLIX-PREVIEW] Getting random video...
[NETFLIX-PREVIEW] Google videos filtered: 5 from 5
[NETFLIX-PREVIEW] Desktop - Selected random GOOGLE video 3/5: https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4
[NETFLIX-PREVIEW] Starting auto-play preview
```

## 🔧 **QUICK FIXES**

### **Force Restart Netflix Preview**
```javascript
// Stop any running preview
if (window.netflixVideoActive) window.stopNetflixPreview();

// Start fresh
setTimeout(() => window.testNetflixPreview(), 1000);
```

### **Check Video Array Access**
```javascript
// Check if video arrays are available
console.log('Video arrays check:', {
    mp4Ads: typeof mp4Ads !== 'undefined' ? mp4Ads.length : 'undefined',
    mobileMp4Ads: typeof mobileMp4Ads !== 'undefined' ? mobileMp4Ads.length : 'undefined',
    windowMp4Ads: window.mp4Ads ? window.mp4Ads.length : 'undefined',
    windowMobileMp4Ads: window.mobileMp4Ads ? window.mobileMp4Ads.length : 'undefined'
});
```

## 📊 **DEBUG OUTPUT EXAMPLE**

**Successful initialization should show:**
```
[NETFLIX-PREVIEW] Starting initialization...
[NETFLIX-PREVIEW] Elements found: {heroVideo: true, heroImage: true, heroVideoSource: true}
[NETFLIX-PREVIEW] Device detected: Desktop - Initializing Netflix-style preview
[NETFLIX-PREVIEW] Scheduling preview in 4 seconds
[NETFLIX-PREVIEW] Timer fired - starting preview
[NETFLIX-PREVIEW] Getting random video...
[NETFLIX-PREVIEW] Original video array length: 5
[NETFLIX-PREVIEW] Google videos filtered: 5 from 5
[NETFLIX-PREVIEW] Desktop - Selected random GOOGLE video 2/5: https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4
[NETFLIX-PREVIEW] Starting auto-play preview
```

---

## 🆘 **NEXT STEPS**

1. **Open browser console** and load the page
2. **Copy all Netflix-related console messages**
3. **Run `window.debugNetflixPreview()`** and copy output  
4. **Try `window.testNetflixPreview()`** to test manually

This will show exactly what's preventing the Netflix preview from working!
