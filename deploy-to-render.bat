@echo off
echo 🚀 Deploying ISN Free WiFi Stability Fixes to GitHub...
echo.

cd /d "C:\Users\Teacher\ISN Free WiFi"

echo 📋 Checking git status...
git status
echo.

echo 📦 Adding all changes...
git add .
echo.

echo ✅ Files staged for commit:
git status --short
echo.

echo 💾 Committing changes...
git commit -m "🎯 STABILITY FIXES: Video stabilization + Mobile-responsive Usage panel

✅ Fixed server.js duplicate PROXY_PORT error
✅ Enhanced video stability (YouTube/Facebook/Spotify style)  
✅ Mobile-responsive My Usage panel for phones & desktops
✅ Stable admin dashboard tables with smart column hiding
✅ Comprehensive proxy system for unrestricted ad access
✅ Video counting verification (100MB=5, 250MB=10, 500MB=15)
✅ No-skip ad replacement system with fallbacks
✅ Hardware acceleration optimizations
✅ Layout containment for performance
✅ Smooth transitions and interactions

Ready for production deployment via Render! 🚀"

echo.
echo 🌐 Pushing to GitHub...
git push origin main

echo.
echo 🎉 SUCCESS! Changes pushed to GitHub.
echo 🔄 Render will now automatically deploy your website.
echo.
echo 📊 Deployment includes:
echo   ✅ Stable video playback (no vibrations)
echo   ✅ Mobile-responsive usage panel
echo   ✅ Fixed proxy system on port 8082
echo   ✅ Admin dashboard mobile support
echo   ✅ Video counting verification
echo   ✅ No-skip ad replacement
echo.
echo 🌍 Your website will be live at: https://isn-free-wifi.onrender.com
pause
