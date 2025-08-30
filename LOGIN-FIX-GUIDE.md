# 🚨 LOGIN & PROXY CONFIGURATION GUIDE

## Problem: Users cannot login - "Login failed" error + Proxy Issues

## ✅ SOLUTIONS:

### 1. **CORRECT URL** 
❌ Wrong: `http://10.5.48.94:3150/login.html`
✅ Correct: `http://10.5.48.94:3151/login.html`

**The server is running on port 3151, not 3150!**

### 2. **TEST USER CREDENTIALS**
Use these credentials to test login:

📧 **Email:** `test@test.com`
🔑 **Password:** `<redacted-example-password>`

### 3. **ADMIN CREDENTIALS**
For admin access:

📧 **Email:** `admin@isn.co.za`  
🔑 **Password:** `<redacted-example-password>`

## 🌐 PROXY CONFIGURATION

### **🔧 MANUAL PROXY SETTINGS**
For users who want to configure proxy manually:

**HTTP Proxy:** `10.5.48.94:9092`
**HTTPS Proxy:** `10.5.48.94:9092`
**Port:** `9092`

**Instructions for users:**
1. Go to Network Settings → Proxy Settings
2. Enable "Manual proxy configuration"
3. Set HTTP Proxy: `10.5.48.94:9092`
4. Set HTTPS Proxy: `10.5.48.94:9092`
5. Save and restart browser

### **🤖 AUTO PROXY (PAC) SETTINGS**
For automatic proxy configuration:

**PAC URL:** `http://10.5.48.94:3151/proxy.pac`

**Instructions for users:**
1. Go to Network Settings → Proxy Settings
2. Enable "Automatic proxy configuration"
3. Set Configuration URL: `http://10.5.48.94:3151/proxy.pac`
4. Save and restart browser

## 🚫 PROXY RESTRICTIONS FIXED

### **✅ MANUAL PROXY USERS:**
- Must **LOGIN** first to access any websites
- After login, get normal internet access
- Blocked until authentication

### **✅ AUTO PROXY (PAC) USERS:**
- Must **WATCH VIDEOS** first to earn data bundles
- Bundle system: 5 videos = 100MB, 10 videos = 250MB, 15 videos = 500MB
- Completely blocked until videos watched

### **🔒 SECURITY IMPROVEMENTS:**
- ✅ Port -1 is now blocked (prevents system confusion)
- ✅ Enhanced proxy type detection
- ✅ Separate handling for Manual vs Auto proxy users
- ✅ HTTPS traffic properly blocked until authenticated
- ✅ Clear error messages showing proxy type and requirements

## 🔧 STEPS TO FIX:

1. **Make sure users access the correct URL:**
   ```
   http://10.5.48.94:3151/login.html
   ```

2. **Create test users by running this script:**
   ```bash
   node create-test-users.js
   ```

3. **Test login with:**
   - Email: test@test.com
   - Password: <redacted-example-password>

4. **Configure user devices with proper proxy settings:**
   - **Manual:** `10.5.48.94:9092`
   - **PAC URL:** `http://10.5.48.94:3151/proxy.pac`

## 🎯 ROOT CAUSES FIXED:

1. **✅ Wrong Port:** Server moved from 3150 to 3151 - Users need correct URL
2. **✅ No Users:** Database may be empty - Scripts created to add test accounts
3. **✅ Proxy Confusion:** Port -1 blocked, enhanced proxy type detection
4. **✅ Unauthorized Access:** Manual proxy users must login, Auto proxy users must watch videos
5. **✅ HTTPS Leakage:** All HTTPS traffic properly blocked until authorized

## 📊 SERVER STATUS:
- ✅ Server is running successfully on port 3151
- ✅ Proxy server running on port 9092
- ✅ PAC file available at http://10.5.48.94:3151/proxy.pac
- ✅ API endpoints are functional (/api/login works)
- ✅ Database file (logins.xlsx) exists
- ✅ Real-time bandwidth monitoring is active
- ✅ Enhanced proxy restrictions implemented

## 🧪 QUICK TEST:
To verify the fix works:

1. **Portal Access:**
   - Open: http://10.5.48.94:3151/login.html
   - Enter: test@test.com / <redacted-example-password>

Note: Example passwords have been redacted from this document for security; replace with your own test credentials when following steps.
   - Should redirect to home.html successfully

2. **Manual Proxy Test:**
   - Configure proxy: 10.5.48.94:9092
   - Try accessing any website → Should redirect to login
   - Login first → Then get internet access

3. **Auto Proxy Test:**
   - Configure PAC: http://10.5.48.94:3151/proxy.pac
   - Try accessing any website → Should redirect to video portal
   - Watch videos → Earn bundles → Get internet access

## 📞 TELL USERS:

### **For Login Issues:**
"Please use http://10.5.48.94:3151/login.html (note: port 3151, not 3150)"

### **For Manual Proxy Users:**
"Set your proxy to 10.5.48.94:9092 and login first at the portal"

### **For Auto Proxy Users:**
"Use PAC URL: http://10.5.48.94:3151/proxy.pac and watch videos to earn internet bundles"
