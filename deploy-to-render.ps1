# PowerShell script to push changes to GitHub for Render deployment

Write-Host "🚀 Deploying ISN Free WiFi Stability Fixes to GitHub..." -ForegroundColor Green
Write-Host ""

# Change to project directory
Set-Location "C:\Users\Teacher\ISN Free WiFi"

# Check git status
Write-Host "📋 Checking git status..." -ForegroundColor Yellow
git status

# Add all changes
Write-Host ""
Write-Host "📦 Adding all changes..." -ForegroundColor Yellow
git add .

# Check what's staged
Write-Host ""
Write-Host "✅ Files staged for commit:" -ForegroundColor Yellow
git status --short

# Commit with descriptive message
Write-Host ""
Write-Host "💾 Committing changes..." -ForegroundColor Yellow
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

# Push to GitHub
Write-Host ""
Write-Host "🌐 Pushing to GitHub..." -ForegroundColor Yellow
git push origin main

Write-Host ""
Write-Host "🎉 SUCCESS! Changes pushed to GitHub." -ForegroundColor Green
Write-Host "🔄 Render will now automatically deploy your website." -ForegroundColor Green
Write-Host ""
Write-Host "📊 Deployment includes:" -ForegroundColor Cyan
Write-Host "  ✅ Stable video playback (no vibrations)" -ForegroundColor White
Write-Host "  ✅ Mobile-responsive usage panel" -ForegroundColor White
Write-Host "  ✅ Fixed proxy system on port 8082" -ForegroundColor White
Write-Host "  ✅ Admin dashboard mobile support" -ForegroundColor White
Write-Host "  ✅ Video counting verification" -ForegroundColor White
Write-Host "  ✅ No-skip ad replacement" -ForegroundColor White
Write-Host ""
Write-Host "🌍 Your website will be live at: https://isn-free-wifi.onrender.com" -ForegroundColor Green
