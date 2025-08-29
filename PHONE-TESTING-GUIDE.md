# 📱 PHONE TESTING GUIDE - Enhanced Device Isolation

## 🚀 SERVER STATUS: ACTIVE ✅

**Server IP**: `10.5.48.94:3150`  
**Enhanced Device Isolation**: ENABLED  
**User 0796694562**: Reset to 0MB (Perfect for testing)

## 📱 Phone Access URLs

### For Phone Testing:
- **Portal Home**: `http://10.5.48.94:3150/home.html`
- **Login/Register**: `http://10.5.48.94:3150/login.html`  
- **Admin Dashboard**: `http://10.5.48.94:3150/admin-dashboard.html`

## 🧪 Testing Configuration Active

```bash
✅ STRICT_DEVICE_ISOLATION=true    # Each device must earn own access
✅ MAC_BINDING_ENABLED=true        # Access tied to device hardware  
❌ ROUTER_DEVICE_BLOCKING=false    # Multiple devices can be active (easier testing)
✅ PROXY_DEBUG=true               # Detailed logging for troubleshooting
```

## 🎯 Expected Test Results

### Test 1: User 0796694562 First Phone Access
1. **Connect phone to WiFi**: ISN Free WiFi network
2. **Try to browse internet**: Should be BLOCKED
3. **Access portal**: `http://10.5.48.94:3150/home.html` (should work)
4. **Login with**: `0796694562` 
5. **Check "My Usage"**: Should show 0MB available
6. **Try internet again**: Still blocked (no data)

### Test 2: Video Watching on First Phone
1. **Watch 5 videos** on the first phone
2. **Check "My Usage"**: Should show 100MB available
3. **Try internet browsing**: Should work! ✅
4. **Verify device isolation**: Other devices still blocked

### Test 3: Second Phone/Device
1. **Connect second phone** to same WiFi
2. **Try to browse internet**: Should be BLOCKED (no access from first phone)
3. **Access portal**: Should work
4. **Login with same number**: `0796694562`
5. **Check "My Usage"**: Should show 0MB (device-specific tracking)
6. **Must watch videos independently**: Each device earns its own access

## 🔍 What You Should See

### When Blocked (No Access):
```
🔒 Device Access Validation Required
Reason: No access token found for device

This device needs to validate its access rights.
Each device must earn its own internet access by watching videos.

✅ Videos watched on THIS device unlock access for THIS device
❌ Videos watched on OTHER devices do NOT unlock access for THIS device
```

### After Earning Access:
- Internet browsing works normally
- "My Usage" shows available data
- Other devices still need to earn their own access

## 📊 Admin Monitoring

You can monitor the testing in real-time:
- **Live Dashboard**: `http://10.5.48.94:3150/admin-dashboard.html`
- **Device Status**: Check which devices have access tokens
- **Video Events**: See when videos are watched per device
- **Data Usage**: Track per-device data consumption

## 🛠️ Troubleshooting

### If Phone Can't Access Portal:
- Check WiFi connection to ISN Free WiFi
- Try: `http://10.5.48.94:3150/login.html`
- Verify server is running (it is ✅)

### If Internet Still Doesn't Work After Videos:
- Check "My Usage" shows available data
- Try different websites
- Check admin dashboard for device status
- Look at server logs for debug info

### If Videos Don't Load:
- Portal access should work for video ads
- Video CDNs are whitelisted
- Try refreshing the page

## 🎉 Success Criteria

✅ **Device Isolation Working** if:
- First phone watches videos → gets internet access
- Second phone doesn't get "free" internet access  
- Each device must watch videos independently
- Admin can see separate device access tokens
- MAC addresses are properly detected and bound

## 📞 Test User Ready

**Phone Number**: `0796694562`  
**Current Data**: 0MB (perfect for testing)  
**Video History**: 171 videos (history preserved)  
**Bundle Status**: All exhausted (must re-earn)

---

**🚀 SERVER IS READY FOR PHONE TESTING!**  
**Connect your phones and test the enhanced per-device access control system.**
