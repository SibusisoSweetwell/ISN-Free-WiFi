#!/bin/bash
# Quick fix upload script
echo "Uploading fixed server.js with admin rate limit and video bundle fixes..."

# Note: Manual upload required due to proxy interference
# Upload the fixed server.js file to GitHub manually
# Changes made:
# 1. Increased admin rate limit from 5 to 100 requests per 15 minutes
# 2. Removed legacy 25MB override that was preventing proper 100MB bundle grants
# 3. Video system now properly grants: 5 videos = 100MB, 10 videos = 250MB, 15 videos = 500MB

echo "FIXES APPLIED:"
echo "✅ Admin rate limit: 5 → 100 requests (fixes HTTP 429 error)"
echo "✅ Removed 25MB legacy override (fixes video bundle system)"
echo "✅ Proper video bundles: 5=100MB, 10=250MB, 15=500MB"
echo ""
echo "MANUAL UPLOAD REQUIRED:"
echo "1. Go to https://github.com/SibusisoSweetwell/ISN-Free-WiFi"
echo "2. Upload the fixed server.js file"
echo "3. Commit with message: 'Fix admin dashboard HTTP 429 and video bundle system'"
echo "4. Wait 2-3 minutes for Render deployment"
