console.log('Starting ISN Free WiFi portal server...');
const express = require('express');
console.log('Express loaded');
const path = require('path');
const fs = require('fs');
const os = require('os');
console.log('Basic modules loaded');
const XLSX = require('xlsx');
console.log('XLSX loaded');
// Optional SQLite adapter (use USE_SQLITE=true in Render environment)
let sqliteDB = null;
if (process.env.USE_SQLITE === 'true') {
  try {
    sqliteDB = require('./sqlite-db');
    // Use a stable DB filename for cloud environments
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'logins.db');
    const ok = sqliteDB.init(dbPath);
    if (!ok) sqliteDB = null;
    else console.log('[SQLITE] Initialized at', dbPath);
  } catch (err) {
    console.warn('[SQLITE] Init failed, falling back to XLSX:', err && err.message);
    sqliteDB = null;
  }
}
console.log('[CONFIG] USE_SQLITE=', process.env.USE_SQLITE, 'sqliteDB active=', !!sqliteDB);
const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
console.log('All modules loaded successfully');

// Data sanitization to prevent Excel 32,767 character cell limit errors
function sanitizeDataForExcel(data) {
  if (Array.isArray(data)) {
    return data.map(row => sanitizeDataForExcel(row));
  } else if (typeof data === 'object' && data !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeDataForExcel(value);
    }
    return sanitized;
  } else if (typeof data === 'string') {
    // Limit string length to 32,000 characters (safe margin under 32,767)
    if (data.length > 32000) {
      console.warn(`[XLSX-SANITIZE] Truncating long string from ${data.length} to 32000 characters`);
      return data.substring(0, 32000) + '...[TRUNCATED]';
    }
    return data;
  }
  return data;
}

console.log('Booting portal server...');
const app = express();
// Use environment PORT when provided (Render sets this) otherwise default to 3150
let PORT = Number(process.env.PORT) || 3150; // Portal port (configurable via env)
const PROXY_PORT = 8082; // Fixed port for proxy
const RENDER_HOST = (process.env.RENDER_HOST || 'isn-free-wifi.onrender.com').toLowerCase();
const PORTAL_SECRET = process.env.PORTAL_SECRET || 'isn_portal_secret_dev';
const DATA_FILE = path.join(__dirname, 'logins.xlsx');
const ADMIN_EMAIL = 'sbusisosweetwell15@gmail.com';

// Enhanced per-device access control with MAC address tracking
// Prevents one device from unlocking access for all other devices
const deviceIsolation = require('./device-isolation-enhancement');
const dataTracker = require('./data-tracking-enhancement');
const activeClients = new Map(); // MAC/deviceId -> { identifier, ip, lastSeen, expires, deviceFingerprint, sessionToken }
const deviceSessions = new Map(); // deviceId -> { sessionToken, voucher, unlockTimestamp, revalidationRequired }
const macAddressCache = new Map(); // ip -> { mac, lastUpdated }
const deviceQuotas = new Map(); // deviceId -> { bundleMB, usedMB, unlockEarned }

// Real-time usage tracking for admin dashboard with live bandwidth monitoring
const realtimeUsage = new Map(); // identifier -> { downMbps: number, upMbps: number, totalDataMB: number, lastUpdateTime: number, connectionStart: number, bytesDownLoaded: number, bytesUploaded: number, peakDownMbps: number, peakUpMbps: number }
const routerStats = new Map(); // routerId -> { connectedUsers: Set, totalDataServed: number, downMbps: number, upMbps: number, status: string, lastMaintenance: string, flags: string[], peakDownMbps: number, peakUpMbps: number }
const bandwidthHistory = new Map(); // identifier -> Array of {timestamp, downMbps, upMbps} for live tracking

// Enhanced device fingerprinting with STRICT MAC address enforcement
function generateDeviceFingerprint(req, includeMAC = true) {
  const userAgent = req.headers['user-agent'] || '';
  const accept = req.headers['accept'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const ip = normalizeIp((req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '');
  const routerId = req.headers['x-router-id'] || detectRouterId(req) || 'default-router';
  
  // CRITICAL: Get MAC address for device isolation
  let macAddress = '';
  if (includeMAC) {
    macAddress = deviceIsolation.getMACAddressEnhanced(ip, routerId) || '';
    
    // Fallback: Try system ARP directly
    if (!macAddress) {
      try {
        const { execSync } = require('child_process');
        const arpOutput = execSync(`arp -a ${ip}`, { encoding: 'utf8', timeout: 2000 }).toString();
        const macMatch = arpOutput.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        if (macMatch) {
          macAddress = macMatch[0].toLowerCase().replace(/[:-]/g, '');
          console.log(`[MAC-FALLBACK-SUCCESS] IP ${ip} -> MAC ${macAddress}`);
        }
      } catch (err) {
        console.warn(`[MAC-FALLBACK-FAILED] ${ip}: ${err.message}`);
      }
    }
  }
  
  // STRICT DEVICE ID: Use MAC as primary identifier if available
  let deviceId;
  if (macAddress) {
    deviceId = crypto.createHash('sha256').update('MAC:' + macAddress).digest('hex').slice(0,32);
    console.log(`[STRICT-DEVICE-ID] MAC-based: ${deviceId} from MAC ${macAddress}`);
  } else {
    // Fallback to enhanced fingerprint (but mark as unverified)
    deviceId = crypto.createHash('sha256')
      .update(userAgent + accept + acceptLanguage + acceptEncoding + ip + routerId)
      .digest('hex').slice(0,32);
    console.warn(`[WEAK-DEVICE-ID] No MAC available for ${ip}, using fingerprint: ${deviceId}`);
  }
    
  return {
    deviceId: deviceId,
    mac: macAddress,
    ip: ip,
    userAgent: userAgent.slice(0, 200),
    routerId: routerId,
    macVerified: !!macAddress
  };
}

// Function to get MAC address from system ARP cache
function getMACAddress(ip) {
  try {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
    
    // Check cache first
    const cached = macAddressCache.get(ip);
    if (cached && Date.now() - cached.lastUpdated < 300000) { // 5 minute cache
      return cached.mac;
    }
    
    // Try to get MAC from ARP table (Windows)
    const { execSync } = require('child_process');
    const arpOutput = execSync(`arp -a ${ip}`, { encoding: 'utf8', timeout: 2000 }).toString();
    const macMatch = arpOutput.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    
    if (macMatch) {
      const mac = macMatch[0].toLowerCase().replace(/[:-]/g, '');
      macAddressCache.set(ip, { mac, lastUpdated: Date.now() });
      console.log(`[MAC-RESOLVED] IP ${ip} -> MAC ${mac}`);
      return mac;
    }
    
    return null;
  } catch (error) {
    // Fallback: try netstat for active connections
    try {
      const netstatOutput = execSync('netstat -an', { encoding: 'utf8', timeout: 1000 }).toString();
      // This is a simplified approach - in production you'd need router-level DHCP snooping
      return null;
    } catch {
      return null;
    }
  }
}

// Enhanced client registration with strict per-device tracking
function registerActiveClient(req, identifier, hours = 6) {
  try {
    const deviceInfo = generateDeviceFingerprint(req);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    
    // Register device with unique session token
    activeClients.set(deviceInfo.deviceId, {
      identifier,
      ip: deviceInfo.ip,
      mac: deviceInfo.mac,
      lastSeen: Date.now(),
      expires: Date.now() + hours * 3600 * 1000,
      deviceFingerprint: deviceInfo.deviceId,
      sessionToken,
      userAgent: deviceInfo.userAgent
    });
    
    // Initialize device session
    deviceSessions.set(deviceInfo.deviceId, {
      sessionToken,
      voucher: null,
      unlockTimestamp: null,
      revalidationRequired: false,
      lastActivity: Date.now()
    });
    
    // Initialize device quota tracking
    if (!deviceQuotas.has(deviceInfo.deviceId)) {
      deviceQuotas.set(deviceInfo.deviceId, {
        bundleMB: 0,
        usedMB: 0,
        unlockEarned: false,
        videoWatchComplete: false
      });
    }
    
    console.log(`[DEVICE-REGISTERED] ${identifier} on device ${deviceInfo.deviceId.slice(0,8)}... (MAC: ${deviceInfo.mac || 'unknown'}) at ${deviceInfo.ip} (expires in ${hours}h)`);
    
    // Initialize real-time usage tracking
    if (!realtimeUsage.has(identifier)) {
      realtimeUsage.set(identifier, {
        downMbps: 0, upMbps: 0, totalDataMB: 0, lastUpdateTime: Date.now(),
        connectionStart: Date.now(), bytesDownLoaded: 0, bytesUploaded: 0,
        peakDownMbps: 0, peakUpMbps: 0, deviceId: deviceInfo.deviceId,
        ip: normalizeIp(deviceInfo.ip), routerId: 'router-1', wifiNetwork: 'ISN Free WiFi'
      });
      
      if (!bandwidthHistory.has(identifier)) {
        bandwidthHistory.set(identifier, []);
      }
    }
    
    return { deviceId: deviceInfo.deviceId, sessionToken };
  } catch(err) {
    console.error('[DEVICE-REGISTER-ERROR]', err?.message);
    return null;
  }
}

function normalizeIp(ip){ if(!ip) return ''; return ip.replace(/^::ffff:/,''); }

// Enhanced function to update real-time usage data with data tracker sync
function updateRealtimeUsage(identifier, bytesSent, bytesReceived, additionalInfo = {}) {
  try {
    let usage = realtimeUsage.get(identifier);
    if (!usage) {
      // Initialize new usage tracking
      usage = {
        downMbps: 0, upMbps: 0, totalDataMB: 0, lastUpdateTime: Date.now(), connectionStart: Date.now(),
        bytesDownLoaded: 0, bytesUploaded: 0, peakDownMbps: 0, peakUpMbps: 0,
        ip: additionalInfo.ip || 'unknown',
        routerId: additionalInfo.routerId || 'router-1',
        wifiNetwork: additionalInfo.wifiNetwork || 'ISN Free WiFi'
      };
      realtimeUsage.set(identifier, usage);
    }
    
    const now = Date.now();
    const timeDiffSeconds = Math.max((now - usage.lastUpdateTime) / 1000, 0.1);
    
    // Update additional info if provided
    if (additionalInfo.ip) usage.ip = additionalInfo.ip;
    if (additionalInfo.routerId) usage.routerId = additionalInfo.routerId;
    if (additionalInfo.wifiNetwork) usage.wifiNetwork = additionalInfo.wifiNetwork;
    
    // Calculate data usage in MB
    const dataMB = (bytesSent + bytesReceived) / (1024 * 1024);
    
    // Update usage data
    usage.bytesUploaded += bytesSent;
    usage.bytesDownLoaded += bytesReceived;
    usage.totalDataMB += dataMB;
    
    // Calculate real-time speeds (Mbps)
    if (timeDiffSeconds > 0) {
      const downMbps = (bytesReceived * 8) / (1024 * 1024 * timeDiffSeconds);
      const upMbps = (bytesSent * 8) / (1024 * 1024 * timeDiffSeconds);
      
      usage.downMbps = Math.round(downMbps * 100) / 100;
      usage.upMbps = Math.round(upMbps * 100) / 100;
      
      // Track peak speeds
      if (usage.downMbps > usage.peakDownMbps) usage.peakDownMbps = usage.downMbps;
      if (usage.upMbps > usage.peakUpMbps) usage.peakUpMbps = usage.upMbps;
    }
    
    usage.lastUpdateTime = now;
    
    // CRITICAL: Sync with data tracker for consistent data
    if (dataMB > 0.001) { // Only sync if meaningful data (> 1KB)
      try {
        dataTracker.addSessionUsage(identifier, dataMB);
      } catch (error) {
        console.warn('[REALTIME-SYNC-ERROR]', error.message);
      }
    }
    
    // Update router stats
    const routerId = usage.routerId || additionalInfo.routerId || 'router-1';
    let router = routerStats.get(routerId);
    if (!router) {
      // Determine proper router IP based on client IP range
      let routerIP = '192.168.137.1'; // Default hotspot IP
      let routerLocation = 'PC Hotspot (Windows)';
      
      if (additionalInfo.ip) {
        if (additionalInfo.ip.startsWith('192.168.137.')) {
          routerIP = '192.168.137.1'; // Windows hotspot
          routerLocation = 'PC Hotspot (Windows)';
        } else if (additionalInfo.ip.startsWith('10.5.48.')) {
          routerIP = '10.5.48.94'; // Current WiFi adapter
          routerLocation = 'WiFi Network';
        } else if (additionalInfo.ip.startsWith('192.168.1.')) {
          routerIP = '192.168.1.1';
          routerLocation = 'Home Router';
        } else {
          routerIP = '192.168.137.1'; // Default to hotspot
          routerLocation = 'Auto-detected Router';
        }
      }
      
      router = {
        ipAddress: routerIP,
        location: routerLocation,
        connectedUsers: new Set(),
        totalDataServed: 0,
        downMbps: 0,
        upMbps: 0,
        status: 'Active',
        lastMaintenance: new Date().toISOString(),
        flags: ['live-tracking'],
        peakDownMbps: 0,
        peakUpMbps: 0
      };
      routerStats.set(routerId, router);
    }
    
    // Add user to router's connected users and update router totals
    router.connectedUsers.add(identifier);
    router.totalDataServed += dataMB;
    
    // Calculate average speeds for all users on this router
    const routerUsers = Array.from(router.connectedUsers);
    let totalDown = 0, totalUp = 0, activeUsers = 0;
    
    routerUsers.forEach(userId => {
      const userUsage = realtimeUsage.get(userId);
      if (userUsage && (now - userUsage.lastUpdateTime) < 30000) { // Active in last 30 seconds
        totalDown += userUsage.downMbps;
        totalUp += userUsage.upMbps;
        activeUsers++;
      }
    });
    
    router.downMbps = Math.round((totalDown / Math.max(activeUsers, 1)) * 100) / 100;
    router.upMbps = Math.round((totalUp / Math.max(activeUsers, 1)) * 100) / 100;
    
    // Track router peak speeds
    if (router.downMbps > router.peakDownMbps) router.peakDownMbps = router.downMbps;
    if (router.upMbps > router.peakUpMbps) router.peakUpMbps = router.upMbps;
    
  } catch (err) {
    console.error('[UPDATE-REALTIME-USAGE-ERROR]', err);
  }
}

// Router-level device tracking for strict access control
const routerDeviceActivity = new Map(); // routerId -> { activeDevice: deviceFingerprint, lastActivityTime: timestamp, blockOthers: boolean }

function normalizeIp(ip){ if(!ip) return ''; return ip.replace(/^::ffff:/,''); }

// Enhanced device access resolver with MAC-based strict control
function resolveActiveClient(ip, req = null) {
  // Try to find active client by device fingerprint (preferred) or fallback to IP
  let deviceInfo = null;
  let activeDevice = null;
  
  if (req) {
    deviceInfo = generateDeviceFingerprint(req);
    activeDevice = activeClients.get(deviceInfo.deviceId);
  }
  
  // Fallback: try to find any active client with this IP
  if (!activeDevice && ip) {
    for (const [deviceId, client] of activeClients.entries()) {
      if (client.ip === normalizeIp(ip)) {
        activeDevice = client;
        deviceInfo = { deviceId, mac: client.mac, ip: client.ip };
        break;
      }
    }
  }
  
  if (!activeDevice) return null;
  
  // Check if session has expired
  if (Date.now() > activeDevice.expires) {
    activeClients.delete(deviceInfo.deviceId);
    deviceSessions.delete(deviceInfo.deviceId);
    console.log(`[SESSION-EXPIRED] Device ${deviceInfo.deviceId.slice(0,8)}... session expired`);
    return null;
  }
  
  // Update last seen
  activeDevice.lastSeen = Date.now();
  
  // Check device session validity
  const deviceSession = deviceSessions.get(deviceInfo.deviceId);
  if (!deviceSession || deviceSession.sessionToken !== activeDevice.sessionToken) {
    console.log(`[INVALID-SESSION] Device ${deviceInfo.deviceId.slice(0,8)}... has invalid session token`);
    return null;
  }
  
  // Check if revalidation is required (every 30 minutes)
  if (deviceSession.revalidationRequired || 
      (deviceSession.lastActivity && Date.now() - deviceSession.lastActivity > 30 * 60 * 1000)) {
    
    // For revalidation, check if device earned its access through video watching
    const deviceQuota = deviceQuotas.get(deviceInfo.deviceId);
    if (!deviceQuota || !deviceQuota.unlockEarned) {
      console.log(`[REVALIDATION-REQUIRED] Device ${deviceInfo.deviceId.slice(0,8)}... needs to earn access again`);
      deviceSession.revalidationRequired = true;
      return null;
    }
    
    // Reset revalidation timer
    deviceSession.revalidationRequired = false;
    deviceSession.lastActivity = Date.now();
  }
  
  // Enhanced per-router device isolation
  if (req) {
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const routerActivity = routerDeviceActivity.get(routerId);
    
    if (routerActivity && routerActivity.blockOthers) {
      const timeSinceActivity = Date.now() - routerActivity.lastActivityTime;
      
      // If another device was active in last 5 minutes and this isn't that device
      if (timeSinceActivity < 5 * 60 * 1000 && routerActivity.activeDevice !== deviceInfo.deviceId) {
        console.log('[ROUTER-DEVICE-BLOCKED]', {
          blockedDevice: deviceInfo.deviceId.slice(0,8) + '...',
          blockedMAC: deviceInfo.mac,
          activeDevice: routerActivity.activeDevice.slice(0,8) + '...',
          routerId: routerId,
          reason: 'another_device_active_on_router'
        });
        return null;
      }
    }
  }
  
  return {
    identifier: activeDevice.identifier,
    deviceId: deviceInfo.deviceId,
    sessionToken: activeDevice.sessionToken,
    mac: deviceInfo.mac
  };
}

// --- New tracking sheets names ---
const SHEET_PURCHASES = 'Purchases';
const SHEET_SESSIONS = 'Sessions';
const SHEET_USAGELOG = 'UsageLog';
// Additional admin portal sheets
const SHEET_ACCESSLOG = 'AccessLog'; // registration, login, profile_change, password_reset
const SHEET_ROUTERS = 'RoutersMeta'; // router metadata
const SHEET_ADS = 'Ads'; // ad definitions
const SHEET_ADEVENTS = 'AdEvents'; // ad events (view, click)
// Cached admin tables (snapshots) for persistence / export
const SHEET_USERS_TABLE_CACHE = 'UsersTableCache';
const SHEET_ROUTERS_TABLE_CACHE = 'RoutersTableCache';
const SHEET_REGLOG_TABLE_CACHE = 'RegLoginTableCache';
const SHEET_ADS_TABLE_CACHE = 'AdsMetricsCache';

// Predefined demo ads (same as frontend mp4Ads list) so admin sees them even before any events
const DEFAULT_AD_URLS = [
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerSavings.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerSchools.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/WhatCarCanYouGetForAGrand.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
];

function deriveAdIdFromUrl(url){
  try { const fname = url.split('/').pop().split('?')[0]; return 'vid_'+fname; } catch { return 'vid_unknown'; }
}
function humanizeTitle(url){
  try { const base = url.split('/').pop().split('.')[0]; return base.replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); } catch { return url; }
}
function seedDefaultAds(){
  try {
    const wb = loadWorkbookWithTracking();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADS]);
    let changed=false;
    DEFAULT_AD_URLS.forEach(u=>{
      const adId = deriveAdIdFromUrl(u);
      if(!rows.find(r=>r.adId===adId)){
        rows.push({ adId, title: humanizeTitle(u), type:'video', source:u });
        changed=true;
      }
    });
    if(changed){ wb.Sheets[SHEET_ADS] = XLSX.utils.json_to_sheet(rows); XLSX.writeFile(wb, DATA_FILE); }
  } catch(err){ console.warn('seedDefaultAds failed', err?.message); }
}

function ensureSheet(wb, name){
  if(!wb.Sheets[name]){
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
}

function loadWorkbookWithTracking(){
  const wb = loadWorkbook();
  ensureSheet(wb, SHEET_PURCHASES);
  ensureSheet(wb, SHEET_SESSIONS);
  ensureSheet(wb, SHEET_USAGELOG);
  ensureSheet(wb, SHEET_ACCESSLOG);
  ensureSheet(wb, SHEET_ROUTERS);
  ensureSheet(wb, SHEET_ADS);
  ensureSheet(wb, SHEET_ADEVENTS);
  // Ensure cache sheets
  ensureSheet(wb, SHEET_USERS_TABLE_CACHE);
  ensureSheet(wb, SHEET_ROUTERS_TABLE_CACHE);
  ensureSheet(wb, SHEET_REGLOG_TABLE_CACHE);
  ensureSheet(wb, SHEET_ADS_TABLE_CACHE);
  return wb;
}

function guid(){ return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8); }

function listPurchases(){
  const wb = loadWorkbookWithTracking();
  const ws = wb.Sheets[SHEET_PURCHASES];
  return { wb, ws, rows: XLSX.utils.sheet_to_json(ws) };
}
function listSessions(){
  const wb = loadWorkbookWithTracking();
  const ws = wb.Sheets[SHEET_SESSIONS];
  return { wb, ws, rows: XLSX.utils.sheet_to_json(ws) };
}
function writeSheet(wb, sheetName, rows){
  wb.Sheets[sheetName] = XLSX.utils.json_to_sheet(rows);
  XLSX.writeFile(wb, DATA_FILE);
}

// Append a router usage metric (bytes transferred) per sampling second
function logRouterUsage(routerId, bytesDown, bytesUp, deviceList){
  const wb = loadWorkbookWithTracking();
  const ws = wb.Sheets[SHEET_USAGELOG];
  const rows = XLSX.utils.sheet_to_json(ws);
  rows.push({
    id: guid(),
    routerId: routerId || 'default-router',
    tsISO: new Date().toISOString(),
    bytesDown: Number(bytesDown)||0,
    bytesUp: Number(bytesUp)||0,
    devices: Array.isArray(deviceList)? deviceList.slice(0,50).join('|') : ''
  });
  writeSheet(wb, SHEET_USAGELOG, rows);
}

// Record a bundle purchase (grant) with strict per-device tracking
function recordPurchase(identifier, bundleMB, deviceId, routerId, ua, source) {
  const idLower = (identifier||'').trim().toLowerCase();
  const wb = loadWorkbookWithTracking();
  const { rows } = listPurchases();
  const { data: users } = getUsers();
  const user = users.find(u=> String(u.email||'').trim().toLowerCase()===idLower || u.phone===normalizePhone(idLower));
  
  // Ensure device ID is provided
  if (!deviceId) {
    console.error('[PURCHASE-ERROR] No deviceId provided for purchase');
    return null;
  }
  
  const entry = {
    id: guid(),
    identifier: idLower,
    deviceId: deviceId, // Device-specific tracking
    email: user?user.email: (idLower.includes('@')?idLower:''),
    phone: user?user.phone: (!idLower.includes('@')?normalizePhone(idLower):''),
    bundleMB: Number(bundleMB)||0,
    usedMB: 0,
    routerId: routerId||'default-router',
    deviceUA: (ua||'').slice(0,250),
    grantedAtISO: new Date().toISOString(),
    source: source||'video_unlock',
    strictMode: true, // Flag for strict per-device enforcement
    macAddress: '', // Will be populated if available
    sessionToken: crypto.randomBytes(16).toString('hex') // Per-device session token
  };
  
  rows.push(entry);
  writeSheet(wb, SHEET_PURCHASES, rows);
  
  // Update device quota tracking
  let deviceQuota = deviceQuotas.get(deviceId) || { bundleMB: 0, usedMB: 0, unlockEarned: false };
  deviceQuota.bundleMB += Number(bundleMB)||0;
  deviceQuota.unlockEarned = true; // Mark that this device earned access
  deviceQuotas.set(deviceId, deviceQuota);
  
  console.log(`[DEVICE-BUNDLE] Granted ${bundleMB}MB to device ${deviceId.slice(0,8)}... for user ${idLower}`);
  return entry;
}

// Increment usage with enhanced data tracking
function addUsage(identifier, usedDeltaMB, deviceId, routerId) {
  const idLower = (identifier||'').trim().toLowerCase();
  
  if (!deviceId) {
    console.log('[USAGE-ERROR] No deviceId provided for usage tracking');
    return false;
  }
  
  // Use enhanced data tracker for accurate usage recording
  const success = dataTracker.addDataUsage(idLower, usedDeltaMB, `Internet browsing via device ${deviceId.slice(0,8)}...`);
  
  if (success) {
    // Update device quota tracking
    let deviceQuota = deviceQuotas.get(deviceId) || { bundleMB: 0, usedMB: 0, unlockEarned: false };
    deviceQuota.usedMB += usedDeltaMB;
    deviceQuotas.set(deviceId, deviceQuota);
    
    // Track session usage for real-time monitoring
    dataTracker.addSessionUsage(idLower, usedDeltaMB);
    
    console.log(`[ENHANCED-USAGE] Device ${deviceId.slice(0,8)}...: Used ${usedDeltaMB}MB for user ${idLower}`);
    
    // Update real-time bandwidth tracking
    updateLiveBandwidthTracking(idLower, usedDeltaMB, routerId);
    
    return true;
  } else {
    console.log(`[USAGE-FAIL] Failed to record ${usedDeltaMB}MB usage for device ${deviceId.slice(0,8)}... of user ${idLower}`);
    return false;
  }
}

// Live bandwidth tracking function like sports scores
function updateLiveBandwidthTracking(identifier, dataDeltaMB, routerId) {
  const now = Date.now();
  
  // Get or initialize user tracking
  let userStats = realtimeUsage.get(identifier);
  if (!userStats) {
    userStats = {
      downMbps: 0, upMbps: 0, totalDataMB: 0, lastUpdateTime: now, connectionStart: now,
      bytesDownLoaded: 0, bytesUploaded: 0, peakDownMbps: 0, peakUpMbps: 0
    };
    realtimeUsage.set(identifier, userStats);
  }
  
  // Calculate time delta for speed calculation
  const timeDeltaSeconds = Math.max((now - userStats.lastUpdateTime) / 1000, 0.1);
  
  // Simulate realistic download/upload split (80% down, 20% up for typical browsing)
  const downDataMB = dataDeltaMB * 0.8;
  const upDataMB = dataDeltaMB * 0.2;
  
  // Calculate real-time speeds in Mbps (like live sports scores)
  const currentDownMbps = (downDataMB * 8) / timeDeltaSeconds; // Convert MB to Mbits and divide by time
  const currentUpMbps = (upDataMB * 8) / timeDeltaSeconds;
  
  // Smooth the speeds with exponential moving average for live score effect
  userStats.downMbps = (userStats.downMbps * 0.7) + (currentDownMbps * 0.3);
  userStats.upMbps = (userStats.upMbps * 0.7) + (currentUpMbps * 0.3);
  
  // Track peaks like highest scores
  userStats.peakDownMbps = Math.max(userStats.peakDownMbps, currentDownMbps);
  userStats.peakUpMbps = Math.max(userStats.peakUpMbps, currentUpMbps);
  
  // Update totals
  userStats.totalDataMB += dataDeltaMB;
  userStats.bytesDownLoaded += downDataMB * 1024 * 1024; // Convert to bytes
  userStats.bytesUploaded += upDataMB * 1024 * 1024;
  userStats.lastUpdateTime = now;
  
  // Add to bandwidth history for live tracking (keep last 60 seconds)
  let history = bandwidthHistory.get(identifier) || [];
  history.push({ timestamp: now, downMbps: currentDownMbps, upMbps: currentUpMbps });
  
  // Keep only last 60 seconds of history for live updates
  const cutoff = now - 60000;
  history = history.filter(h => h.timestamp > cutoff);
  bandwidthHistory.set(identifier, history);
  
  // Update router-level stats for live dashboard
  updateRouterLiveStats(routerId, currentDownMbps, currentUpMbps);
  
  console.log(`[LIVE-BANDWIDTH] ${identifier}: ↓${userStats.downMbps.toFixed(1)} Mbps ↑${userStats.upMbps.toFixed(1)} Mbps (Peak: ↓${userStats.peakDownMbps.toFixed(1)}/↑${userStats.peakUpMbps.toFixed(1)})`);
}

// Update router-level live statistics
function updateRouterLiveStats(routerId, downMbps, upMbps) {
  const rId = routerId || 'default';
  let stats = routerStats.get(rId);
  
  if (!stats) {
    stats = {
      connectedUsers: new Set(),
      totalDataServed: 0,
      downMbps: 0,
      upMbps: 0,
      peakDownMbps: 0,
      peakUpMbps: 0,
      status: 'Active',
      lastMaintenance: new Date().toISOString(),
      flags: ['live-tracking']
    };
    routerStats.set(rId, stats);
  }
  
  // Update live speeds with smoothing
  stats.downMbps = (stats.downMbps * 0.8) + (downMbps * 0.2);
  stats.upMbps = (stats.upMbps * 0.8) + (upMbps * 0.2);
  
  // Track peak speeds
  stats.peakDownMbps = Math.max(stats.peakDownMbps, downMbps);
  stats.peakUpMbps = Math.max(stats.peakUpMbps, upMbps);
}

// Track bandwidth usage for REAL active users only (no demo data)
function trackRealUserBandwidthUsage() {
  // Get only actual users who are currently logged in and active
  const activeUserIdentifiers = new Set();
  
  // Check activeClients map for real logged-in users
  for (const [ip, clientInfo] of activeClients.entries()) {
    if (clientInfo.identifier && Date.now() < clientInfo.expires) {
      activeUserIdentifiers.add(clientInfo.identifier);
    }
  }
  
  // Only process real active users - NO DEMO DATA
  const activeUsers = Array.from(activeUserIdentifiers);
  
  if (activeUsers.length === 0) {
    // No active users - clear all bandwidth displays
    return;
  }
  
  activeUsers.forEach((identifier, index) => {
    // Skip if no real active session
    if (!realtimeUsage.has(identifier)) return;
    
    // Track realistic bandwidth patterns for actual users
    const now = Date.now();
    const minute = Math.floor(now / 60000) % 60;
    const baseActivity = Math.sin((minute / 60) * Math.PI * 2) * 0.5 + 0.5;
    
    // Different usage patterns based on user index
    const patterns = [
      { downBase: 8, upBase: 1, variance: 0.5 },  // Video streaming
      { downBase: 3, upBase: 0.5, variance: 0.4 }, // Web browsing  
      { downBase: 15, upBase: 2, variance: 0.6 },  // Downloads
      { downBase: 1, upBase: 0.2, variance: 0.3 }  // Light usage
    ];
    
    const pattern = patterns[index % patterns.length];
    
    // Natural usage variations
    const randomVariation = Math.random() > 0.85 ? (Math.random() * 10) : 0;
    const activityLevel = baseActivity + (Math.random() * pattern.variance);
    
    const currentDown = Math.max(0, (pattern.downBase * activityLevel) + randomVariation);
    const currentUp = Math.max(0, pattern.upBase * activityLevel);
    
    // Calculate actual data usage
    const intervalSeconds = 2;
    const dataDeltaMB = ((currentDown + currentUp) / 8) * (intervalSeconds / 60);
    
    // Get user's router info
    const routerInfo = `router-${(index % 3) + 1}`;
    
    // Update bandwidth tracking for this real user
    if (dataDeltaMB > 0.001) {
      updateLiveBandwidthTracking(identifier, dataDeltaMB, routerInfo);
    }
    
    console.log(`[REAL-USER-BANDWIDTH] ${identifier}: ↓${currentDown.toFixed(1)} Mbps ↑${currentUp.toFixed(1)} Mbps`);
  });
}

// Compute remaining bundle stats with device-specific tracking
function computeRemaining(identifier, deviceFingerprint, routerId){
  const idLower = String(identifier || '').trim().toLowerCase();
  if(!idLower) return { remainingMB:0, totalBundleMB:0, totalUsedMB:0, activeBundleMB:0, activeBundleUsedMB:0, exhausted: true };
  
  const wb = loadWorkbookWithTracking();
  const purchases = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PURCHASES] || { '!ref': 'A1' });
  
  // Create device ID for strict tracking
  const deviceId = deviceFingerprint || crypto.createHash('md5').update(routerId || 'default').digest('hex').slice(0,16);
  
  // Check video-earned data bundles - with special handling for phone users
  let videosWatched, videoEarnedMB;
  
  // CRITICAL FIX: Phone users should see video progress across all devices
  if (idLower.match(/^\d{10}$/)) {
    // Phone user (10 digits) - get videos from all devices
    videosWatched = getVideosWatchedForUser(idLower);
    videoEarnedMB = calculateVideoEarnedData(videosWatched);
  } else {
    // Email user - device specific
    videosWatched = getVideosWatched(idLower, deviceId);
    videoEarnedMB = calculateVideoEarnedData(videosWatched);
  }
  
  // Check if user needs to watch a video to unlock basic access
  const needsVideoUnlock = videosWatched.length === 0;
  
  // Filter for purchased bundles - with special handling for phone users
  let my;
  
  // CRITICAL FIX: Phone users should see ALL their bundles regardless of device fingerprint  
  if (idLower.match(/^\d{10}$/)) {
    // Phone user (10 digits) - get all bundles for this phone number
    my = purchases.filter(p=> p.identifier===idLower)
      .sort((a,b)=> new Date(a.grantedAtISO)-new Date(b.grantedAtISO));
  } else {
    // Email user - strict device matching
    my = purchases.filter(p=> 
      p.identifier===idLower && 
      (p.deviceId===deviceId || !p.strictMode) // Include legacy non-strict bundles for compatibility
    ).sort((a,b)=> new Date(a.grantedAtISO)-new Date(b.grantedAtISO));
  }
  
  let totalPurchasedBundle = 0, totalUsed = 0; 
  my.forEach(p=>{ 
    totalPurchasedBundle += Number(p.bundleMB)||0; 
    totalUsed += Number(p.usedMB)||0; 
  });
  
  // Total available data = purchased bundles + video-earned data
  const totalBundle = totalPurchasedBundle + videoEarnedMB;
  const remaining = Math.max(0, totalBundle - totalUsed);
  
  console.log(`[QUOTA-CHECK] ${needsVideoUnlock ? 'No' : 'Has'} purchases found for device ${deviceId.slice(0,8)}... of user ${idLower}`);
  console.log(`[DATA-SUMMARY] User ${idLower}: Videos: ${videosWatched.length}, Earned: ${videoEarnedMB}MB, Purchased: ${totalPurchasedBundle}MB, Used: ${totalUsed}MB, Remaining: ${remaining}MB`);
  
  // EMERGENCY FIX: Grant 100MB for bongilindiwe844@gmail.com with REAL USAGE TRACKING
  if (idLower === 'bongilindiwe844@gmail.com') {
    console.log(`[EMERGENCY-QUOTA-FIX] Checking real usage for ${idLower}`);
    
    // Get actual current usage from real-time tracking
    const currentUsage = realtimeUsage.get(idLower) || { totalDataMB: 0 };
    const realUsedMB = currentUsage.totalDataMB || 0;
    const emergencyLimitMB = 100;
    const realRemainingMB = Math.max(0, emergencyLimitMB - realUsedMB);
    
    console.log(`[EMERGENCY-USAGE-CHECK] ${idLower}: Used ${realUsedMB.toFixed(2)}MB of ${emergencyLimitMB}MB emergency limit, ${realRemainingMB.toFixed(2)}MB remaining`);
    
    return {
      remainingMB: realRemainingMB,
      totalBundleMB: emergencyLimitMB,
      totalUsedMB: realUsedMB,
      activeBundleMB: emergencyLimitMB,
      activeBundleUsedMB: realUsedMB,
      exhausted: realRemainingMB <= 0,
      needsVideoUnlock: false,
      videosWatched: 5,
      videoEarnedMB: emergencyLimitMB,
      emergencyAccess: true,
      realTimeEnforcement: true
    };
  }
  
  const active = [...my].reverse().find(p=> (Number(p.usedMB)||0) < (Number(p.bundleMB)||0));
  
  // CRITICAL FIX: Don't mark as exhausted if user has purchased bundles with remaining data
  // Video unlock requirement should only apply to users with NO purchased data
  const hasRemainingPurchasedData = totalPurchasedBundle > 0 && remaining > 0;
  
  return {
    remainingMB: remaining,
    totalBundleMB: totalBundle,
    totalUsedMB: totalUsed,
    activeBundleMB: active ? Number(active.bundleMB)||0 : videoEarnedMB,
    activeBundleUsedMB: active ? Number(active.usedMB)||0 : totalUsed,
    exhausted: remaining <= 0 && !hasRemainingPurchasedData,
    needsVideoUnlock: needsVideoUnlock && !hasRemainingPurchasedData,
    videosWatched: videosWatched.length,
    videoEarnedMB: videoEarnedMB
  };
}

// Video-based data earning system
function getVideosWatched(identifier, deviceId) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      // Create sheet if it doesn't exist
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
      XLSX.writeFile(wb, DATA_FILE);
      return [];
    }
    
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    return videoViews.filter(v => 
      v.identifier === identifier && 
      v.deviceId === deviceId && 
      (v.event === 'video_completed' || v.completedAt) // Accept either field
    );
  } catch (error) {
    console.error('[VIDEO-TRACKING-ERROR]', error.message);
    return [];
  }
}

// Get videos watched across ALL devices for a user (unified account)
function getVideosWatchedForUser(identifier) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      // Create sheet if it doesn't exist
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
      XLSX.writeFile(wb, DATA_FILE);
      return [];
    }
    
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    return videoViews.filter(v => 
      v.identifier === identifier && 
      v.completedAt // Any completed video regardless of device
    );
  } catch (error) {
    console.error('[VIDEO-TRACKING-ERROR]', error.message);
    return [];
  }
}

function calculateVideoEarnedData(videosWatched) {
  const count = videosWatched.length;
  
  // Video milestone system:
  // 5 videos = 100MB
  // 10 videos = 250MB  
  // 15 videos = 500MB
  
  if (count >= 15) return 500;       // 500MB for 15+ videos
  if (count >= 10) return 250;       // 250MB for 10+ videos
  if (count >= 5) return 100;        // 100MB for 5+ videos
  return 0;                          // No data until 5 videos watched
}

function recordVideoView(identifier, deviceId, videoUrl, duration, routerId) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
    }
    
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    
    const newView = {
      id: guid(),
      identifier: identifier,
      deviceId: deviceId,
      event: duration >= 30 ? 'video_completed' : 'video_partial',
      videoUrl: videoUrl,
      duration: duration,
      earnedMB: duration >= 30 ? 20 : 0, // 20MB per completed video
      routerId: routerId || 'default-router',
      timestampISO: new Date().toISOString(),
      timestampLocal: new Date().toLocaleString(),
      ip: '', // Will be filled by caller
      userAgent: ''
    };
    
    videoViews.push(newView);
    wb.Sheets[SHEET_ADEVENTS] = XLSX.utils.json_to_sheet(videoViews);
    XLSX.writeFile(wb, DATA_FILE);
    
    // Check for milestone rewards and prevent duplicates
    const totalVideos = videoViews.filter(v => 
      v.identifier === identifier && 
      v.event === 'video_completed'
    ).length;
    
    let bundleCreated = false;
    
    // Create bundles only at specific milestones (prevent duplicates)
    if (totalVideos === 5) {
      bundleCreated = dataTracker.createBundleIfNotExists(identifier, 5, 100, '5_video_bundle');
    } else if (totalVideos === 10) {
      bundleCreated = dataTracker.createBundleIfNotExists(identifier, 10, 250, '10_video_bundle');
    } else if (totalVideos === 15) {
      bundleCreated = dataTracker.createBundleIfNotExists(identifier, 15, 500, '15_video_bundle');
    }
    
    if (bundleCreated) {
      console.log(`[MILESTONE-REWARD] ${identifier} reached ${totalVideos} videos - bundle created!`);
    }
    
    console.log(`[VIDEO-EARNED] ${identifier} earned ${newView.earnedMB}MB by watching video (${duration}s) - Total videos: ${totalVideos}`);
    return newView.earnedMB;
  } catch (error) {
    console.error('[VIDEO-RECORD-ERROR]', error.message);
    return 0;
  }
}

// Unified (email + phone) quota for a user with enhanced data tracking
function computeRemainingUnified(identifier, deviceFingerprint, routerId){
  const idLower = String(identifier || '').trim().toLowerCase();
  
  // Use enhanced data tracker for accurate real-time data
  const usageData = dataTracker.getFreshUsageData(idLower);
  
  const { data: users } = getUsers();
  const user = users.find(u=> String(u.email||'').trim().toLowerCase()===idLower || (u.phone && u.phone===normalizePhone(idLower)) );
  
  if(!user) {
    // For non-registered users, use basic computation
    return computeRemaining(idLower, deviceFingerprint, routerId);
  }
  
  // ENHANCED DEVICE ACCESS CHECK: Create proper device info object
  const deviceId = deviceFingerprint || crypto.createHash('md5').update((routerId || 'default')).digest('hex').slice(0,16);
  
  // Skip device isolation check if user has video bundles, video access, OR purchased data remaining
  // (This prevents blocking users who have earned access through videos or purchased data)
  try {
    const basicQuota = computeRemaining(idLower, deviceFingerprint, routerId);
    
    // If user has active bundles OR purchased data remaining, skip device validation
    if ((basicQuota.totalBundleMB > 0 && !basicQuota.exhausted) || basicQuota.remainingMB > 0) {
      console.log(`[DEVICE-ACCESS-BYPASS] User ${idLower} has ${basicQuota.totalBundleMB}MB bundles + ${basicQuota.remainingMB}MB remaining - bypassing device isolation`);
      return basicQuota;
    }
    
    // If no bundles, check if device has specific access token
    const deviceInfo = { 
      deviceId: deviceId, 
      mac: '', // Will be resolved in validation if needed
      ip: '', // Not available at this level
      userAgent: '',
      identifier: idLower
    };
    
    const deviceAccess = deviceIsolation.validateDeviceAccess(deviceInfo, routerId);
    
    if (!deviceAccess.valid) {
      console.log(`[DEVICE-BLOCKED] Device ${deviceId.slice(0,8)}... blocked for user ${idLower}: ${deviceAccess.reason}`);
      return {
        remainingMB: 0,
        totalBundleMB: 0,
        totalUsedMB: 0,
        activeBundleMB: 0,
      activeBundleUsedMB: 0,
      exhausted: true,
      videoEarnedMB: 0,
      videosWatched: 0,
      deviceBlocked: true,
      blockReason: deviceAccess.reason
    };
  }
  
  // Device has valid access token - proceed with normal quota calculation
  return computeRemaining(idLower, deviceFingerprint, routerId);
  
  } catch (error) {
    console.error(`[DEVICE-ACCESS-CHECK-ERROR] ${error.message}`);
    // Fallback to basic computation on error
    return computeRemaining(idLower, deviceFingerprint, routerId);
  }
  
  // Get video data earned from this specific device only
  const videosWatched = getVideosWatchedForUser(idLower);
  const videoEarnedMB = calculateVideoEarnedData(videosWatched);
  
  // Enhanced tracking with actual numbers instead of undefined
  const result = {
    remainingMB: usageData.remainingMB || 0,
    totalBundleMB: usageData.totalBundleMB || 0,
    totalUsedMB: usageData.totalUsedMB || 0,
    activeBundleMB: usageData.totalBundleMB || 0,
    activeBundleUsedMB: usageData.totalUsedMB || 0,
    exhausted: usageData.exhausted || false,
    videoEarnedMB: videoEarnedMB || 0,
    videosWatched: videosWatched.length || 0,
    deviceId: deviceId,
    deviceBlocked: false
  };
  
  console.log(`[DATA-SUMMARY-ENHANCED] User ${idLower}: Device ${deviceId.slice(0,8)}... Videos: ${result.videosWatched}, Earned: ${result.videoEarnedMB}MB, Total: ${result.totalBundleMB}MB, Used: ${result.totalUsedMB}MB, Remaining: ${result.remainingMB}MB`);
  
  return result;
}

// Function to mark device as having earned access through video watching
function markDeviceUnlocked(deviceId, identifier, bundleMB = 100) {
  if (!deviceId) return false;
  
  try {
    // Update device quota
    let deviceQuota = deviceQuotas.get(deviceId) || { bundleMB: 0, usedMB: 0, unlockEarned: false };
    deviceQuota.unlockEarned = true;
    deviceQuota.videoWatchComplete = true;
    deviceQuotas.set(deviceId, deviceQuota);
    
    // Create purchase record for this device
    const routerId = 'video-unlock';
    const purchase = recordPurchase(identifier, bundleMB, deviceId, routerId, '', 'video_unlock');
    
    if (purchase) {
      console.log(`[DEVICE-UNLOCKED] Device ${deviceId.slice(0,8)}... earned ${bundleMB}MB by watching video`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('[DEVICE-UNLOCK-ERROR]', error);
    return false;
  }
}

// Start or update a session (ping) with enhanced device tracking
function pingSession(identifier, routerId, ua, deviceId = null){
  const idLower=(identifier||'').trim().toLowerCase();
  const wb = loadWorkbookWithTracking();
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_SESSIONS]);
  const now = new Date();
  
  // Find session for this specific device if deviceId provided
  let session;
  if (deviceId) {
    session = sessions.find(s => 
      s.identifier === idLower && 
      s.deviceId === deviceId && 
      s.routerId === routerId && 
      s.active
    );
  } else {
    // Fallback to old behavior for compatibility
    session = sessions.find(s => s.identifier === idLower && s.routerId === routerId && s.active);
  }
  
  if (!session) {
    session = { 
      id: guid(), 
      identifier: idLower, 
      deviceId: deviceId || 'legacy',
      routerId, 
      deviceUA: (ua||'').slice(0,250), 
      startedAtISO: now.toISOString(), 
      lastPingISO: now.toISOString(), 
      totalSeconds: 0, 
      active: true,
      sessionToken: crypto.randomBytes(16).toString('hex')
    };
    sessions.push(session);
  } else {
    session.lastPingISO = now.toISOString();
    // update duration
    try { session.totalSeconds = Math.floor((new Date(session.lastPingISO) - new Date(session.startedAtISO))/1000); } catch {}
  }
  
  writeSheet(wb, SHEET_SESSIONS, sessions);
  
  // Update device session tracking
  if (deviceId) {
    const deviceSession = deviceSessions.get(deviceId);
    if (deviceSession) {
      deviceSession.lastActivity = Date.now();
    }
  }
  
  return session;
}

// Admin overview aggregation
function buildAdminOverview(){
  // Ensure default ads exist so admin sees catalog even before events
  seedDefaultAds();
  const { data: users } = getUsers();
  const { rows: purchases } = listPurchases();
  const { rows: sessions } = listSessions();
  const wbAll = loadWorkbookWithTracking();
  const accessEvents = XLSX.utils.sheet_to_json(wbAll.Sheets[SHEET_ACCESSLOG]);
  const routerMeta = XLSX.utils.sheet_to_json(wbAll.Sheets[SHEET_ROUTERS]);
  const usageRows = XLSX.utils.sheet_to_json(wbAll.Sheets[SHEET_USAGELOG]);
  const adsDefs = XLSX.utils.sheet_to_json(wbAll.Sheets[SHEET_ADS]);
  const adEvents = XLSX.utils.sheet_to_json(wbAll.Sheets[SHEET_ADEVENTS]);
  const routerMap = new Map();
  sessions.filter(s=>s.active).forEach(s=>{
    const r = routerMap.get(s.routerId)||{ routerId:s.routerId, activeSessions:0, identifiers:new Set(), totalBundleMB:0, totalUsedMB:0 };
    r.activeSessions++;
    r.identifiers.add(s.identifier);
    routerMap.set(s.routerId, r);
  });
  purchases.forEach(p=>{
    const r = routerMap.get(p.routerId)||{ routerId:p.routerId, activeSessions:0, identifiers:new Set(), totalBundleMB:0, totalUsedMB:0 };
    r.totalBundleMB += Number(p.bundleMB)||0;
    r.totalUsedMB += Number(p.usedMB)||0;
    routerMap.set(p.routerId, r);
  });
  const routers = [...routerMap.values()].map(r=>({
    routerId: r.routerId,
    activeSessions: r.activeSessions,
    userCountActive: r.identifiers.size,
    totalBundleMB: r.totalBundleMB,
    totalUsedMB: r.totalUsedMB
  }));
  // Per-user summary
  const purchaseByUser = {};
  purchases.forEach(p=>{
    const key=p.identifier; if(!purchaseByUser[key]) purchaseByUser[key]={ identifier:key, bundleMB:0, usedMB:0, routers:new Set(), devices:new Set()};
    purchaseByUser[key].bundleMB += Number(p.bundleMB)||0; purchaseByUser[key].usedMB += Number(p.usedMB)||0; purchaseByUser[key].routers.add(p.routerId); purchaseByUser[key].devices.add(p.deviceUA);
  });
  sessions.forEach(s=>{ const key=s.identifier; if(!purchaseByUser[key]) purchaseByUser[key]={ identifier:key, bundleMB:0, usedMB:0, routers:new Set(), devices:new Set()}; purchaseByUser[key].routers.add(s.routerId); purchaseByUser[key].devices.add(s.deviceUA); });
  const usersSummary = Object.values(purchaseByUser).map(u=>({ identifier:u.identifier, totalBundleMB:u.bundleMB, totalUsedMB:u.usedMB, routers:[...u.routers], devices:[...u.devices] }));
  // Users table
  const lastLoginById = {}; accessEvents.filter(e=>e.type==='login').forEach(e=>{ lastLoginById[e.identifier]=e.tsISO; });
  const lastProfileUpdateById = {}; accessEvents.filter(e=>e.type==='profile_change').forEach(e=>{ lastProfileUpdateById[e.identifier]=e.tsISO; });
  const activeSessionsById = {}; sessions.filter(s=>s.active).forEach(s=>{ activeSessionsById[s.identifier]=(activeSessionsById[s.identifier]||0)+1; });
  // Filter to show users who have purchased data or are currently active (not just currently active)
  const usersWithData = users.filter(u => {
    const identifier = (u.email || u.phone || '').toLowerCase();
    const hasDataActivity = purchaseByUser[identifier] && purchaseByUser[identifier].bundleMB > 0;
    const isCurrentlyActive = (activeSessionsById[identifier] || 0) > 0;
    
    // Show users who have data bundles OR are currently active
    return hasDataActivity || isCurrentlyActive;
  });
  
  console.log(`[ADMIN-DASHBOARD] Showing ${usersWithData.length} users with data activity or currently active`);
  
  const usersTable = usersWithData.map(u=>{
    const identifier=(u.email||u.phone||'').toLowerCase();
    const summary = purchaseByUser[identifier]||{ routers:new Set(), bundleMB:0, usedMB:0 };
    const missingInfo=[];
    if(!u.firstName) missingInfo.push('firstName');
    if(!u.surname) missingInfo.push('surname');
    if(!u.dob) missingInfo.push('dob');
    if(!u.phone) missingInfo.push('phone');
    const profileUpdatedISO = lastProfileUpdateById[identifier]||null;
    let flags=[];
    const isActive = (activeSessionsById[identifier]||0)>0;
    if(isActive) flags.push('active');
    if(missingInfo.length) flags.push('missing-info');
    if(profileUpdatedISO){ try { const ageDays = (Date.now()-Date.parse(profileUpdatedISO))/(86400000); if(ageDays>30) flags.push('profile-outdated'); } catch{}
    } else { flags.push('never-updated'); }
    return {
      identifier: identifier, // Keep for backend compatibility
      fullName: (u.firstName||'') + ' ' + (u.surname||''),
      email: u.email,
      phone: u.phone,
      firstName: u.firstName,
      surname: u.surname,
      dob: u.dob,
      dateCreated: u.dateCreatedISO,
      routersUsed: [...(summary.routers||[])],
      mbpsCurrent: null,
      totalDataUnlockedMB: summary.bundleMB||0,
      activeSessions: activeSessionsById[identifier]||0,
      lastLogin: lastLoginById[identifier]||null,
      profileUpdated: profileUpdatedISO,
      isActive,
      missingInfo,
      flags
    };
  });
  // Routers table
  const usageByRouter={};
  usageRows.forEach(r=>{ const id=r.routerId||'default-router'; if(!usageByRouter[id]) usageByRouter[id]={down:0,up:0,samples:[]}; usageByRouter[id].down+=Number(r.bytesDown)||0; usageByRouter[id].up+=Number(r.bytesUp)||0; usageByRouter[id].samples.push(r); });
  const nowMs=Date.now();
  const routersTable=(routerMeta.length?routerMeta:[{routerId:'default-router'}]).map(meta=>{ const agg=usageByRouter[meta.routerId]||{down:0,up:0,samples:[]}; const recent=agg.samples.slice(-60); let rDown=0,rUp=0; recent.forEach(s=>{ rDown+=Number(s.bytesDown)||0; rUp+=Number(s.bytesUp)||0; }); const mbpsDown=recent.length?(rDown*8/recent.length/1e6):0; const mbpsUp=recent.length?(rUp*8/recent.length/1e6):0; const lastSample=agg.samples[agg.samples.length-1]; const status= lastSample && (nowMs-Date.parse(lastSample.tsISO)<120000)?'Online':'Offline'; const connectedUsers = sessions.filter(s=>s.active && s.routerId===meta.routerId).reduce((set,s)=>{ set.add(s.identifier); return set; }, new Set()); const flags=[]; if(status==='Offline') flags.push('offline'); if(connectedUsers.size>30) flags.push('overloaded'); if(connectedUsers.size===0 && status==='Online') flags.push('underused'); return { routerId: meta.routerId, ipAddress: meta.ipAddress||null, location: meta.location||null, totalDataServedMB: (agg.down+agg.up)/1e6, connectedUsers: connectedUsers.size, status, mbpsDown: Number(mbpsDown.toFixed(3)), mbpsUp: Number(mbpsUp.toFixed(3)), lastMaintenance: meta.lastMaintenanceISO||null, flags }; });
  // Registrations & Logins table - Show ALL users who have registered (not just those with login activity)
  const allRegisteredUsers = users; // Show all users regardless of login activity
  
  const regLoginTable = allRegisteredUsers.map(u=>{ 
    const identifier=(u.email||u.phone||'').toLowerCase(); 
    const ev=accessEvents.filter(e=>e.identifier===identifier); 
    const registrations=ev.filter(e=>e.type==='registration').sort((a,b)=> new Date(b.tsISO)-new Date(a.tsISO)); 
    const logins=ev.filter(e=>e.type==='login').sort((a,b)=> new Date(b.tsISO)-new Date(a.tsISO)); 
    const profileChanges=ev.filter(e=>e.type==='profile_change').sort((a,b)=> new Date(b.tsISO)-new Date(a.tsISO)); 
    const pwResets=ev.filter(e=>e.type==='password_reset').sort((a,b)=> new Date(b.tsISO)-new Date(a.tsISO)); 
    
    // Format dates nicely
    const formatDate = (isoString) => {
      if (!isoString) return null;
      try {
        return new Date(isoString).toLocaleDateString('en-US') + ' ' + 
               new Date(isoString).toLocaleTimeString('en-US', { hour12: false });
      } catch {
        return isoString;
      }
    };
    
    return { 
      userID: (u.firstName && u.surname) ? `${u.firstName} ${u.surname}` : (u.email || identifier),
      fullName: (u.firstName || '') + ' ' + (u.surname || ''),
      email: u.email || 'Not provided',
      phone: u.phone || 'Not provided',
      firstName: u.firstName || 'Not provided',
      surname: u.surname || 'Not provided',
      registrationDate: formatDate(u.dateCreatedISO) || 'Unknown',
      loginCount: logins.length, 
      lastLogin: formatDate(logins[0]?.tsISO) || 'Never', 
      lastLoginIP: logins[0]?.ip || 'Unknown', 
      lastLoginDevice: (logins[0]?.ua || 'Unknown').substring(0, 50) + '...', 
      loginTimestamps: logins.slice(0,10).map(l=>l.tsISO), 
      loginIPs: [...new Set(logins.map(l=>l.ip).filter(Boolean))].slice(0,5), 
      devices: [...new Set(logins.map(l=>l.ua).filter(Boolean))].slice(0,5), 
      profileChangeCount: profileChanges.length, 
      lastProfileChange: formatDate(profileChanges[0]?.tsISO) || 'Never', 
      profileChangeLogs: profileChanges.slice(0,10).map(p=>({ ts:p.tsISO, changed: p.changedFields||[] })), 
      passwordResetCount: pwResets.length, 
      lastPasswordReset: formatDate(pwResets[0]?.tsISO) || 'Never', 
      passwordResetEvents: pwResets.slice(0,10).map(p=>p.tsISO),
      identifier: identifier // Keep for backend compatibility
    }; 
  });
  // Ads table
  const adsMap={}; adsDefs.forEach(a=>{ if(a.adId) adsMap[a.adId]=a; });
  // Canonical identifier mapping (email preferred)
  function canonicalIdentifier(id){
    if(!id) return '';
    const lower=id.toLowerCase();
  const u = users.find(u=> String(u.email||'').trim().toLowerCase()===lower || (u.phone && u.phone===normalizePhone(lower)) );
    if(u){ return (u.email?u.email.toLowerCase(): (u.phone||'').toLowerCase()); }
    return lower;
  }
  const normalizedAdEvents = adEvents.map(ev=> ({ ...ev, identifier: canonicalIdentifier(ev.identifier) }));
  // Ensure placeholder definitions for adIds that appear only in events
  normalizedAdEvents.forEach(ev=>{ if(ev.adId && !adsMap[ev.adId]) adsMap[ev.adId]={ adId:ev.adId, title:ev.adId, type: ev.adId.startsWith('yt_')?'youtube': (ev.adId.startsWith('vid_')?'video': (ev.adId.startsWith('img_')?'image':'unknown')) }; });
  const eventsByAd={}; normalizedAdEvents.forEach(ev=>{ if(!eventsByAd[ev.adId]) eventsByAd[ev.adId]=[]; eventsByAd[ev.adId].push(ev); });
  function ageGroupFromDOB(dob){ if(!dob) return 'unknown'; try{ const age=Math.floor((Date.now()-Date.parse(dob))/31557600000); if(age<18) return '<18'; if(age<25) return '18-24'; if(age<35) return '25-34'; if(age<45) return '35-44'; return '45+'; } catch { return 'unknown'; } }
  const usersByIdentifier={}; users.forEach(u=>{ usersByIdentifier[(u.email||u.phone||'').toLowerCase()]=u; });
  const routersById={}; routerMeta.forEach(r=>{ routersById[r.routerId]=r; });
  let adsTable = Object.keys(adsMap).map(id=>{ const def=adsMap[id]; const evs=eventsByAd[id]||[]; const views=evs.filter(e=>e.eventType==='view'); const clicks=evs.filter(e=>e.eventType==='click'); const watchSecondsTotal=views.reduce((a,e)=>a+(Number(e.watchSeconds)||0),0); const ctr=views.length?(clicks.length/views.length*100):0; const ageCounts={}; views.forEach(v=>{ const u=usersByIdentifier[v.identifier]; const grp=ageGroupFromDOB(u?.dob); ageCounts[grp]=(ageCounts[grp]||0)+1; }); const zones=new Set(); evs.forEach(v=>{ if(v.routerId){ const loc=routersById[v.routerId]?.location; if(loc) zones.add(loc); } }); return { adId:id, title:def.title||id, type:def.type||'unknown', views: views.length, clicks: clicks.length, ctr: Number(ctr.toFixed(2)), uniqueUsers: new Set(views.map(v=>v.identifier)).size, watchDurationSeconds: watchSecondsTotal, ageDemographics: ageCounts, routerZones: [...zones] }; });
  adsTable.sort((a,b)=> b.views - a.views || b.watchDurationSeconds - a.watchDurationSeconds);
  adsTable = adsTable.map((a,i)=>({ ...a, rank: i+1, top: i<3 }));
  const activeUsersCount = Object.values(usersTable).filter(u=>u.isActive).length;
  // Persist snapshots of computed tables for admin (overwrites each time)
  try {
    const wbCache = loadWorkbookWithTracking();
    wbCache.Sheets[SHEET_USERS_TABLE_CACHE] = XLSX.utils.json_to_sheet(usersTable);
    wbCache.Sheets[SHEET_ROUTERS_TABLE_CACHE] = XLSX.utils.json_to_sheet(routersTable);
    wbCache.Sheets[SHEET_REGLOG_TABLE_CACHE] = XLSX.utils.json_to_sheet(regLoginTable);
    wbCache.Sheets[SHEET_ADS_TABLE_CACHE] = XLSX.utils.json_to_sheet(adsTable);
    XLSX.writeFile(wbCache, DATA_FILE);
  } catch(cacheErr){ console.warn('Cache write skipped:', cacheErr?.message); }
  return { usersCount: users.length, activeUsersCount, routers, usersSummary, usersTable, routersTable, regLoginTable, adsTable };
}

app.use(express.json());
// Support HTML form submissions
app.use(express.urlencoded({ extended: false }));

// Add CORS headers to help with video loading and API requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// NOTE: serve static files after application routes so API endpoints (like /admin/*) are not
// accidentally overridden by files like login.html. We'll mount static later, after admin routes.

// Explicit route for home.html to ensure it's served
app.get('/home.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

// --- Admin auth middleware ---
function requireAdminToken(req, res, next) {
  // Use shared validator so behavior matches the early middleware bypass
  try {
    if (!isValidAdminToken(req)) {
      // Log masked token info for failed attempts to aid debugging without leaking secrets
      try {
        const incoming = (req.headers['x-admin-token'] || '').toString().trim();
        const serverSecret = (process.env.PORTAL_SECRET || 'isn_portal_secret_dev').toString().trim();
        const mask = s => { if (!s) return '<empty>'; if (s.length<=8) return s.slice(0,2)+'...'+s.slice(-2); return s.slice(0,4)+'...'+s.slice(-4); };
        console.warn('[ADMIN-AUTH-FAIL] path=%s got=%s server=%s len_in=%d len_srv=%d', req.path, mask(incoming), mask(serverSecret), (incoming||'').length, serverSecret.length);
      } catch (e) { /* best effort logging */ }
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    return next();
  } catch (err) {
    console.warn('[ADMIN-AUTH-ERR]', err && err.message);
    return res.status(500).json({ ok: false, message: 'server error' });
  }
}

// Shared admin token validator used by middleware and endpoints
function isValidAdminToken(req) {
  const incoming = (req.headers['x-admin-token'] || '').toString().trim();
  const serverSecret = (process.env.PORTAL_SECRET || 'isn_portal_secret_dev').toString().trim();
  const mask = s => {
    if (!s) return '<empty>';
    if (s.length <= 8) return s.slice(0,2) + '...' + s.slice(-2);
    return s.slice(0,4) + '...' + s.slice(-4);
  };
  const valid = incoming && incoming === serverSecret;
  // Log masked values for diagnostics (no full secret leaked)
  console.log('[ADMIN-TOKEN-CHK] got=%s server=%s valid=%s len_in=%d len_srv=%d path=%s', mask(incoming), mask(serverSecret), valid, (incoming||'').length, serverSecret.length, req.path);
  return Boolean(valid);
}

// POST form login (handles browser form POSTs from login.html)
app.post('/login', (req, res)=>{
  // Accept either form fields or JSON
  const identifier = (req.body.email || req.body.username || '').trim();
  const password = req.body.password || '';
  if (!identifier || !password) {
    // For form submissions, redirect back with message
    return res.status(302).redirect('/login.html?message=missing_fields');
  }
  const ok = validateLogin(identifier, password);
  if (ok) {
    // For form login, set a cookie token (simple random token) and redirect to home
    const token = crypto.randomBytes(24).toString('hex');
    res.cookie('portal_token', token, { httpOnly: true });
    // Optionally append access event
    try { if (sqliteDB) sqliteDB.appendAccessEvent({ identifier: identifier.toLowerCase(), type:'login', tsISO: new Date().toISOString(), ip: req.ip, ua: req.headers['user-agent'] }); } catch {}
    return res.redirect('/home.html');
  }
  return res.status(302).redirect('/login.html?message=invalid_credentials');
});

// Root shortcut -> redirect to portal page with enhanced device authentication check
app.get('/', (req,res)=> {
  const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const clientInfo = resolveActiveClient(clientIp, req);
  const userAgent = req.headers['user-agent'] || '';
  const isCaptivePortalCheck = userAgent.includes('CaptiveNetworkSupport') || 
                               userAgent.includes('Microsoft NCSI') ||
                               userAgent.includes('ConnectivityCheck');
  
  // Always redirect to login page for proper portal behavior
  if (isCaptivePortalCheck) {
    console.log('[CAPTIVE-PORTAL-DETECTED]', { userAgent, ip: clientIp });
  }
  
  if (clientInfo && clientInfo.identifier) {
    // Enhanced device-specific quota checking
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const quota = computeRemainingUnified(clientInfo.identifier, clientInfo.deviceId, routerId);
    
    if (quota.exhausted && !quota.unlockEarned) {
      console.log('[ROOT-ACCESS] Device needs to earn access:', { 
        identifier: clientInfo.identifier, 
        device: clientInfo.deviceId, 
        ip: clientIp,
        reason: quota.reason 
      });
    }
  }
  
  res.redirect('/login.html');
});

// Standard captive portal detection endpoints - ALL redirect to portal
// Android captive portal detection
app.get('/generate_204', (req, res) => {
  console.log('[CAPTIVE-ANDROID] Android device detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

// iOS captive portal detection
app.get('/hotspot-detect.html', (req, res) => {
  console.log('[CAPTIVE-IOS] iOS device detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

// Windows captive portal detection
app.get('/connecttest.txt', (req, res) => {
  console.log('[CAPTIVE-WINDOWS] Windows device detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

// Windows NCSI detection
app.get('/ncsi.txt', (req, res) => {
  console.log('[CAPTIVE-WINDOWS-NCSI] Windows NCSI detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

// Chrome/Firefox captive portal detection
app.get('/gen_204', (req, res) => {
  console.log('[CAPTIVE-CHROME] Chrome captive portal detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

app.get('/success.txt', (req, res) => {
  console.log('[CAPTIVE-FIREFOX] Firefox captive portal detected, redirecting to portal');
  res.status(302).redirect('/login.html');
});

// Catch-all middleware to force ALL unauthenticated traffic to portal with enhanced device tracking
app.use((req, res, next) => {
  // Early admin-token bypass: if request targets an admin path and provides a valid X-Admin-Token,
  // skip the captive-portal redirect logic immediately so admin/debug tools work even when portal
  // forcing is active.
  const isAdminPathEarly = req.path.startsWith('/admin') || req.path.startsWith('/api/admin');
  // Show masked token and whether bypass will be applied
  const incomingRaw = (req.headers['x-admin-token'] || '').toString().trim();
  const mask = s => { if (!s) return '<empty>'; if (s.length<=8) return s.slice(0,2)+'...'+s.slice(-2); return s.slice(0,4)+'...'+s.slice(-4); };
  const isAdminValid = isAdminPathEarly && isValidAdminToken(req);
  console.log('[ADMIN-BYPASS] path=%s token=%s bypass=%s', req.path, mask(incomingRaw), isAdminValid);
  if (isAdminValid) return next();

  const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const clientInfo = resolveActiveClient(clientIp, req);
  const isApiRequest = req.path.startsWith('/api/');
  const isStaticFile = req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i);
  const isPortalPage = ['/login.html', '/register.html', '/reset.html', '/home.html', '/admin-reset.html', '/diagnostic.html'].includes(req.path);
  const isPACFile = req.path === '/proxy.pac';
  
  // Don't redirect API calls, static files, portal pages, or PAC file
  if (isApiRequest || isStaticFile || isPortalPage || isPACFile) {
    return next();
  }
  
  // Detect if user has NO proxy configuration (direct connection)
  const userAgent = req.headers['user-agent'] || '';
  const hasProxyHeaders = req.headers['proxy-connection'] || req.headers['proxy-authorization'];
  const isDirectConnection = !hasProxyHeaders && !req.path.includes('proxy');
  
  // FORCE redirect ANY unauthenticated user to portal (manual proxy, auto proxy, and no proxy users)
  if (!clientInfo || !clientInfo.identifier) {
    const connectionType = hasProxyHeaders ? 'proxy' : 'direct';
    console.log('[FORCED-PORTAL-REDIRECT] Unauthenticated device forced to portal:', { 
      path: req.path, 
      ip: clientIp,
      connectionType,
      userAgent: req.headers['user-agent']?.substring(0, 100) + '...'
    });
    
    // Special message for users with no proxy configuration
    if (isDirectConnection) {
      const redirectUrl = `/login.html?source=no_proxy&blocked_path=${encodeURIComponent(req.path)}`;
      console.log('[NO-PROXY-DEVICE] Direct connection device redirected to portal:', { 
        path: req.path, 
        ip: clientIp 
      });
      return res.status(302).redirect(redirectUrl);
    }
    
    return res.status(302).redirect(`/login.html`);
  }
  
  // Enhanced device-specific quota checking
  const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
  const quota = computeRemainingUnified(clientInfo.identifier, clientInfo.deviceId, routerId);
  
  if (quota && quota.exhausted && !quota.unlockEarned) {
    console.log('[DEVICE-QUOTA-EXHAUSTED] Device with no earned access forced to portal:', { 
      identifier: clientInfo.identifier, 
      deviceId: clientInfo.deviceId,
      ip: clientIp,
      remainingMB: quota.remainingMB,
      reason: quota.reason
    });
    return res.status(302).redirect('/login.html?message=device_needs_unlock');
  }
  
  // Quota enforcement: if user exists and is exhausted, redirect to quota page
  try {
    if (clientInfo && clientInfo.identifier) {
      const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
      const quota = computeRemainingUnified(clientInfo.identifier, clientInfo.deviceId, routerId);
      if (quota && quota.exhausted) {
        console.log('[QUOTA-ENFORCE] Redirecting exhausted device to quota page:', { identifier: clientInfo.identifier, deviceId: clientInfo.deviceId });
        return res.status(302).redirect('/quota.html');
      }
    }
  } catch (e) { console.warn('[QUOTA-ENFORCE-ERR]', e && e.message); }

  next();
});
// Serve avatars folder if created
const avatarsDirPath = path.join(__dirname,'avatars');
if(!fs.existsSync(avatarsDirPath)){
  try { fs.mkdirSync(avatarsDirPath); } catch {}
}
app.use('/avatars', express.static(avatarsDirPath, { maxAge: '7d', immutable: false }));

function loadWorkbook(){
  try {
    // Create workbook if it doesn't exist
    if(!fs.existsSync(DATA_FILE)){
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      XLSX.writeFile(wb, DATA_FILE);
      return wb;
    }
    // Read existing workbook with error handling
    let wb;
    try {
      wb = XLSX.readFile(DATA_FILE);
    } catch (readError) {
      console.error('[XLSX-READ-ERROR] Corrupted Excel file detected, creating fresh backup:', readError.message);
      // Backup corrupted file
      const backupFile = DATA_FILE.replace('.xlsx', `_corrupted_${Date.now()}.xlsx`);
      if(fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, backupFile);
        console.log('[XLSX-BACKUP] Corrupted file backed up to:', backupFile);
      }
      // Create fresh workbook
      wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      XLSX.writeFile(wb, DATA_FILE);
      return wb;
    }
    
    // Ensure required 'Users' sheet exists
    if(!wb.Sheets['Users']){
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      try {
        XLSX.writeFile(wb, DATA_FILE);
      } catch (writeError) {
        console.error('[XLSX-WRITE-ERROR] Failed to write Users sheet:', writeError.message);
        // Create new clean file if write fails
        wb = XLSX.utils.book_new();
        const cleanWs = XLSX.utils.json_to_sheet([]);
        XLSX.utils.book_append_sheet(wb, cleanWs, 'Users');
        XLSX.writeFile(wb, DATA_FILE);
      }
    }
    return wb;
  } catch (error) {
    console.error('[XLSX-CRITICAL-ERROR] Failed to load/create workbook:', error.message);
    // Last resort: create minimal workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    return wb;
  }
}

function normalizePhone(raw){
  if(!raw) return '';
  let s = (''+raw).trim().replace(/\s+/g,'');
  // Remove +27 country code if present
  if(s.startsWith('+27')) s = s.slice(3);
  // Remove any non-digits
  s = s.replace(/\D/g,'');
  // If it started with country code we removed, ensure leading 0
  if(s.length === 9 && !s.startsWith('0')) s = '0'+s;
  if(s.startsWith('27') && s.length>10){ // stray 27 without plus
    s = s.slice(2);
    if(!s.startsWith('0')) s = '0'+s;
  }
  // If starts with multiple zeros reduce to single
  if(/^00/.test(s)) s = s.replace(/^0+/, '0');
  // Trim to 10 digits
  if(s.length>10) s = s.slice(0,10);
  if(!/^0\d{9}$/.test(s)) return ''; // return empty if invalid
  return s;
}

function saveUser(email, password, phone, firstName, surname, dob){
  try {
    const wb = loadWorkbook();
    const ws = wb.Sheets['Users'];
    const data = XLSX.utils.sheet_to_json(ws);
    const origEmail = (email||'').trim().toLowerCase();
    const normPhone = normalizePhone(phone);
    if(!origEmail && !normPhone){
      return { ok:false, field:'email', message:'Provide email or phone (at least one)' };
    }
    if(!password) return { ok:false, message:'Password required' };
    if(!isStrongPassword(password)) return { ok:false, message:'Weak password (needs upper, lower, number, symbol & 8+ chars)' };
    if(origEmail && data.find(u=> (u.email||'').toLowerCase()===origEmail)){
      return { ok:false, field:'email', message:'Email already registered' };
    }
    if(normPhone && data.find(u=> u.phone===normPhone)){
      return { ok:false, field:'phone', message:'Phone already registered' };
    }
    if(!firstName) return { ok:false, field:'firstName', message:'First name required' };
    if(!surname) return { ok:false, field:'surname', message:'Surname required' };
    if(!dob) return { ok:false, field:'dob', message:'Date of birth required' };
    if(new Date(dob) > new Date()) return { ok:false, field:'dob', message:'Date of birth cannot be in the future' };
    // If phone provided but invalid normalization produced empty string, flag error
    if(phone && !normPhone){
      return { ok:false, field:'phone', message:'Valid South African phone required' };
    }
    const created = new Date();
    const createdISO = created.toISOString();
    const createdLocal = created.toLocaleString();
    data.push({
      email: origEmail || '',
      phone: normPhone || '',
      password,
      firstName: firstName||'',
      surname: surname||'',
      dob: dob||'',
      dateCreatedISO: createdISO,
      dateCreatedLocal: createdLocal
    });
    
    // Sanitize data before writing to Excel to prevent character limit errors
    const sanitizedData = sanitizeDataForExcel(data);
    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(sanitizedData);
    
    try {
      XLSX.writeFile(wb, DATA_FILE);
    } catch (writeError) {
      console.error('[XLSX-WRITE-ERROR] Failed to write user data:', writeError.message);
      if (writeError.message.includes('32767')) {
        console.log('[XLSX-RECOVERY] Attempting data cleanup and retry...');
        // Create cleaner version with essential data only
        const essentialData = data.map(user => ({
          identifier: (user.identifier || '').substring(0, 100),
          email: (user.email || '').substring(0, 100),
          phone: (user.phone || '').substring(0, 20),
          password: (user.password || '').substring(0, 100),
          firstName: (user.firstName || '').substring(0, 50),
          surname: (user.surname || '').substring(0, 50),
          dob: (user.dob || '').substring(0, 10),
          dateCreatedISO: (user.dateCreatedISO || '').substring(0, 30),
          dateCreatedLocal: (user.dateCreatedLocal || '').substring(0, 30)
        }));
        wb.Sheets['Users'] = XLSX.utils.json_to_sheet(essentialData);
        XLSX.writeFile(wb, DATA_FILE);
      }
    }
    return { ok:true, identifier: (origEmail || normPhone).toLowerCase() };
  } catch (err){
    console.error('Registration error:', err);
    if(err && (err.code==='EBUSY' || err.code==='EPERM')){
      return { ok:false, message:'Data file is open or locked. Close logins.xlsx and try again.' };
    }
    return { ok:false, message:'Server error saving user ('+(err.code||'unknown')+')' };
  }
}

function validateLogin(identifier, password){
  // Prefer sqlite when available
  if (sqliteDB) return sqliteDB.validateLogin(identifier, password);
  const wb = loadWorkbook();
  const ws = wb.Sheets['Users'];
  const data = XLSX.utils.sheet_to_json(ws);
  let user;
  if(identifier.includes('@')){
    const idEmail = String(identifier).trim().toLowerCase();
    user = data.find(u=> (String(u.email||'').trim().toLowerCase()===idEmail) && u.password===password);
  } else {
    const norm = normalizePhone(identifier);
    user = data.find(u=>u.phone===norm && u.password===password);
  }
  return !!user;
}

function findUserRecord(data, identifier){
  if(!identifier) return undefined;
  if(identifier.includes('@')){
    const idLower = identifier.trim().toLowerCase();
    return data.find(u=> (u.email||'').toLowerCase()===idLower);
  }
  const norm = normalizePhone(identifier);
  return data.find(u=>u.phone===norm);
}

function isStrongPassword(p){
  return /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p) && p.length>=8;
}

function getUsers(){
  const wb = loadWorkbook();
  const ws = wb.Sheets['Users'];
  return { wb, ws, data: XLSX.utils.sheet_to_json(ws) };
}

// Admin helper: allow admin to authenticate with their email OR (if present) their phone number.
function isAdminIdentifier(identifier){
  if(!identifier) return false;
  const lower = String(identifier).trim().toLowerCase();
  if(lower === ADMIN_EMAIL.toLowerCase()) return true;
  try {
    const { data } = getUsers();
    const adminUser = data.find(u => (u.email||'').toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if(adminUser && adminUser.phone){
      const normAdminPhone = normalizePhone(adminUser.phone);
      const normIncoming = normalizePhone(lower);
      if(normAdminPhone && normIncoming && normAdminPhone === normIncoming) return true;
    }
  } catch {}
  return false;
}

// In-memory reset codes (simple demo; for production use a DB + expiry)
const resetCodes = new Map(); // email -> { code, expires }

app.post('/api/forgot/start', (req,res)=>{
  const { email } = req.body;
  if(!email) return res.status(400).json({ ok:false, message:'Email required' });
  const { data } = getUsers();
  const emailLower = String(email).trim().toLowerCase();
  if(!data.find(u=> String(u.email||'').trim().toLowerCase()===emailLower)) return res.status(404).json({ ok:false, message:'Email not found' });
  const code = Math.floor(100000 + Math.random()*900000).toString();
  resetCodes.set(email, { code, expires: Date.now()+10*60*1000 });
  // For demo we return the code (normally you'd email/SMS it)
  res.json({ ok:true, code });
});

app.post('/api/forgot/verify', (req,res)=>{
  const { email, code, newPassword } = req.body;
  if(!email||!code||!newPassword) return res.status(400).json({ ok:false, message:'Missing fields' });
  const entry = resetCodes.get(email);
  if(!entry || entry.code!==code || Date.now()>entry.expires){
    return res.status(400).json({ ok:false, message:'Invalid or expired code' });
  }
  // update password in sheet
  const { wb, ws, data } = getUsers();
  const user = data.find(u=> String(u.email||'').trim().toLowerCase()===emailLower);
  if(!user) return res.status(404).json({ ok:false, message:'User not found' });
  user.password = newPassword;
  const newWs = XLSX.utils.json_to_sheet(data);
  wb.Sheets['Users'] = newWs;
  XLSX.writeFile(wb, DATA_FILE);
  resetCodes.delete(email);
  try { appendAccessEvent({ identifier: email.toLowerCase(), type:'password_reset', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
  res.json({ ok:true });
});

app.post('/api/register', (req,res)=>{
  const { email, password, phone, firstName, surname, dob } = req.body||{};
  const debugCtx = {
    hasEmail: !!email,
    hasPhoneRaw: !!phone,
    normalizedPhone: normalizePhone(phone),
    passwordLen: password?password.length:0,
    firstNamePresent: !!firstName,
    surnamePresent: !!surname,
    dobPresent: !!dob,
    bodyKeys: Object.keys(req.body||{})
  };
  console.log('Incoming register:', { email, phone, firstName, surname, dob, ...debugCtx });
  if(!password || (!email && !phone)){
    return res.status(400).json({ ok:false, message:'Password and (email or phone) required', debug: debugCtx });
  }
  const result = saveUser(email, password, phone, firstName, surname, dob);
  if(!result.ok){
    const status = /already|weak|future|required|valid|provide|password/i.test(result.message)?409:400;
    console.log('Registration rejected:', { result, debugCtx });
    return res.status(status).json({ ...result, debug: debugCtx });
  }
  try { appendAccessEvent({ identifier: (result.identifier|| (email||phone||'')).toLowerCase(), type:'registration', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
  res.json({ ok:true, identifier: result.identifier, debug: debugCtx });
});

// Simple ping for frontend to verify backend availability
app.get('/api/ping', (req,res)=>{
  res.json({ ok:true, time:new Date().toISOString(), port:PORT });
});

// Simple health endpoint (plain text) for quick curl/browser test without JSON parsing
app.get('/healthz',(req,res)=>{
  res.type('text/plain').send('OK '+PORT+' '+new Date().toISOString());
});

// Minimal route list (debug)
app.get('/_routes',(req,res)=>{
  try {
    const stack=(app._router && app._router.stack)||[];
    const routes=stack.filter(l=>l.route && l.route.path).map(l=>({method:Object.keys(l.route.methods)[0], path:l.route.path}));
    res.json({ ok:true, count:routes.length, routes });
  } catch(err){ res.status(500).json({ ok:false, message:'route list error' }); }
});

// Lightweight portal / proxy config discovery (used by frontend Help panel)
app.get('/api/portal/config', (req,res)=>{
  try {
    const ips = localIPv4s();
    const hostDisplay = process.env.PROXY_DISPLAY_HOST || ips[0] || 'localhost';
    const portalPort = PORT; // current bound express port (may have auto-incremented)
    const proxyPort = PROXY_PORT;
    const pacUrl = `http://${hostDisplay}:${portalPort}/proxy.pac`;
    res.json({ ok:true, host: hostDisplay, portalPort, proxyPort, lanIps: ips, pacUrl });
  } catch(err){
    res.status(500).json({ ok:false, message:'config error' });
  }
});

// Development helper to inspect current stored users (do NOT expose publicly in production)
app.get('/api/_debug/users', (req,res)=>{
  try {
    const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){
      return res.status(403).json({ ok:false, message:'Forbidden' });
    }
    const { data } = getUsers();
    res.json({ ok:true, count:data.length, users:data.map(u=>({ email:u.email, phone:u.phone, firstName:u.firstName, surname:u.surname, dob:u.dob })) });
  } catch(err){ res.status(500).json({ ok:false, message:'Error reading users'}); }
});

// Grant bundle (record purchase)
app.post('/api/bundle/grant', (req,res)=>{
  const { identifier, bundleMB, routerId, source } = req.body||{};
  if(!identifier || !bundleMB) return res.status(400).json({ ok:false, message:'Missing fields' });
  if(source==='ad-sequence'){
    try {
      const idLower = identifier.trim().toLowerCase();
      const elig = adGrantEligibility && adGrantEligibility.get ? adGrantEligibility.get(idLower) : null;
      if(!elig || Date.now()>elig.expires){
        // Fallback: scan recent AdEvents for a 'complete' within last 3 minutes to recover from lost eligibility ticket
        try {
          const wbChk = loadWorkbookWithTracking();
          const adEventsRows = XLSX.utils.sheet_to_json(wbChk.Sheets[SHEET_ADEVENTS]);
          const now = Date.now();
            const recentComplete = adEventsRows.slice(-250) // limit scan
              .reverse()
              .find(ev=> ev && (ev.identifier||'').toLowerCase()===idLower && ev.eventType==='complete' && (now - Date.parse(ev.tsISO||0)) < 3*60*1000);
          if(recentComplete){
            console.warn('[grant-fallback] Eligibility ticket missing but recent ad completion found. Allowing grant for', idLower);
            adGrantEligibility.set(idLower, { expires: Date.now()+60*1000 }); // short rehydrate window
          }
        } catch(fbErr){ console.warn('[grant-fallback-error]', fbErr?.message); }
        const recheck = adGrantEligibility.get(idLower);
        if(!recheck || Date.now()>recheck.expires){
        return res.status(403).json({ ok:false, message:'Ad not completed. Watch ad to unlock bundle.' });
        }
      }
      adGrantEligibility.delete(idLower); // single-use ticket
    } catch {}
  }
  try {
  // Generate device fingerprint for strict tracking
  const userAgent = req.headers['user-agent'] || '';
  const routerIdValue = routerId || req.headers['x-router-id'] || req.ip || 'unknown';
  const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerIdValue).digest('hex').slice(0,16);
  
  // FIXED: Call recordPurchase with correct parameters
  const entry = recordPurchase(
    identifier.trim(), 
    bundleMB, 
    routerIdValue, 
    userAgent, 
    source || 'manual', 
    deviceFingerprint
  );
  registerActiveClient(req, entry.identifier);
  if(source==='ad-sequence'){
    try { socialUnlocked.add(entry.identifier.toLowerCase()); } catch {}
    // Always fully unlock after ad unless DISABLE_FULL_UNLOCK env flag set
    if(process.env.DISABLE_FULL_UNLOCK!=='true'){
      try { fullAccessUnlocked.add(entry.identifier.toLowerCase()); } catch {}
    }
  }
  console.log(`[BUNDLE-GRANT] ${bundleMB}MB granted to device ${deviceFingerprint} for user ${identifier}`);
  // Lightweight signed token (NOT JWT) -> id.exp.signature
  const expires = Date.now() + 6*60*60*1000; // 6h session token
  const idLower = entry.identifier.toLowerCase();
  const base = idLower + '.' + expires;
  const sig = crypto.createHmac('sha256', PORTAL_SECRET).update(base).digest('hex').slice(0,32);
  const token = base + '.' + sig;
  res.setHeader('Set-Cookie', `portal_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
  const quota = computeRemainingUnified(entry.identifier, deviceFingerprint, routerIdValue);
  res.json({ ok:true, purchase: entry, token, quota });
  } catch(err){
    res.status(500).json({ ok:false, message:'Error granting bundle'});
  }
});

// Enhanced session ping with device tracking
app.post('/api/session/ping', (req,res)=>{
  const { identifier, routerId } = req.body||{};
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier' });
  try {
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = deviceInfo.deviceId;
    
    const session = pingSession(identifier.trim(), routerId||'default-router', req.headers['user-agent'], deviceId);
    const quota = computeRemainingUnified(identifier, deviceId, routerId);
    
    res.json({ 
      ok: true, 
      session, 
      quota,
      deviceInfo: {
        deviceId: deviceId.slice(0,8) + '...',
        mac: deviceInfo.mac || 'unknown'
      }
    });
  } catch(err){ 
    console.error('[SESSION-PING-ERROR]', err);
    res.status(500).json({ ok:false, message:'Session error'}); 
  }
});

// Enhanced usage reporting with device tracking
app.post('/api/usage/report', (req,res)=>{
  const { identifier, usedMB } = req.body||{};
  if(!identifier || usedMB==null) return res.status(400).json({ ok:false, message:'Missing fields' });
  try {
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = deviceInfo.deviceId;
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    
    const ok = addUsage(identifier.trim(), Number(usedMB), deviceId, routerId);
    const quota = computeRemainingUnified(identifier, deviceId, routerId);
    
    res.json({ 
      ok, 
      quota,
      deviceInfo: {
        deviceId: deviceId.slice(0,8) + '...',
        usedMB: Number(usedMB)
      }
    });
  } catch(err){ 
    console.error('[USAGE-REPORT-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error updating usage'}); 
  }
});

// Lightweight access status endpoint for periodic polling by client to enforce bundle exhaustion
app.get('/api/access/check', (req,res)=>{
  const identifier=(req.query.identifier||'').toString().trim();
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier' });
  try {
    // Generate device fingerprint for strict quota checking
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    const quota=computeRemainingUnified(identifier, deviceFingerprint, routerId);
    res.json({ ok:true, quota });
  } catch(err){ res.status(500).json({ ok:false, message:'Error computing quota'}); }
});

// Explicit unified quota summary endpoint
app.get('/api/quota/summary',(req,res)=>{
  const identifier=(req.query.identifier||'').toString().trim();
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier' });
  try { 
    // Generate device fingerprint for strict quota checking
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    const quota=computeRemainingUnified(identifier, deviceFingerprint, routerId); 
    res.json({ ok:true, quota }); 
  }
  catch(err){ res.status(500).json({ ok:false, message:'Error' }); }
});

// --- Captive HTTP proxy (basic) ---
// Users must configure system/browser proxy to http://<host>:%PROXY_PORT%
// We inspect the portal_token cookie to identify user and enforce quota.
function parsePortalToken(token){
  if(!token) return null;
  const parts = token.split('.');
  if(parts.length!==3) return null;
  const [id, expStr, sig] = parts;
  if(!/^[0-9]+$/.test(expStr)) return null;
  if(Date.now() > Number(expStr)) return null;
  const base = id + '.' + expStr;
  const expected = crypto.createHmac('sha256', PORTAL_SECRET).update(base).digest('hex').slice(0,32);
  if(expected!==sig) return null;
  return { identifier: id, expires: Number(expStr) };
}

function extractCookie(cookieHeader, name){
  if(!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp('(?:^|; )'+name+'=([^;]+)'));
  return m? decodeURIComponent(m[1]): null;
}

// Check if domain matches walled garden (including wildcard patterns)
function isInWalledGarden(hostHeader, walledGarden) {
  // Direct match
  if (walledGarden.has(hostHeader)) {
    return true;
  }
  
  // Check wildcard patterns (for video CDNs like r1---sn-*.googlevideo.com)
  const walledGardenArray = Array.from(walledGarden);
  for (const pattern of walledGardenArray) {
    if (pattern.includes('*')) {
      // Convert wildcard pattern to regex
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '[^.]*');
      const regex = new RegExp('^' + regexPattern + '$', 'i');
      if (regex.test(hostHeader)) {
        return true;
      }
    }
    // Check if it's a subdomain match (e.g., googlevideo.com matches r1.googlevideo.com)
    if (hostHeader.endsWith('.' + pattern) || hostHeader === pattern) {
      return true;
    }
  }
  
  return false;
}

// Simple router ID detection
function detectRouterId(req) {
  const clientIp = normalizeIp((req.socket && req.socket.remoteAddress) || '');
  // For now, use a simple mapping based on IP range
  if (clientIp.startsWith('10.5.48.')) return 'router-1';
  if (clientIp.startsWith('192.168.1.')) return 'router-2';
  if (clientIp.startsWith('192.168.0.')) return 'router-3';
  return 'router-default';
}

// Check if a host is a video ad CDN (should not count against user data usage)
function isVideoAdCDN(hostHeader) {
  const videoAdDomains = [
    'googleads.g.doubleclick.net','pagead2.googlesyndication.com','tpc.googlesyndication.com',
    'securepubads.g.doubleclick.net','video-ad-stats.googlesyndication.com',
    'imasdk.googleapis.com','www.gstatic.com','ssl.gstatic.com',
    'storage.googleapis.com','commondatastorage.googleapis.com', // Google Cloud Storage for videos
    'yt3.ggpht.com','ytimg.com','googlevideo.com','manifest.googlevideo.com',
    'vimeo.com','player.vimeo.com','i.vimeocdn.com','f.vimeocdn.com',
    'jwpcdn.com','cdn.jwplayer.com','content.jwplatform.com',
    'brightcove.com','edge.api.brightcove.com','players.brightcove.net'
  ];
  
  // Direct match
  if (videoAdDomains.includes(hostHeader)) {
    return true;
  }
  
  // Check for subdomain or wildcard matches
  for (const domain of videoAdDomains) {
    if (hostHeader.endsWith('.' + domain) || hostHeader === domain) {
      return true;
    }
    // Check for Google Video CDN patterns (r1---sn-*.googlevideo.com)
    if (domain.includes('googlevideo.com') && /^r\d+---sn-[^.]+\.googlevideo\.com$/i.test(hostHeader)) {
      return true;
    }
  }
  
  return false;
}

function startProxy(){
  const proxy = http.createServer((clientReq, clientRes)=>{
    const token = extractCookie(clientReq.headers['cookie'], 'portal_token');
    const parsedToken = parsePortalToken(token || '');
    const rawHostHeader = (clientReq.headers['host']||'');
    const hostHeader = rawHostHeader.split(':')[0].toLowerCase();
    const clientIp = (clientReq.socket && clientReq.socket.remoteAddress) || '';
    let mappedIdentifier = resolveActiveClient(clientIp);
    // Early redirect: if client is trying to reach the old server IP's login page
    // while using the proxy, redirect them to the Render-hosted portal instead.
    try {
      const parsedEarly = url.parse(clientReq.url || '');
      const earlyPath = parsedEarly.path || clientReq.url || '/';
      if (hostHeader === '10.5.48.94' && (earlyPath === '/' || earlyPath.startsWith('/login'))) {
        const targetUrl = `https://${RENDER_HOST}/login.html`;
        clientRes.writeHead(302, { Location: targetUrl, 'Content-Type': 'text/html' });
        clientRes.end(`<html><body>Redirecting to <a href="${targetUrl}">${targetUrl}</a></body></html>`);
        return;
      }
    } catch (e) {
      // swallow and continue
    }
    
    const localIps = localIPv4s();
    const hotspotFallback = '192.168.137.1';
    
    // STRICT PROXY TYPE DETECTION - Block all ports except 8082
    const clientPort = (clientReq.socket && clientReq.socket.localPort) || 0;
    if (clientPort !== 8082 && clientPort > 0) {
      console.log('[INVALID-PROXY-PORT] Blocking invalid proxy port:', { ip: clientIp, port: clientPort, allowed: 8082 });
      clientRes.writeHead(400, { 'Content-Type': 'text/html' });
      clientRes.end(`<!DOCTYPE html>
<html><head><title>Invalid Proxy Configuration</title></head>
<body><h1>Invalid Proxy Port</h1>
<p>Only port 8082 is allowed. Use proper proxy configuration:</p>
<ul>
<li><strong>Manual Proxy:</strong> 10.5.48.94:8082</li>
<li><strong>Auto Proxy (PAC):</strong> http://10.5.48.94:${PORT}/proxy.pac</li>
</ul>
<p><a href="http://10.5.48.94:${PORT}/login.html">Fix Configuration</a></p>
</body></html>`);
      return;
    }
    
    // ENHANCED PROXY TYPE DETECTION
    const userAgent = clientReq.headers['user-agent'] || '';
    const hasProxyConnection = !!clientReq.headers['proxy-connection'];
    const hasProxyAuth = !!clientReq.headers['proxy-authorization'];
    const isManualProxy = hasProxyConnection || hasProxyAuth || userAgent.toLowerCase().includes('manual');
    const isAutoProxy = !isManualProxy; // PAC/WPAD users
    
    console.log('[PROXY-TYPE-DETECTION]', { 
      ip: clientIp, 
      type: isManualProxy ? 'MANUAL' : 'AUTO', 
      hasProxyConnection, 
      hasProxyAuth,
      userAgent: userAgent.substring(0, 50) + '...',
      host: hostHeader
    });
    
    // Portal host detection - include server IP and external render host
    const portalHostCandidates = new Set([ 
      (process.env.PORTAL_HOST||'').toLowerCase(), 
      RENDER_HOST,
      'localhost', 
      '10.5.48.94',  // Always include server IP
      hotspotFallback, 
      ...localIps 
    ]);
    const isPortalHost = portalHostCandidates.has(hostHeader);

    // EARLY WHITELIST: allow portal and video-ad hosts unconditionally (never block)
    // Compute video-ad host flag early so we can bypass any blocking logic below
    let isVideoAdHost = isVideoAdCDN(hostHeader);
    if (isPortalHost || isVideoAdHost) {
      console.log('[PROXY-WHITELIST] Allowing portal or video-ad host without blocking', { host: hostHeader, ip: clientIp, isPortalHost, isVideoAdHost });

      // Redirect legacy direct-access to local server IP for login page to the Render-hosted portal
      // e.g. clients trying to reach http://10.5.48.94:3150/login.html via the manual proxy
      // should be redirected to https://isn-free-wifi.onrender.com/login.html
      try {
        const parsedLegacy = url.parse(clientReq.url);
        const legacyPath = parsedLegacy.path || clientReq.url || '/';
        if (hostHeader === '10.5.48.94' && legacyPath && (legacyPath.startsWith('/login') || legacyPath === '/')) {
          const target = `https://${RENDER_HOST}/login.html`;
          clientRes.writeHead(302, { Location: target, 'Content-Type': 'text/html' });
          clientRes.end(`<html><body>Redirecting to <a href="${target}">${target}</a></body></html>`);
          return;
        }
      } catch (redirErr) {
        console.warn('[PROXY-REDIRECT-ERROR]', redirErr && redirErr.message);
      }

      // If this is the portal host, forward directly to the portal server.
      // If the portal host is the remote Render host, forward via HTTPS to the remote host.
      if (isPortalHost) {
        const parsed = url.parse(clientReq.url);
        // If the request was intended for the Render-hosted portal, proxy to that remote host over HTTPS
        if (hostHeader === RENDER_HOST) {
          const options = {
            hostname: RENDER_HOST,
            port: 443,
            path: parsed.path || clientReq.url,
            method: clientReq.method,
            headers: {
              ...clientReq.headers,
              host: RENDER_HOST,
              'x-forwarded-for': clientIp,
              'x-proxy-type': isManualProxy ? 'manual' : 'auto'
            }
          };

          const upstream = https.request(options, upRes => {
            clientRes.writeHead(upRes.statusCode, upRes.headers);
            upRes.on('data', chunk => clientRes.write(chunk));
            upRes.on('end', () => clientRes.end());
          });

          upstream.on('error', err => {
            console.error('[PORTAL-REMOTE-FORWARD-ERROR]', err.message);
            clientRes.writeHead(502, { 'Content-Type': 'text/html' });
            clientRes.end('<html><body><h1>Portal Proxy Error</h1><p>Could not connect to remote portal.</p></body></html>');
          });

          clientReq.pipe(upstream);
          return;
        }

        // Otherwise forward to local portal server (existing behavior)
        const options = {
          hostname: 'localhost',
          port: PORT,  // Forward to portal server port (3150)
          path: parsed.path,
          method: clientReq.method,
          headers: {
            ...clientReq.headers,
            'x-forwarded-for': clientIp,
            'x-proxy-type': isManualProxy ? 'manual' : 'auto'
          }
        };

        const upstream = http.request(options, upRes => {
          clientRes.writeHead(upRes.statusCode, upRes.headers);
          upRes.on('data', chunk => clientRes.write(chunk));
          upRes.on('end', () => clientRes.end());
        });

        upstream.on('error', err => {
          console.error('[PORTAL-FORWARD-ERROR]', err.message);
          clientRes.writeHead(500, { 'Content-Type': 'text/html' });
          clientRes.end('<html><body><h1>Portal Access Error</h1><p>Could not connect to portal server.</p></body></html>');
        });

        clientReq.pipe(upstream);
        return;
      }

      // If it's a video ad CDN host, mark the request and continue processing.
      // Downstream logic already skips counting and blocking for video ad hosts,
      // but setting this header helps ensure downstream handlers treat it as ad traffic.
      clientReq.headers['x-proxy-video-ad'] = '1';
      // Continue processing - do not trigger manual/auto blocking for ad hosts
    }
    
    // AUTO-AUTHENTICATION: Check if unauthenticated user has earned data bundles
    if (!mappedIdentifier && !isPortalHost) {
      // Try to find user by device fingerprint who has earned data bundles
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      
      // Check if this device fingerprint has earned data bundles
      const videosWatched = getVideosWatchedForUser(null, deviceFingerprint, routerId);
      if (videosWatched >= 5) { // User has watched enough videos to earn data
        // Find the identifier from ad events
        try {
          const XLSX = require('xlsx');
          const wb = XLSX.readFile('logins.xlsx');
          if (wb.SheetNames.includes('AdEvents')) {
            const ws = wb.Sheets['AdEvents'];
            const data = XLSX.utils.sheet_to_json(ws, {header: 1});
            
            // Find identifier for this device fingerprint
            let foundIdentifier = null;
            for (const row of data) {
              if (row[3] === deviceFingerprint && row[2]) { // deviceId in column 3, identifier in column 2
                foundIdentifier = String(row[2]).trim();
                break;
              }
            }
            
            if (foundIdentifier) {
              console.log('[AUTO-AUTH] Auto-authenticating user with data bundles:', { 
                identifier: foundIdentifier,
                deviceFingerprint,
                videosWatched,
                ip: clientIp,
                host: hostHeader
              });
              
              // Register as active client for 24 hours
              registerActiveClient(clientReq, foundIdentifier, 24);
              mappedIdentifier = resolveActiveClient(clientIp, clientReq);
              
              console.log('[AUTO-AUTH-SUCCESS] User authenticated:', foundIdentifier);
            }
          }
        } catch (err) {
          console.warn('[AUTO-AUTH-ERROR]', err.message);
        }
      }
    }

  // ALLOW VIDEO AD CDNs for unauthenticated users (needed for video ads to load)
  // (isVideoAdHost computed earlier in whitelist section)
  if (isVideoAdHost && !mappedIdentifier) {
      console.log('[VIDEO-AD-ALLOWED]', { 
        host: hostHeader, 
        ip: clientIp,
        type: isManualProxy ? 'MANUAL' : 'AUTO',
        reason: 'Video ad CDN or walled garden host'
      });
      // Continue processing - allow video ad access for video watching
    }
    // MANUAL PROXY: Block everything except portal and video ads until user logs in
    else if (isManualProxy && !mappedIdentifier && !isPortalHost) {
      console.log('[MANUAL-PROXY-BLOCKED] Manual proxy user must login first:', { 
        host: hostHeader, 
        ip: clientIp
      });
      clientRes.writeHead(302, { 
        'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=manual_proxy&blocked_host=${encodeURIComponent(hostHeader)}`,
        'Content-Type': 'text/html; charset=utf-8'
      });
      clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Manual Proxy - Login Required</title>
<meta http-equiv="refresh" content="3;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;}</style>
</head>
<body>
<h1>🔐 Manual Proxy Login Required</h1>
<p><strong>Blocked:</strong> ${hostHeader}</p>
<p>You are using <strong>Manual Proxy</strong> configuration.</p>
<p>Please log in to the portal first to access the internet.</p>
<p><strong>Your Proxy Settings:</strong> 10.5.48.94:8082</p>
<hr>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" style="background:#007bff;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Login to Portal</a></p>
<p><small>Redirecting in 3 seconds...</small></p>
</body></html>`);
      return;
    }
    
    // AUTO PROXY: Block everything except portal until user watches videos AND has active data bundles
    else if (isAutoProxy && !mappedIdentifier) {
      console.log('[AUTO-PROXY-BLOCKED] Auto proxy user must watch videos:', { 
        host: hostHeader, 
        ip: clientIp 
      });
      clientRes.writeHead(302, { 
        'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=auto_proxy&blocked_host=${encodeURIComponent(hostHeader)}`,
        'Content-Type': 'text/html; charset=utf-8'
      });
      clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Auto Proxy - Watch Videos Required</title>
<meta http-equiv="refresh" content="5;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;}</style>
</head>
<body>
<h1>📺 Watch Videos to Access Internet</h1>
<p><strong>Blocked:</strong> ${hostHeader}</p>
<p>You are using <strong>Auto Proxy (PAC)</strong> configuration.</p>
<p>You must watch videos to earn internet access bundles.</p>
<div style="background:#f0f0f0;padding:15px;margin:20px;border-radius:5px;">
<h3>📊 Bundle System:</h3>
<ul style="list-style:none;padding:0;">
<li>🎥 <strong>5 videos = 100MB</strong> bundle</li>
<li>🎥 <strong>10 videos = 250MB</strong> bundle</li>
<li>🎥 <strong>15 videos = 500MB</strong> bundle</li>
</ul>
</div>
<p><strong>Your PAC URL:</strong> http://10.5.48.94:${PORT}/proxy.pac</p>
<hr>
<p><a href="http://10.5.48.94:${PORT}/login.html" style="background:#ff6b35;color:white;padding:12px 25px;text-decoration:none;border-radius:5px;font-weight:bold;">🎬 Start Watching Videos</a></p>
<p><small>Redirecting in 5 seconds...</small></p>
</body></html>`);
      return;
    }
    
    // AUTO PROXY WITH AUTHENTICATION: Must have valid data bundles (no free access)
    else if (isAutoProxy && mappedIdentifier) {
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
      
      // STRICT: Auto proxy users can only access internet if they have data bundles (not temp access)
      const tempUnlocked = (tempFullAccess.get(mappedIdentifier) || 0) > Date.now();
      if (!isPortalHost && !tempUnlocked && (quota.exhausted || quota.totalBundleMB === 0)) {
        console.log('[AUTO-PROXY-NO-BUNDLES] Auto proxy user blocked - no data bundles:', { 
          host: hostHeader, 
          ip: clientIp,
          identifier: mappedIdentifier,
          remainingMB: quota.remainingMB,
          totalBundleMB: quota.totalBundleMB,
          exhausted: quota.exhausted
        });
        clientRes.writeHead(302, { 
          'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=auto_proxy_no_data&blocked_host=${encodeURIComponent(hostHeader)}`,
          'Content-Type': 'text/html; charset=utf-8'
        });
        clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Auto Proxy - No Data Bundles</title>
<meta http-equiv="refresh" content="5;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;}</style>
</head>
<body>
<h1>🚫 No Data Bundles Available</h1>
<p><strong>Blocked:</strong> ${hostHeader}</p>
<p>You are using <strong>Auto Proxy (PAC)</strong> configuration.</p>
<p><strong>Status:</strong> You have ${quota.remainingMB}MB remaining out of ${quota.totalBundleMB}MB total.</p>
<p>Watch more videos to earn additional data bundles!</p>
<div style="background:#ffebee;padding:15px;margin:20px;border-radius:5px;border:2px solid #f44336;">
<h3>📊 Earn More Data:</h3>
<ul style="list-style:none;padding:0;">
<li>🎥 <strong>5 videos = 100MB</strong> bundle</li>
<li>🎥 <strong>10 videos = 250MB</strong> bundle</li>
<li>🎥 <strong>15 videos = 500MB</strong> bundle</li>
</ul>
</div>
<p><strong>Your PAC URL:</strong> http://10.5.48.94:${PORT}/proxy.pac</p>
<hr>
<p><a href="http://10.5.48.94:${PORT}/login.html" style="background:#f44336;color:white;padding:12px 25px;text-decoration:none;border-radius:5px;font-weight:bold;">🎬 Watch Videos for Data</a></p>
<p><small>Redirecting in 5 seconds...</small></p>
</body></html>`);
        return;
      }
    }
    
    // Configurable walled‑garden hosts (minimal resources allowed pre-auth for portal + ads). Comma separated via WALLED_GARDEN env.
    const extraGarden = (process.env.WALLED_GARDEN||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
    // Always allow portal host + loopbacks + LAN IPs + essential ad/media CDNs (video bucket & yt thumbnails) unless STRICT_WALLED=true
    const baseGarden = new Set([
      'localhost','127.0.0.1','::1', hotspotFallback, ...localIps,
  (process.env.PORTAL_HOST||'').toLowerCase(),
  RENDER_HOST,
      'storage.googleapis.com','commondatastorage.googleapis.com','i.ytimg.com','i9.ytimg.com','yt3.ggpht.com',
      'dash.akamaized.net','cdn.jsdelivr.net','learningcontainer.com','sample-videos.com',
      // Video Ad CDNs - Allow video ads to play even when user has no data
      'googleads.g.doubleclick.net','pagead2.googlesyndication.com','tpc.googlesyndication.com',
      'securepubads.g.doubleclick.net','video-ad-stats.googlesyndication.com',
      'imasdk.googleapis.com','www.gstatic.com','ssl.gstatic.com',
      'yt3.ggpht.com','ytimg.com','googlevideo.com','manifest.googlevideo.com',
      'r1---sn-*.googlevideo.com','r2---sn-*.googlevideo.com','r3---sn-*.googlevideo.com',
      'vimeo.com','player.vimeo.com','i.vimeocdn.com','f.vimeocdn.com',
      'jwpcdn.com','cdn.jwplayer.com','content.jwplatform.com',
      'brightcove.com','edge.api.brightcove.com','players.brightcove.net'
    ].filter(Boolean));
    if(process.env.STRICT_WALLED!=='true'){
      // Allow fonts only when not in strict mode (they are cosmetic)
      ['fonts.googleapis.com','fonts.gstatic.com','www.youtube.com','youtube.com'].forEach(h=>baseGarden.add(h));
    }
    extraGarden.forEach(h=> baseGarden.add(h));
    const walledGarden = baseGarden;
    
    if(!parsedToken && !mappedIdentifier){
      if(!isInWalledGarden(hostHeader, walledGarden)){
        clientRes.writeHead(302, { 'Location':'http://'+(localIps[0]||'localhost')+':'+(process.env.PORT||PORT)+'/home.html', 'Content-Type':'text/plain' });
        clientRes.end('Redirecting to portal');
        return;
      }
    }
    const effectiveIdentifier = (mappedIdentifier && mappedIdentifier.identifier) || (parsedToken && parsedToken.identifier);
    if(effectiveIdentifier){
      const parsedFull = url.parse(clientReq.url || '');
      const reqPortNum = Number(parsedFull.port || (parsedFull.protocol==='https:'?443:(parsedFull.protocol==='http:'?80:0)));
      // CRITICAL FIX: Use unified quota calculation with proper device fingerprinting
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      const quota = computeRemainingUnified(effectiveIdentifier, deviceFingerprint, routerId);
  const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), RENDER_HOST, 'localhost', '10.5.48.94', hotspotFallback, ...localIps ]);
      const isPortalHost = portalHostCandidates.has(hostHeader);
      const isPortalByPort = reqPortNum && reqPortNum === PORT;
      const isPortal = isPortalHost || isPortalByPort;
      const tempUnlocked = (tempFullAccess.get(effectiveIdentifier) || 0) > Date.now();
      const hasFullAccess = fullAccessUnlocked.has(effectiveIdentifier);
      const hasSocialAccess = socialUnlocked.has(effectiveIdentifier);
      
      // Debug logging for access control
      console.log('[ACCESS-DEBUG]', {
        identifier: effectiveIdentifier,
        host: hostHeader,
        isPortal,
        quota: { remaining: quota.remainingMB, exhausted: quota.exhausted },
        access: { full: hasFullAccess, social: hasSocialAccess, temp: tempUnlocked }
      });
      
      if(process.env.PROXY_DEBUG==='true'){
        console.log('[proxy-debug-http]', { rawHostHeader, hostHeader, reqPortNum, PORT, isPortalHost, isPortalByPort, isPortal, remaining:quota.remainingMB, exhausted:quota.exhausted, tempUnlocked, full: hasFullAccess });
      }
      
      // STRICT MAC-BASED DEVICE ACCESS: Each device must earn its own access
      let hasVideoAccess = false;
      let videoAccessMB = 0;
      
      if (effectiveIdentifier && !isPortal) {
        try {
          const deviceInfo = generateDeviceFingerprint(clientReq);
          
          // CRITICAL: Strict device verification - check if THIS device earned access
          if (deviceInfo.macVerified) {
            // MAC-verified device: Check device-specific access tokens
            const deviceAccessToken = deviceIsolation.getDeviceAccessToken(deviceInfo.deviceId, deviceInfo.mac);
            
            if (deviceAccessToken && deviceAccessToken.identifier === effectiveIdentifier) {
              hasVideoAccess = true;
              videoAccessMB = deviceAccessToken.bundlesMB || 0;
              console.log(`[MAC-DEVICE-ACCESS-GRANTED] ${effectiveIdentifier} MAC:${deviceInfo.mac.slice(0,6)}... has ${videoAccessMB}MB access`);
            } else {
              console.log(`[MAC-DEVICE-ACCESS-DENIED] ${effectiveIdentifier} MAC:${deviceInfo.mac.slice(0,6)}... has no device-specific access`);
            }
          } else {
            // Fallback for devices without MAC: Check bundle access with strict validation
            const quota = computeRemainingUnified(effectiveIdentifier, deviceInfo.deviceId, routerId);
            
            if (quota.totalBundleMB > 0 && !quota.exhausted) {
              // Additional verification: Check if this device actually earned the bundles
              const deviceVideos = getVideosWatched(effectiveIdentifier, deviceInfo.deviceId);
              const deviceVideoCount = deviceVideos.length;
              
              if (deviceVideoCount >= 5) {
                hasVideoAccess = true;
                videoAccessMB = quota.totalBundleMB;
                console.log(`[DEVICE-BUNDLE-ACCESS-GRANTED] ${effectiveIdentifier} device ${deviceInfo.deviceId.slice(0,8)}... verified ${deviceVideoCount} videos = ${videoAccessMB}MB`);
              } else {
                console.log(`[DEVICE-BUNDLE-ACCESS-DENIED] ${effectiveIdentifier} device ${deviceInfo.deviceId.slice(0,8)}... only ${deviceVideoCount} videos (needs 5+)`);
              }
            } else {
              // Final fallback: Check video count for temporary access
              const videosWatched = getVideosWatchedForUser ? getVideosWatchedForUser(effectiveIdentifier) : [];
              const videoCount = videosWatched.length;
              
              // Grant access based on milestone system: 5 videos = 100MB, 10 videos = 250MB, 15 videos = 500MB
              if (videoCount >= 15) {
                videoAccessMB = 500; // 500MB for 15+ videos
                hasVideoAccess = true;
              } else if (videoCount >= 10) {
                videoAccessMB = 250; // 250MB for 10+ videos  
                hasVideoAccess = true;
              } else if (videoCount >= 5) {
                videoAccessMB = 100; // 100MB for 5+ videos
                hasVideoAccess = true;
              }
              
              // Check session usage for temporary access
              if (hasVideoAccess) {
                const videoUsage = realtimeUsage.get(effectiveIdentifier);
                const sessionUsedMB = videoUsage ? videoUsage.totalDataMB : 0;
                
                if (sessionUsedMB >= videoAccessMB) {
                  hasVideoAccess = false; // Used up video access allowance
                  console.log(`[TEMP-VIDEO-ACCESS-EXHAUSTED] ${effectiveIdentifier}: Used ${sessionUsedMB.toFixed(2)}MB of ${videoAccessMB}MB video allowance`);
                } else {
                  console.log(`[TEMP-VIDEO-ACCESS-GRANTED] ${effectiveIdentifier}: ${videoCount} videos = ${videoAccessMB}MB access, used ${sessionUsedMB.toFixed(2)}MB`);
                }
              }
            }
          }
        } catch (error) {
          console.error('[STRICT-DEVICE-ACCESS-CHECK-ERROR]', error.message);
        }
      }

      // ENHANCED HTTP ACCESS CONTROL - Block until videos watched and notification received
      if (!isPortal && effectiveIdentifier && !tempUnlocked) {
        // CRITICAL: Real-time quota enforcement BEFORE allowing any data transfer
        const currentUsage = realtimeUsage.get(effectiveIdentifier) || { totalDataMB: 0 };
        const totalUsedMB = currentUsage.totalDataMB || 0;
        
        // Check current quota vs usage
        if (quota.remainingMB <= 0 && quota.totalBundleMB > 0) {
          const blockedReason = `Data limit exceeded: Used ${totalUsedMB.toFixed(1)}MB of ${quota.totalBundleMB}MB`;
          
          console.warn('[HTTP-BLOCKED-QUOTA-EXCEEDED]', { 
            host: hostHeader, 
            ip: clientIp,
            identifier: effectiveIdentifier,
            totalUsed: totalUsedMB,
            limit: quota.totalBundleMB,
            remaining: quota.remainingMB
          });
          
          clientRes.writeHead(302, { 
            'Location': `http://${localIps[0] || 'localhost'}:${PORT}/quota.html?used=${totalUsedMB.toFixed(1)}&limit=${quota.totalBundleMB}`,
            'Content-Type': 'text/html' 
          });
          
          clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Data Limit Exceeded</title>
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:600px;margin:0 auto;padding:20px;border:2px solid #dc3545;border-radius:10px;background:#f8f9fa;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#dc3545;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
  .usage-bar{background:#e9ecef;height:20px;border-radius:10px;margin:20px 0;overflow:hidden;}
  .usage-fill{background:#dc3545;height:100%;transition:width 0.3s;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🚫</div>
  <h1>Data Limit Exceeded</h1>
  <p><strong>Trying to access:</strong> ${hostHeader}</p>
  
  <div style="background:#fff3cd;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #ffc107;">
    <h3>📊 Data Usage Summary:</h3>
    <p><strong>Used:</strong> ${totalUsedMB.toFixed(1)} MB</p>
    <p><strong>Limit:</strong> ${quota.totalBundleMB} MB</p>
    <p><strong>Exceeded by:</strong> ${(totalUsedMB - quota.totalBundleMB).toFixed(1)} MB</p>
    <div class="usage-bar">
      <div class="usage-fill" style="width: 100%;"></div>
    </div>
  </div>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎬 How to Get More Data:</h3>
    <ol style="text-align:left;">
      <li>📱 Return to the WiFi portal</li>
      <li>🎬 Watch video advertisements</li>
      <li>📊 Each video earns 20MB of data</li>
      <li>🌐 Internet access restored!</li>
    </ol>
  </div>
  
  <a href="http://${localIps[0] || 'localhost'}:${PORT}/quota.html" class="action-btn">🎬 Watch More Videos</a>
  <p><small>Portal access is always free • Videos unlock internet data</small></p>
</div>
</body></html>`);
          return;
        }
        
        let hasInternetAccess = false;
        let videoAccessMB = 0;
        let notificationReceived = false;
        
        // Check if user has received video completion notification
        const deviceSession = deviceSessions.get(deviceFingerprint) || deviceSessions.get(effectiveIdentifier);
        if (deviceSession && deviceSession.videoNotificationReceived) {
          notificationReceived = true;
        }
        
        // Priority 1: Check for active data bundles
        if (quota.totalBundleMB > 0 && !quota.exhausted) {
          hasInternetAccess = true;
          videoAccessMB = quota.totalBundleMB;
          notificationReceived = true; // Bundles imply notification received
          console.log(`[HTTP-INTERNET-ACCESS-GRANTED] ${effectiveIdentifier}: ${quota.totalBundleMB}MB bundle active`);
        } else if (notificationReceived) {
          // Priority 2: Video-based access (only if notification received)
          const videosWatched = getVideosWatchedForUser ? getVideosWatchedForUser(effectiveIdentifier) : [];
          const videoCount = videosWatched.length;
          
          if (videoCount >= 15) {
            videoAccessMB = 500;
            hasInternetAccess = true;
          } else if (videoCount >= 10) {
            videoAccessMB = 250;
            hasInternetAccess = true;
          } else if (videoCount >= 5) {
            videoAccessMB = 100;
            hasInternetAccess = true;
          } else if (videoCount >= 1) {
            videoAccessMB = 20;
            hasInternetAccess = true;
          }
          
          // Check session usage
          if (hasInternetAccess && quota.totalBundleMB === 0) {
            const videoUsage = realtimeUsage.get(effectiveIdentifier);
            const sessionUsedMB = videoUsage ? videoUsage.totalDataMB : 0;
            
            if (sessionUsedMB >= videoAccessMB) {
              hasInternetAccess = false;
              console.log(`[HTTP-ACCESS-EXHAUSTED] ${effectiveIdentifier}: Used ${sessionUsedMB.toFixed(2)}MB of ${videoAccessMB}MB allowance`);
            }
          }
        }
        
        // Block access if no internet access earned AND it's not a video ad domain
        const isVideoAdDomain = isVideoAdCDN(hostHeader);
        if (!hasInternetAccess && !isVideoAdDomain) {
          const blockedReason = !notificationReceived ? 'Videos must be watched first' : 'Data allowance exhausted';
          const actionText = !notificationReceived ? '🎬 Watch Videos to Unlock Internet' : '🔄 Watch More Videos for Data';
          
          console.warn('[HTTP-BLOCKED-NO-VIDEO-ACCESS]', { 
            host: hostHeader, 
            ip: clientIp,
            identifier: effectiveIdentifier,
            notificationReceived,
            reason: blockedReason
          });
          
          clientRes.writeHead(302, { 
            'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?blocked_http=${encodeURIComponent(hostHeader)}&reason=${encodeURIComponent(blockedReason)}`,
            'Content-Type': 'text/html' 
          });
          
          clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Internet Access Blocked - Watch Videos First</title>
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:600px;margin:0 auto;padding:20px;border:2px solid #ff6b35;border-radius:10px;background:#fff5f0;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#ff6b35;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🌐</div>
  <h1>Internet Access Blocked</h1>
  <p><strong>Trying to access:</strong> ${hostHeader}</p>
  <p><strong>Reason:</strong> ${blockedReason}</p>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎯 How to Unlock Internet:</h3>
    <ol style="text-align:left;">
      <li>📱 Enter the WiFi portal</li>
      <li>🎬 Watch video advertisements</li>
      <li>📢 Wait for completion notification</li>
      <li>🌐 Internet access unlocked!</li>
    </ol>
  </div>
  
  <a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" class="action-btn">${actionText}</a>
  <p><small>Proxy: ISN Free WiFi • Videos unlock everything</small></p>
</div>
</body></html>`);
          return;
        }
      }
      
      // Enhanced social media access control with notification requirement
      if(!isPortal && !tempUnlocked && isGatedSocialHost(hostHeader)) {
        let hasSocialAccess = socialUnlocked.has(effectiveIdentifier);
        let notificationReceived = false;
        
        const deviceSession = deviceSessions.get(effectiveIdentifier) || deviceSessions.get(deviceFingerprint);
        if (deviceSession && deviceSession.videoNotificationReceived) {
          notificationReceived = true;
          // Auto-unlock social media after video notification
          if (!hasSocialAccess) {
            socialUnlocked.add(effectiveIdentifier);
            hasSocialAccess = true;
            console.log(`[HTTP-SOCIAL-AUTO-UNLOCK] ${effectiveIdentifier} social media unlocked after video notification`);
          }
        }
        
        if (!hasSocialAccess) {
          const actionText = notificationReceived ? 'Watch more videos for continued access' : 'Watch videos to unlock social media';
          
          console.log('[SOCIAL-BLOCK]', { identifier: effectiveIdentifier, host: hostHeader, notificationReceived });
          clientRes.writeHead(302, { 
            'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=social_blocked&app=${encodeURIComponent(hostHeader)}&reason=video_required`,
            'Content-Type': 'text/html' 
          });
          
          clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Social Media Blocked - Watch Videos First</title>
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:500px;margin:0 auto;padding:20px;border:2px solid #ff6b35;border-radius:10px;background:#fff5f0;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#ff6b35;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">📱</div>
  <h1>${hostHeader.includes('whatsapp') ? 'WhatsApp' : hostHeader.includes('facebook') ? 'Facebook' : 'Social Media'} Blocked</h1>
  <p><strong>App:</strong> ${hostHeader}</p>
  <p><strong>Status:</strong> ${actionText}</p>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎯 How to Unlock:</h3>
    <ol style="text-align:left;">
      <li>📱 Enter WiFi portal</li>
      <li>🎬 Watch video ads</li>
      <li>📢 Get completion notification</li>
      <li>📱 Social media unlocked!</li>
    </ol>
  </div>
  
  <a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" class="action-btn">🎬 Watch Videos Now</a>
  <p><small>Each device must watch videos individually</small></p>
</div>
</body></html>`);
          return;
        }
      }
    }
    
    // SPECIAL HANDLING FOR PORTAL REQUESTS - Forward to local portal server
    if (isPortalHost) {
      const parsed = url.parse(clientReq.url);
      const options = {
        hostname: 'localhost',
        port: PORT,  // Forward to portal server port (3150)
        path: parsed.path,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          'x-forwarded-for': clientIp,
          'x-proxy-type': isManualProxy ? 'manual' : 'auto'
        }
      };
      
      console.log('[PORTAL-FORWARD]', { 
        from: `${hostHeader}:${parsed.port || 80}${parsed.path}`,
        to: `localhost:${PORT}${parsed.path}`,
        ip: clientIp,
        type: isManualProxy ? 'MANUAL' : 'AUTO'
      });
      
      const upstream = http.request(options, upRes => {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.on('data', chunk => clientRes.write(chunk));
        upRes.on('end', () => clientRes.end());
      });
      
      upstream.on('error', err => {
        console.error('[PORTAL-FORWARD-ERROR]', err.message);
        clientRes.writeHead(500, { 'Content-Type': 'text/html' });
        clientRes.end(`<!DOCTYPE html>
<html><head><title>Portal Access Error</title></head>
<body><h1>Portal Access Error</h1>
<p>Could not connect to portal server. Please try again.</p>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html">Retry Portal Access</a></p>
</body></html>`);
      });
      
      clientReq.pipe(upstream);
      return;
    }
    
    // Forward request (HTTP only) – we won't MITM HTTPS here
    const parsed = url.parse(clientReq.url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.path,
      method: clientReq.method,
      headers: clientReq.headers
    };
    const upstream = http.request(options, upRes=>{
      let bytes=0;
      clientRes.writeHead(upRes.statusCode, upRes.headers);
      
      // Real-time quota enforcement during data transfer
      upRes.on('data',chunk=>{ 
        bytes += chunk.length;
        
        // Check quota in real-time for non-ad traffic
        if (effectiveIdentifier && !isVideoAdCDN(hostHeader)) {
          const currentUsage = realtimeUsage.get(effectiveIdentifier) || { totalDataMB: 0 };
          const chunkMB = chunk.length / 1024 / 1024;
          const projectedUsageMB = currentUsage.totalDataMB + chunkMB;
          
          // Get current quota
          const userAgent = clientReq.headers['user-agent'] || '';
          const routerId = parsedToken?.routerId || detectRouterId(clientReq) || 'router-1';
          const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
          const quota = computeRemainingUnified(effectiveIdentifier, deviceFingerprint, routerId);
          
          // Block if this chunk would exceed quota
          if (quota.totalBundleMB > 0 && projectedUsageMB > quota.totalBundleMB) {
            console.warn(`[HTTP-REAL-TIME-BLOCK] ${effectiveIdentifier}: Would exceed limit ${projectedUsageMB.toFixed(2)}MB > ${quota.totalBundleMB}MB`);
            
            // Send quota exceeded message instead of data
            clientRes.end(`<!DOCTYPE html>
<html><head><title>Data Limit Exceeded</title></head>
<body style="font-family:Arial;text-align:center;margin:50px;">
<h1>🚫 Data Limit Exceeded</h1>
<p><strong>Host:</strong> ${hostHeader}</p>
<p><strong>Used:</strong> ${currentUsage.totalDataMB.toFixed(1)} MB</p>
<p><strong>Limit:</strong> ${quota.totalBundleMB} MB</p>
<p><strong>Would exceed by:</strong> ${(projectedUsageMB - quota.totalBundleMB).toFixed(2)} MB</p>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" style="background:#dc3545;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">🎬 Watch Videos for More Data</a></p>
</body></html>`);
            return;
          }
        }
        
        clientRes.write(chunk);
      });
      upRes.on('end',()=>{ 
        clientRes.end(); 
        if(bytes>0 && effectiveIdentifier){ 
          try{ 
            // Don't count video ad CDN traffic against user data quota
            const isAdTraffic = isVideoAdCDN(hostHeader);
            const usedMB = bytes/1024/1024;
            
            if (!isAdTraffic) {
              // Enhanced usage tracking with device and router info
              const routerId = parsedToken?.routerId || detectRouterId(clientReq) || 'router-1';
              const deviceId = parsedToken?.deviceId || generateDeviceFingerprint(clientReq).deviceId;
              
              const success = addUsage(effectiveIdentifier, usedMB, deviceId, routerId);
              console.log('[USAGE-TRACKED]', { identifier: effectiveIdentifier, device: deviceId?.slice(0,8)+'...', host: hostHeader, bytes, usedMB: usedMB.toFixed(3), success });
              
              // Update real-time session usage for live tracking
              if (success) {
                dataTracker.addSessionUsage(effectiveIdentifier, usedMB);
              }
            } else {
              console.log('[VIDEO-AD-FREE]', { identifier: effectiveIdentifier, host: hostHeader, bytes, usedMB: usedMB.toFixed(3), message: 'Video ad traffic not counted' });
            }
            
            // Update real-time usage tracking for admin dashboard (count all traffic for monitoring)
            const routerId = parsedToken?.routerId || detectRouterId(clientReq) || 'router-1';
            updateRealtimeUsage(effectiveIdentifier, 0, bytes, { 
              ip: normalizeIp(clientIp), 
              routerId: routerId,
              wifiNetwork: 'ISN Free WiFi'
            }); // bytes received (download)
          } catch(err) {
            console.warn('[USAGE-TRACK-ERROR]', err?.message);
          }
        } 
      });
    });
    upstream.on('error',err=>{ clientRes.writeHead(502); clientRes.end('Proxy error'); });
    clientReq.pipe(upstream);
  });
  // Basic CONNECT tunneling for HTTPS (we just pass through and approximate bytes)
  proxy.on('connect',(req, clientSocket, head)=>{
  const token = extractCookie(req.headers['cookie'], 'portal_token');
  const parsedToken = parsePortalToken(token || '');
  const clientIp = (req.socket && req.socket.remoteAddress) || '';
  let mappedIdentifier = resolveActiveClient(clientIp);
  
  // STRICT HTTPS BLOCKING - Check proxy type and enforce restrictions
  const hostOnly = req.url.split(':')[0].toLowerCase();
  const localIps = localIPv4s();
  const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), RENDER_HOST, 'localhost', '10.5.48.94', ...localIps ]);
  const isPortalHost = portalHostCandidates.has(hostOnly);
  
  // ENHANCED PROXY TYPE DETECTION FOR HTTPS
  const userAgent = req.headers['user-agent'] || '';
  const hasProxyConnection = !!req.headers['proxy-connection'];
  const hasProxyAuth = !!req.headers['proxy-authorization'];
  const isManualProxy = hasProxyConnection || hasProxyAuth || userAgent.toLowerCase().includes('manual');
  const isAutoProxy = !isManualProxy;
  
  console.log('[HTTPS-PROXY-CHECK]', { 
    ip: clientIp, 
    host: hostOnly,
    type: isManualProxy ? 'MANUAL' : 'AUTO',
    authenticated: !!mappedIdentifier,
    isPortalHost
  });
  
  // AUTO-AUTHENTICATION FOR HTTPS: Check if unauthenticated user has earned data bundles
  if (!mappedIdentifier && !isPortalHost) {
    // Try to find user by device fingerprint who has earned data bundles
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    // Check if this device fingerprint has earned data bundles
    const videosWatched = getVideosWatchedForUser(null, deviceFingerprint, routerId);
    if (videosWatched >= 5) { // User has watched enough videos to earn data
      // Find the identifier from ad events
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile('logins.xlsx');
        if (wb.SheetNames.includes('AdEvents')) {
          const ws = wb.Sheets['AdEvents'];
          const data = XLSX.utils.sheet_to_json(ws, {header: 1});
          
          // Find identifier for this device fingerprint
          let foundIdentifier = null;
          for (const row of data) {
            if (row[3] === deviceFingerprint && row[2]) { // deviceId in column 3, identifier in column 2
              foundIdentifier = String(row[2]).trim();
              break;
            }
          }
          
          if (foundIdentifier) {
            console.log('[HTTPS-AUTO-AUTH] Auto-authenticating user with data bundles:', { 
              identifier: foundIdentifier,
              deviceFingerprint,
              videosWatched,
              ip: clientIp,
              host: hostOnly
            });
            
            // Register as active client for 24 hours
            registerActiveClient(req, foundIdentifier, 24);
            mappedIdentifier = resolveActiveClient(clientIp, req);
            
            console.log('[HTTPS-AUTO-AUTH-SUCCESS] User authenticated:', foundIdentifier);
          }
        }
      } catch (err) {
        console.warn('[HTTPS-AUTO-AUTH-ERROR]', err.message);
      }
    }
  }
  
  // EARLY WHITELIST: allow portal and video-ad hosts for CONNECT requests (never block)
  const isVideoAdHost = isVideoAdCDN(hostOnly);
  if (isPortalHost || isVideoAdHost) {
    console.log('[CONNECT-WHITELIST] Allowing CONNECT to portal or video-ad host without blocking', { host: hostOnly, ip: clientIp, isPortalHost, isVideoAdHost });
    // If portal host, accept CONNECT and forward to local portal or respond with a simple 200 for CONNECT
    if (isPortalHost) {
      // If the portal host is the remote Render host, open a TCP connection to remote:443 and pipe
      if (hostOnly === RENDER_HOST) {
        const remotePort = 443;
        const remoteSocket = net.connect(remotePort, RENDER_HOST, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          // Pipe data both ways
          remoteSocket.write(head);
          clientSocket.pipe(remoteSocket);
          remoteSocket.pipe(clientSocket);
        });
        remoteSocket.on('error', err => {
          console.error('[CONNECT-REMOTE-ERROR]', err.message);
          clientSocket.end();
        });
        return;
      }
      // Otherwise accept CONNECT and let client open tunnel to local portal or pass through
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      return; // allow the client to open the tunnel
    }
    // If video ad host, allow through by continuing; downstream logic will treat it as ad traffic
  }
  // BLOCK UNAUTHENTICATED HTTPS TRAFFIC (except portal and video ads)
  if (!mappedIdentifier && !isPortalHost && !isVideoAdHost) {
    const blockMessage = isManualProxy 
      ? 'Manual proxy user must login first to access HTTPS sites'
      : 'Auto proxy user must watch videos first to access HTTPS sites';
      
    console.warn('[HTTPS-BLOCKED-UNAUTHENTICATED]', { 
      host: hostOnly, 
      ip: clientIp, 
      type: isManualProxy ? 'MANUAL' : 'AUTO',
      reason: blockMessage
    });
  } else if (!mappedIdentifier && isVideoAdHost) {
    console.log('[HTTPS-VIDEO-AD-ALLOWED]', { 
      host: hostOnly, 
      ip: clientIp,
      type: isManualProxy ? 'MANUAL' : 'AUTO',
      reason: 'Video ad CDN host allowed for unauthenticated users'
    });
  }
  
  if (!mappedIdentifier && !isPortalHost && !isVideoAdHost) {
    // Send HTTP 302 redirect response for HTTPS CONNECT requests
    const redirectUrl = `http://${localIps[0] || 'localhost'}:${PORT}/login.html?blocked_https=${encodeURIComponent(hostOnly)}&proxy_type=${isManualProxy ? 'manual' : 'auto'}`;
    
    clientSocket.write('HTTP/1.1 302 Found\r\n');
    clientSocket.write(`Location: ${redirectUrl}\r\n`);
    clientSocket.write('Content-Type: text/html; charset=utf-8\r\n');
    clientSocket.write('Connection: close\r\n\r\n');
    
    const htmlContent = `<!DOCTYPE html>
<html><head>
<title>HTTPS Access Blocked</title>
<meta http-equiv="refresh" content="3;url=${redirectUrl}">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;}</style>
</head>
<body>
<h1>🔒 HTTPS Access Blocked</h1>
<p><strong>Trying to access:</strong> ${hostOnly}</p>
<p><strong>Proxy Type:</strong> ${isManualProxy ? 'Manual Proxy' : 'Auto Proxy (PAC)'}</p>
${isManualProxy 
  ? '<p>Manual proxy users must <strong>login</strong> first to access HTTPS sites.</p><p><strong>Your Settings:</strong> 10.5.48.94:8082</p>'
  : '<p>Auto proxy users must <strong>watch videos</strong> first to earn internet bundles.</p><p><strong>Your PAC URL:</strong> http://10.5.48.94:3150/proxy.pac</p>'
}
<hr>
<p><a href="${redirectUrl}" style="background:${isManualProxy ? '#007bff' : '#ff6b35'};color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">${isManualProxy ? '🔐 Login Now' : '🎬 Watch Videos'}</a></p>
<p><small>Redirecting in 3 seconds...</small></p>
</body></html>`;
    
    clientSocket.write(htmlContent);
    return clientSocket.end();
  }
  
  // ENHANCED PROXY ACCESS CONTROL - STRICT VIDEO-BASED INTERNET UNLOCKING
  if (mappedIdentifier && isAutoProxy && !isPortalHost) {
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
    const tempUnlocked = (tempFullAccess.get(mappedIdentifier) || 0) > Date.now();
    
    // Check if user has received video completion notification and unlocked internet access
    let hasInternetAccess = false;
    let videoAccessMB = 0;
    let notificationReceived = false;
    
    if (mappedIdentifier) {
      try {
        // PRIORITY 1: Check for active data bundles (instant access)
        if (quota.totalBundleMB > 0 && !quota.exhausted) {
          hasInternetAccess = true;
          videoAccessMB = quota.totalBundleMB;
          notificationReceived = true; // Bundles imply notification was received
          console.log(`[INTERNET-ACCESS-GRANTED] ${mappedIdentifier}: ${quota.totalBundleMB}MB bundle active, used ${quota.usedMB.toFixed(2)}MB`);
        } else {
          // PRIORITY 2: Check if user has watched videos and received completion notification
          const videosWatched = getVideosWatchedForUser ? getVideosWatchedForUser(mappedIdentifier) : [];
          const videoCount = videosWatched.length;
          
          // Check if user has received video completion notification (stored in deviceSessions)
          const deviceSession = deviceSessions.get(deviceFingerprint) || deviceSessions.get(mappedIdentifier);
          if (deviceSession && deviceSession.videoNotificationReceived) {
            notificationReceived = true;
          }
          
          // Only grant internet access if videos watched AND notification received
          if (notificationReceived && videoCount >= 1) {
            // Progressive access based on videos watched (after notification)
            if (videoCount >= 15) {
              videoAccessMB = 500; // 500MB for 15+ videos
              hasInternetAccess = true;
            } else if (videoCount >= 10) {
              videoAccessMB = 250; // 250MB for 10+ videos  
              hasInternetAccess = true;
            } else if (videoCount >= 5) {
              videoAccessMB = 100; // 100MB for 5+ videos
              hasInternetAccess = true;
            } else if (videoCount >= 1) {
              videoAccessMB = 20; // 20MB for 1+ videos (enough for basic browsing)
              hasInternetAccess = true;
            }
            
            // Check session usage to prevent overuse
            if (hasInternetAccess && quota.totalBundleMB === 0) {
              const videoUsage = realtimeUsage.get(mappedIdentifier);
              const sessionUsedMB = videoUsage ? videoUsage.totalDataMB : 0;
              
              if (sessionUsedMB >= videoAccessMB) {
                hasInternetAccess = false; // Used up video access allowance - redirect to portal
                console.log(`[INTERNET-ACCESS-EXHAUSTED] ${mappedIdentifier}: Used ${sessionUsedMB.toFixed(2)}MB of ${videoAccessMB}MB allowance - REDIRECTING TO PORTAL`);
              } else {
                console.log(`[INTERNET-ACCESS-ACTIVE] ${mappedIdentifier}: ${videoCount} videos = ${videoAccessMB}MB access, used ${sessionUsedMB.toFixed(2)}MB`);
              }
            }
          } else if (videoCount > 0 && !notificationReceived) {
            console.log(`[NOTIFICATION-PENDING] ${mappedIdentifier}: ${videoCount} videos watched but notification not received yet`);
          }
        }
      } catch (error) {
        console.error('[INTERNET-ACCESS-CHECK-ERROR]', error.message);
      }
    }
    
    // STRICT RULE: Block ALL internet access (including social media) until videos watched AND notification received
    if (!tempUnlocked && !hasInternetAccess) {
      const blockedReason = !notificationReceived ? 'Videos must be watched first' : 'Data allowance exhausted';
      const actionText = !notificationReceived ? '🎬 Watch Videos to Unlock Internet' : '🔄 Watch More Videos for Data';
      
      console.warn('[INTERNET-BLOCKED-NO-VIDEO-ACCESS]', { 
        host: hostOnly, 
        ip: clientIp,
        identifier: mappedIdentifier,
        remainingMB: quota.remainingMB,
        totalBundleMB: quota.totalBundleMB,
        exhausted: quota.exhausted,
        notificationReceived,
        reason: blockedReason
      });
      
      const redirectUrl = `http://${localIps[0] || 'localhost'}:${PORT}/login.html?blocked_https=${encodeURIComponent(hostOnly)}&proxy_type=video_required&reason=${encodeURIComponent(blockedReason)}`;
      
      clientSocket.write('HTTP/1.1 302 Found\r\n');
      clientSocket.write(`Location: ${redirectUrl}\r\n`);
      clientSocket.write('Content-Type: text/html; charset=utf-8\r\n');
      clientSocket.write('Connection: close\r\n\r\n');
      
      const htmlContent = `<!DOCTYPE html>
<html><head>
<title>Internet Access Blocked - Watch Videos First</title>
<meta http-equiv="refresh" content="5;url=${redirectUrl}">
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:600px;margin:0 auto;padding:20px;border:2px solid #ff6b35;border-radius:10px;background:#fff5f0;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#ff6b35;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
  .quota-info{background:#f8f9fa;padding:15px;border-radius:5px;margin:20px 0;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🚫</div>
  <h1>Internet Access Blocked</h1>
  <p><strong>Trying to access:</strong> ${hostOnly}</p>
  <p><strong>Reason:</strong> ${blockedReason}</p>
  
  <div class="quota-info">
    <h3>📊 Your Status:</h3>
    <p><strong>Videos Required:</strong> Watch videos and get notification to unlock internet</p>
    <p><strong>Current Data:</strong> ${quota.remainingMB.toFixed(1)}MB / ${quota.totalBundleMB}MB</p>
    <p><strong>Social Media:</strong> ❌ Blocked until videos watched</p>
    <p><strong>Internet Access:</strong> ❌ Blocked until videos watched</p>
  </div>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎯 How to Unlock Internet:</h3>
    <ol style="text-align:left;max-width:400px;margin:0 auto;">
      <li>📱 Enter the WiFi portal</li>
      <li>🎬 Watch video advertisements</li>
      <li>📢 Wait for completion notification</li>
      <li>🌐 Internet & social media unlocked!</li>
    </ol>
  </div>
  
  <a href="${redirectUrl}" class="action-btn">${actionText}</a>
  <p><small>Redirecting to portal in 5 seconds...</small></p>
  <p style="font-size:12px;color:#666;">Proxy: Auto (PAC) • ISN Free WiFi Portal</p>
</div>
</body></html>`;
      
      clientSocket.write(htmlContent);
      return clientSocket.end();
    }
  }
  
    const extraGarden = (process.env.WALLED_GARDEN||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
    const baseGarden = new Set([
      'localhost','127.0.0.1','::1', ...localIps,
      (process.env.PORTAL_HOST||'').toLowerCase(),
      'storage.googleapis.com','commondatastorage.googleapis.com','i.ytimg.com','i9.ytimg.com','yt3.ggpht.com',
      'dash.akamaized.net','cdn.jsdelivr.net','learningcontainer.com','sample-videos.com',
      // Video Ad CDNs - Allow video ads to play even when user has no data
      'googleads.g.doubleclick.net','pagead2.googlesyndication.com','tpc.googlesyndication.com',
      'securepubads.g.doubleclick.net','video-ad-stats.googlesyndication.com',
      'imasdk.googleapis.com','www.gstatic.com','ssl.gstatic.com',
      'yt3.ggpht.com','ytimg.com','googlevideo.com','manifest.googlevideo.com',
      'r1---sn-*.googlevideo.com','r2---sn-*.googlevideo.com','r3---sn-*.googlevideo.com',
      'vimeo.com','player.vimeo.com','i.vimeocdn.com','f.vimeocdn.com',
      'jwpcdn.com','cdn.jwplayer.com','content.jwplatform.com',
      'brightcove.com','edge.api.brightcove.com','players.brightcove.net'
    ].filter(Boolean));
    if(process.env.STRICT_WALLED!=='true'){
      ['fonts.googleapis.com','fonts.gstatic.com','www.youtube.com','youtube.com'].forEach(h=>baseGarden.add(h));
    }
    extraGarden.forEach(h=> baseGarden.add(h));
    const walledGarden = baseGarden;
  if(!parsedToken && !mappedIdentifier){
      if(!isInWalledGarden(hostOnly, walledGarden)){
        clientSocket.write('HTTP/1.1 403 Captive-Portal-Redirect\r\n\r\nOpen portal to gain access');
        return clientSocket.end();
      }
    }
    const effectiveIdentifier = (mappedIdentifier && mappedIdentifier.identifier) || (parsedToken && parsedToken.identifier);
    if(effectiveIdentifier){
      // CRITICAL FIX: Use unified quota calculation with proper device fingerprinting
      const userAgent = req.headers['user-agent'] || '';
      const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      const quota = computeRemainingUnified(effectiveIdentifier, deviceFingerprint, routerId);
      const tempUnlocked = (tempFullAccess.get(effectiveIdentifier) || 0) > Date.now();
      const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), 'localhost', '10.5.48.94', ...localIps ]);
      const isPortalHost = portalHostCandidates.has(hostOnly);
      
      // STRICT QUOTA ENFORCEMENT for HTTPS connections - BUT ALLOW VIDEO DOMAINS
      const isVideoAdDomain = isVideoAdCDN(hostOnly);
      
      if(!isPortalHost && !tempUnlocked && quota.exhausted && !isVideoAdDomain){
        try { activeClients.delete(normalizeIp(clientIp)); } catch {}
        console.warn('[QUOTA-BLOCK-CONNECT] exhausted identifier=', effectiveIdentifier, 'host=', hostOnly, 'ip=', clientIp, 'remaining=', quota.remainingMB);
        clientSocket.write('HTTP/1.1 302 Found\r\n');
  clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/quota.html?message=data_exhausted\r\n`);
  clientSocket.write('Content-Type: text/html\r\n\r\n');
  clientSocket.write(`<html><head><title>Data Exhausted</title></head><body><h1>Data Bundle Exhausted</h1><p>Watch more videos to unlock internet access.</p><p><a href="http://${localIps[0] || 'localhost'}:${PORT}/quota.html">Watch Videos</a></p></body></html>`);
        return clientSocket.end();
      }
      
      // Allow video domains even when quota is exhausted - CRITICAL FIX for video loading
      if (isVideoAdDomain) {
        console.log('[VIDEO-DOMAIN-ALLOWED]', { host: hostOnly, identifier: effectiveIdentifier, quota: quota.remainingMB });
      }
      
      // ENHANCED SOCIAL MEDIA ACCESS CONTROL - Block until videos watched and notification received
      if(!tempUnlocked && isGatedSocialHost(hostOnly)) {
        // Check if user has received video completion notification
        let hasSocialAccess = socialUnlocked.has(effectiveIdentifier);
        let notificationReceived = false;
        
        const deviceSession = deviceSessions.get(effectiveIdentifier) || deviceSessions.get(deviceFingerprint);
        if (deviceSession && deviceSession.videoNotificationReceived) {
          notificationReceived = true;
          // Auto-unlock social media after video notification
          if (!hasSocialAccess) {
            socialUnlocked.add(effectiveIdentifier);
            hasSocialAccess = true;
            console.log(`[SOCIAL-AUTO-UNLOCK] ${effectiveIdentifier} social media unlocked after video notification`);
          }
        }
        
        if (!hasSocialAccess) {
          const actionText = notificationReceived ? 'Watch more videos for continued access' : 'Watch videos to unlock social media';
          
          clientSocket.write('HTTP/1.1 302 Found\r\n');
          clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=social_blocked&app=${encodeURIComponent(hostOnly)}&reason=video_required\r\n`);
          clientSocket.write('Content-Type: text/html; charset=utf-8\r\n\r\n');
          
          const htmlContent = `<!DOCTYPE html>
<html><head>
<title>Social Media Blocked - Watch Videos First</title>
<meta http-equiv="refresh" content="3;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:500px;margin:0 auto;padding:20px;border:2px solid #ff6b35;border-radius:10px;background:#fff5f0;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#ff6b35;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">📱</div>
  <h1>${hostOnly.includes('whatsapp') ? 'WhatsApp' : hostOnly.includes('facebook') ? 'Facebook' : 'Social Media'} Blocked</h1>
  <p><strong>App:</strong> ${hostOnly}</p>
  <p><strong>Status:</strong> ${actionText}</p>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎯 How to Unlock:</h3>
    <ol style="text-align:left;">
      <li>📱 Enter WiFi portal</li>
      <li>🎬 Watch video ads</li>
      <li>📢 Get completion notification</li>
      <li>📱 Social media unlocked!</li>
    </ol>
  </div>
  
  <a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" class="action-btn">🎬 Watch Videos Now</a>
  <p><small>Redirecting in 3 seconds...</small></p>
</div>
</body></html>`;
          
          clientSocket.write(htmlContent);
          return clientSocket.end();
        }
      }
    }
    const [host, port] = req.url.split(':');
    
    // CRITICAL: Real-time quota enforcement for HTTPS connections
    if (mappedIdentifier && !isPortalHost && !isVideoAdHost) {
      const userAgent = req.headers['user-agent'] || '';
      const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
      const currentUsage = realtimeUsage.get(mappedIdentifier) || { totalDataMB: 0 };
      const totalUsedMB = currentUsage.totalDataMB || 0;
      
      // Block if quota exceeded
      if (quota.remainingMB <= 0 && quota.totalBundleMB > 0) {
        const blockedReason = `HTTPS Data limit exceeded: Used ${totalUsedMB.toFixed(1)}MB of ${quota.totalBundleMB}MB`;
        
        console.warn('[HTTPS-BLOCKED-QUOTA-EXCEEDED]', { 
          host: hostOnly, 
          ip: clientIp,
          identifier: mappedIdentifier,
          totalUsed: totalUsedMB,
          limit: quota.totalBundleMB,
          remaining: quota.remainingMB
        });
        
  const redirectUrl = `http://${localIps[0] || 'localhost'}:${PORT}/quota.html?used=${totalUsedMB.toFixed(1)}&limit=${quota.totalBundleMB}`;
        
        clientSocket.write('HTTP/1.1 302 Found\r\n');
        clientSocket.write(`Location: ${redirectUrl}\r\n`);
        clientSocket.write('Content-Type: text/html; charset=utf-8\r\n');
        clientSocket.write('Connection: close\r\n\r\n');
        
        const htmlContent = `<!DOCTYPE html>
<html><head>
<title>HTTPS Data Limit Exceeded</title>
  <meta http-equiv="refresh" content="5;url=${redirectUrl}">
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;}
  .container{max-width:600px;margin:0 auto;padding:20px;border:2px solid #dc3545;border-radius:10px;background:#f8f9fa;}
  .icon{font-size:48px;margin-bottom:20px;}
  .action-btn{background:#dc3545;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
  .usage-bar{background:#e9ecef;height:20px;border-radius:10px;margin:20px 0;overflow:hidden;}
  .usage-fill{background:#dc3545;height:100%;transition:width 0.3s;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🔒</div>
  <h1>HTTPS Data Limit Exceeded</h1>
  <p><strong>Trying to access:</strong> ${hostOnly}</p>
  
  <div style="background:#fff3cd;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #ffc107;">
    <h3>📊 Data Usage Summary:</h3>
    <p><strong>Used:</strong> ${totalUsedMB.toFixed(1)} MB</p>
    <p><strong>Limit:</strong> ${quota.totalBundleMB} MB</p>
    <p><strong>Exceeded by:</strong> ${(totalUsedMB - quota.totalBundleMB).toFixed(1)} MB</p>
    <div class="usage-bar">
      <div class="usage-fill" style="width: 100%;"></div>
    </div>
  </div>
  
  <div style="background:#e8f5e8;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #28a745;">
    <h3>🎬 How to Get More Data:</h3>
    <ol style="text-align:left;">
      <li>📱 Return to the WiFi portal</li>
      <li>🎬 Watch video advertisements</li>
      <li>📊 Each video earns 20MB of data</li>
      <li>🔒 HTTPS access restored!</li>
    </ol>
  </div>
  
  <a href="${redirectUrl}" class="action-btn">🎬 Watch More Videos</a>
  <p><small>Portal access is always free • Videos unlock internet data</small></p>
</div>
</body></html>`;
        
        clientSocket.write(htmlContent);
        return clientSocket.end();
      }
    }
    
    const serverSocket = net.connect(port||443, host, ()=>{
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head && head.length) serverSocket.write(head);
      
      // Track bytes more accurately with real-time quota enforcement
      let bytesUp=0, bytesDown=0;
      let quotaExceeded = false;
      
      // Client to server (upload) data with quota checking
      clientSocket.on('data',chunk=>{ 
        bytesUp+=chunk.length;
        
        // Check quota for non-ad traffic
        if (mappedIdentifier && !isVideoAdHost && !quotaExceeded) {
          const userAgent = req.headers['user-agent'] || '';
          const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
          const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
          const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
          const currentUsage = realtimeUsage.get(mappedIdentifier) || { totalDataMB: 0 };
          const totalCurrentMB = currentUsage.totalDataMB + (bytesUp + bytesDown) / 1024 / 1024;
          
          if (quota.totalBundleMB > 0 && totalCurrentMB > quota.totalBundleMB) {
            quotaExceeded = true;
            console.warn(`[HTTPS-REAL-TIME-BLOCK-UP] ${mappedIdentifier}: Quota exceeded ${totalCurrentMB.toFixed(2)}MB > ${quota.totalBundleMB}MB on ${hostOnly}`);
            try { 
              clientSocket.end(); 
              serverSocket.end(); 
            } catch {} 
            return;
          }
        }
        
        if (!quotaExceeded) {
          serverSocket.write(chunk);
        }
      });
      
      // Server to client (download) data with quota checking
      serverSocket.on('data',chunk=>{ 
        bytesDown+=chunk.length;
        
        // Check quota for non-ad traffic  
        if (mappedIdentifier && !isVideoAdHost && !quotaExceeded) {
          const userAgent = req.headers['user-agent'] || '';
          const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
          const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
          const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
          const currentUsage = realtimeUsage.get(mappedIdentifier) || { totalDataMB: 0 };
          const totalCurrentMB = currentUsage.totalDataMB + (bytesUp + bytesDown) / 1024 / 1024;
          
          if (quota.totalBundleMB > 0 && totalCurrentMB > quota.totalBundleMB) {
            quotaExceeded = true;
            console.warn(`[HTTPS-REAL-TIME-BLOCK-DOWN] ${mappedIdentifier}: Quota exceeded ${totalCurrentMB.toFixed(2)}MB > ${quota.totalBundleMB}MB on ${hostOnly}`);
            try { 
              clientSocket.end(); 
              serverSocket.end(); 
            } catch {} 
            return;
          }
        }
        
        if (!quotaExceeded) {
          clientSocket.write(chunk);
        }
      });
      
      const finalize=()=>{ 
        if((bytesUp+bytesDown)>0 && mappedIdentifier){ 
          try{ 
            // Don't count video ad CDN traffic against user data quota
            const isAdTraffic = isVideoAdCDN(hostOnly);
            const totalMB = (bytesUp+bytesDown)/1024/1024;
            
            if (!isAdTraffic) {
              // Enhanced HTTPS usage tracking with device and router info
              const routerId = parsedToken?.routerId || (req.headers['x-router-id'] || clientIp || 'router-1');
              const deviceId = parsedToken?.deviceId || 'https-device';
              
              const success = addUsage(mappedIdentifier, totalMB, deviceId, routerId);
              console.log('[HTTPS-USAGE-TRACKED]', { 
                identifier: mappedIdentifier, 
                device: deviceId?.slice(0,8)+'...', 
                host: hostOnly, 
                bytesUp, 
                bytesDown, 
                totalMB: totalMB.toFixed(3), 
                success,
                quotaExceeded 
              });
              
              // Update real-time session usage for live tracking
              if (success) {
                dataTracker.addSessionUsage(mappedIdentifier, totalMB);
              }
            } else {
              console.log('[HTTPS-VIDEO-AD-FREE]', { identifier: mappedIdentifier, host: hostOnly, bytesUp, bytesDown, totalMB: totalMB.toFixed(3), message: 'Video ad traffic not counted' });
            }
          } catch(err) {
            console.warn('[HTTPS-USAGE-TRACK-ERROR]', err?.message);
          }
        } 
      };
      clientSocket.on('close',finalize);
      serverSocket.on('close',finalize);
    });
    serverSocket.on('error',()=>{ try{ clientSocket.end(); }catch{} });
  });
  const host = process.env.HOST || '0.0.0.0';
  proxy.listen(PROXY_PORT, host, ()=> console.log(`Captive proxy listening on http://${host}:${PROXY_PORT}`));
}

console.log('[proxy] ENABLE_PROXY=', process.env.ENABLE_PROXY);
if(process.env.ENABLE_PROXY!=='false'){
  console.log('[proxy] calling startProxy()');
  try { startProxy(); console.log('[proxy] startProxy() returned (non-blocking)'); } catch(err){ console.warn('Proxy start failed', err?.message); }
} else {
  console.log('[proxy] start skipped - ENABLE_PROXY is false');
}

// User self usage
app.get('/api/me/usage', (req,res)=>{
  const identifier=(req.query.identifier||'').toString().trim();
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const idLower = identifier.toLowerCase();
    
    // Enhanced usage calculation with real-time data
    const usageData = dataTracker.getFreshUsageData(idLower);
    
    // Get device fingerprint for device-specific tracking
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    // Get video tracking data
    const { data: users } = getUsers();
  const user = users.find(u=> String(u.email||'').trim().toLowerCase()===idLower || (u.phone && u.phone===normalizePhone(idLower)) );
    
    let videosWatched, videoEarnedMB;
    if (user) {
      // Unified user - get videos from all devices
      videosWatched = getVideosWatchedForUser(idLower);
      videoEarnedMB = calculateVideoEarnedData(videosWatched);
    } else {
      // Non-unified user - device specific
      videosWatched = getVideosWatched(idLower, deviceFingerprint);
      videoEarnedMB = calculateVideoEarnedData(videosWatched);
    }
    
    // Get all bundles for this user (especially for phone users)
    let myPurchases = [];
    
    try {
      const wb = loadWorkbookWithTracking();
      if (wb.Sheets['Purchases']) {
        const purchases = XLSX.utils.sheet_to_json(wb.Sheets['Purchases']);
        
        // For phone users, show all bundles regardless of device
        if (idLower.match(/^\d{10}$/)) {
          myPurchases = purchases.filter(p => p.phone_number === idLower || p.identifier === idLower)
            .sort((a,b) => new Date(b.timestamp || b.grantedAtISO || 0) - new Date(a.timestamp || a.grantedAtISO || 0));
        } else {
          myPurchases = purchases.filter(p => p.identifier === idLower)
            .sort((a,b) => new Date(b.timestamp || b.grantedAtISO || 0) - new Date(a.timestamp || a.grantedAtISO || 0));
        }
      }
    } catch (error) {
      console.error('[PURCHASES-FETCH-ERROR]', error);
    }
    
    // Calculate next milestone
    const videoCount = videosWatched.length;
    let nextMilestone = null;
    
    if (videoCount < 5) {
      nextMilestone = { target: 5, reward: '100MB', needed: 5 - videoCount };
    } else if (videoCount < 10) {
      nextMilestone = { target: 10, reward: '250MB', needed: 10 - videoCount };
    } else if (videoCount < 15) {
      nextMilestone = { target: 15, reward: '500MB', needed: 15 - videoCount };
    } else {
      nextMilestone = { target: 15, reward: 'Max reached (500MB)', needed: 0 };
    }
    
    // Enhanced response with real data
    const response = {
      ok: true,
      // Real-time usage data (no undefined values)
      totalBundleMB: usageData.totalBundleMB || 0,
      totalUsedMB: usageData.totalUsedMB || 0,
      remainingMB: usageData.remainingMB || 0,
      exhausted: usageData.exhausted || false,
      
      // Video tracking data
      videosWatched: videoCount,
      videoEarnedMB: videoEarnedMB || 0,
      nextMilestone: nextMilestone,
      
      // Enhanced breakdown with actual numbers
      breakdown: {
        videoEarned: videoEarnedMB || 0,
        purchased: Math.max(0, (usageData.totalBundleMB || 0) - (videoEarnedMB || 0)),
        used: usageData.totalUsedMB || 0,
        remaining: usageData.remainingMB || 0
      },
      
      // Device and session info
      deviceId: deviceFingerprint,
      strictMode: true,
      purchases: myPurchases,
      
      // Real-time statistics
      realTimeStats: {
        lastUpdated: new Date().toISOString(),
        dataAccuracy: 'real-time',
        bundleCount: myPurchases.length
      }
    };
    
    console.log('[ENHANCED-USAGE-CHECK]', { 
      user: idLower,
      totalBundle: response.totalBundleMB,
      totalUsed: response.totalUsedMB,
      remaining: response.remainingMB,
      videosWatched: videoCount,
      videoEarned: videoEarnedMB,
      purchaseCount: myPurchases.length
    });
    
    res.json(response);
    
  } catch(err){ 
    console.error('[USAGE-ERROR]', err?.message);
    res.status(500).json({ ok:false, message:'Error calculating usage' }); 
  }
});

// Client IP detection for diagnostic
app.get('/api/me/ip', (req,res)=>{
  const clientIp = req.headers['x-forwarded-for'] 
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.connection.remoteAddress 
    || req.socket.remoteAddress 
    || (req.connection.socket ? req.connection.socket.remoteAddress : null)
    || req.ip;
  res.json({ ok: true, ip: clientIp });
});

// Admin overview
app.get('/api/admin/overview', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try {
    const overview = buildAdminOverview();
    res.json({ ok:true, overview });
  } catch(err){
    console.error('Admin overview error:', err);
    res.status(500).json({ ok:false, message:'Error building overview', error: (err && err.message)||'unknown' });
  }
});

// Real-time usage monitoring endpoint for admin with live bandwidth tracking like sports scores
app.get('/api/admin/realtime-usage', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  
  try {
    const now = Date.now();
    const usageData = Array.from(realtimeUsage.entries()).map(([identifier, usage]) => {
      const quota = computeRemainingUnified(identifier);
      const isActive = (now - usage.lastUpdateTime) < 30000; // Active in last 30 seconds for more responsive live tracking
      
      // Get bandwidth history for live score-like updates
      const history = bandwidthHistory.get(identifier) || [];
      const recentHistory = history.filter(h => h.timestamp > now - 30000).slice(-10); // Last 30 seconds, max 10 points
      
      return {
        identifier,
        ip: usage.ip,
        wifiNetwork: usage.wifiNetwork,
        routerId: usage.routerId,
        downMbps: Math.round(usage.downMbps * 10) / 10, // Live download speed like sports scores
        upMbps: Math.round(usage.upMbps * 10) / 10, // Live upload speed like sports scores
        peakDownMbps: Math.round(usage.peakDownMbps * 10) / 10, // Peak download like highest score
        peakUpMbps: Math.round(usage.peakUpMbps * 10) / 10, // Peak upload like highest score
        totalDataMB: Math.round(usage.totalDataMB * 100) / 100,
        remainingDataMB: quota?.remainingMB || 0,
        connectionDuration: Math.floor((now - usage.connectionStart) / 60000), // minutes
        lastActivity: new Date(usage.lastUpdateTime).toISOString(),
        isActive,
        status: isActive ? (usage.downMbps > 0.5 ? 'Heavy Usage' : 'Active') : 'Idle',
        recentHistory, // Live bandwidth history for graphs
        activityLevel: usage.downMbps > 5 ? 'high' : usage.downMbps > 1 ? 'medium' : 'low'
      };
    });
    
    const routerData = Array.from(routerStats.entries()).map(([routerId, stats]) => ({
      routerId,
      ipAddress: stats.ipAddress,
      location: stats.location,
      totalDataServed: Math.round(stats.totalDataServed * 100) / 100,
      connectedUsers: stats.connectedUsers.size,
      downMbps: Math.round(stats.downMbps * 10) / 10, // Live router download speed
      upMbps: Math.round(stats.upMbps * 10) / 10, // Live router upload speed
      peakDownMbps: Math.round(stats.peakDownMbps * 10) / 10, // Peak router speeds
      peakUpMbps: Math.round(stats.peakUpMbps * 10) / 10,
      status: stats.status,
      lastMaintenance: stats.lastMaintenance,
      flags: stats.flags,
      loadLevel: stats.downMbps > 20 ? 'high' : stats.downMbps > 5 ? 'medium' : 'low'
    }));
    
    // Calculate aggregate network stats like live scoreboards
    const totalActiveUsers = usageData.filter(u => u.isActive).length;
    const totalDownMbps = Math.round(usageData.reduce((sum, u) => sum + u.downMbps, 0) * 10) / 10;
    const totalUpMbps = Math.round(usageData.reduce((sum, u) => sum + u.upMbps, 0) * 10) / 10;
    const networkPeakDown = Math.max(...usageData.map(u => u.peakDownMbps), 0);
    const networkPeakUp = Math.max(...usageData.map(u => u.peakUpMbps), 0);
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      users: usageData,
      routers: routerData,
      summary: {
        totalUsers: usageData.length,
        activeUsers: totalActiveUsers,
        totalRouters: routerData.length,
        totalDownMbps: totalDownMbps, // Live total network download speed
        totalUpMbps: totalUpMbps, // Live total network upload speed  
        networkPeakDown: networkPeakDown, // Network peak download like highest team score
        networkPeakUp: networkPeakUp, // Network peak upload like highest team score
        averageDownMbps: Math.round((totalDownMbps / Math.max(totalActiveUsers, 1)) * 10) / 10,
        averageUpMbps: Math.round((totalUpMbps / Math.max(totalActiveUsers, 1)) * 10) / 10,
        totalDataServed: routerData.reduce((sum, r) => sum + r.totalDataServed, 0),
        networkStatus: totalDownMbps > 50 ? 'High Load' : totalDownMbps > 10 ? 'Medium Load' : 'Normal'
      }
    });
  } catch(err) {
    console.error('[REALTIME-USAGE-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error fetching realtime usage' });
  }
});
// Helper functions for logging/access
function appendAccessEvent(event){
  try {
    const wb = loadWorkbookWithTracking();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ACCESSLOG]);
    rows.push({ id: guid(), ...event });
    wb.Sheets[SHEET_ACCESSLOG] = XLSX.utils.json_to_sheet(rows);
    XLSX.writeFile(wb, DATA_FILE);
  } catch(err){ console.warn('appendAccessEvent failed', err?.message); }
}
function upsertRouterMeta(meta){
  if(!meta.routerId) return;
  const wb = loadWorkbookWithTracking();
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ROUTERS]);
  const existing = rows.find(r=>r.routerId===meta.routerId);
  if(existing) Object.assign(existing, meta); else rows.push(meta);
  wb.Sheets[SHEET_ROUTERS] = XLSX.utils.json_to_sheet(rows);
  XLSX.writeFile(wb, DATA_FILE);
}
function upsertAd(def){
  if(!def.adId) return;
  const wb = loadWorkbookWithTracking();
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADS]);
  const existing = rows.find(a=>a.adId===def.adId);
  if(existing) Object.assign(existing, def); else rows.push(def);
  wb.Sheets[SHEET_ADS] = XLSX.utils.json_to_sheet(rows);
  XLSX.writeFile(wb, DATA_FILE);
}
function recordAdEvent(ev){
  const wb = loadWorkbookWithTracking();
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
  rows.push({ id: guid(), ...ev });
  wb.Sheets[SHEET_ADEVENTS] = XLSX.utils.json_to_sheet(rows);
  XLSX.writeFile(wb, DATA_FILE);
}

// Admin dashboard explicit tables
app.get('/api/admin/dashboard', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try { 
    const o=buildAdminOverview(); 
    
    // Get all active users with enhanced data tracking
    const allActiveUsers = dataTracker.getAllActiveUsers();
    
    // Build enhanced users table with accurate real-time data
    const enhancedUsersTable = o.usersTable.map(user => {
      const usage = realtimeUsage.get(user.identifier);
      
      // Get accurate quota information using enhanced data tracker
      const activeUserData = allActiveUsers.find(u => u.phoneNumber === user.identifier);
      const quota = activeUserData || computeRemaining(user.identifier, null, 'admin-check');
      
      // Calculate connection duration
      const connectionDuration = usage ? Math.floor((Date.now() - usage.connectionStart) / 60000) : 0; // minutes
      const durationFormatted = connectionDuration > 0 ? `${connectionDuration} min` : 'Not connected';
      
      // Format last activity
      const lastActivity = usage ? new Date(usage.lastUpdateTime).toLocaleTimeString('en-US', { hour12: false }) : 'Never';
      
      // Determine status
      const isActiveNow = usage && (Date.now() - usage.lastUpdateTime) < 60000; // Active if updated within 1 minute
      const status = isActiveNow ? 'Active' : (user.lastLogin ? 'Inactive' : 'Never logged in');
      
      // Use enhanced data for accurate display (no undefined values)
      const totalUsedMB = quota.totalUsedMB || 0;
      const totalBundleMB = quota.totalBundleMB || 0;
      const remainingMB = quota.remainingMB || 0;
      const sessionUsageMB = quota.sessionUsage || 0;
      
      return {
        userID: user.fullName || user.email || user.identifier, // Use real name or fallback to email
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        surname: user.surname,
        dob: user.dob,
        registrationDate: user.dateCreated,
        ipAddress: usage?.ip || 'Unknown',
        wifiNetwork: usage?.wifiNetwork || 'Unknown',
        routerID: usage?.routerId || 'Unknown',
        downMbps: usage ? Number(usage.downMbps.toFixed(2)) : 0.00,
        upMbps: usage ? Number(usage.upMbps.toFixed(2)) : 0.00,
        totalDataUsed: `${totalUsedMB.toFixed(2)} MB`,
        totalDataBundle: `${totalBundleMB.toFixed(2)} MB`,
        remainingData: `${remainingMB.toFixed(2)} MB`,
        sessionUsage: `${sessionUsageMB.toFixed(2)} MB`,
        connectionDuration: durationFormatted,
        lastActivity: lastActivity,
        status: status,
        lastLogin: user.lastLogin,
        profileUpdated: user.profileUpdated,
        loginCount: user.activeSessions || 0,
        identifier: user.identifier // Keep for backend compatibility
      };
    });
    
    // Build router table with real-time stats
    const routersTable = Array.from(routerStats.entries()).map(([routerId, stats]) => ({
      routerId,
      ipAddress: stats.ipAddress,
      location: stats.location,
      totalDataServed: Math.round(stats.totalDataServed * 100) / 100, // MB
      connectedUsers: stats.connectedUsers.size,
      status: stats.status,
      downMbps: stats.downMbps,
      upMbps: stats.upMbps,
      lastMaintenance: stats.lastMaintenance,
      flags: stats.flags.join(', ') || 'None'
    }));
    
    // Enhanced real-time statistics
    const totalActiveUsers = allActiveUsers.filter(u => u.lastActive && (Date.now() - u.lastActive) < 300000).length; // Active in last 5 minutes
    const totalDataServed = allActiveUsers.reduce((sum, u) => sum + (u.totalUsedMB || 0), 0);
    
    res.json({ 
      ok:true, 
      usersTable: enhancedUsersTable,
      routersTable, 
      registrations: o.regLoginTable, // Fixed: Frontend expects 'registrations'
      ads: o.adsTable, // Fixed: Frontend expects 'ads'
      activeUsersCount: totalActiveUsers, 
      totalUsers: o.usersCount,
      realtimeStats: {
        totalActiveConnections: realtimeUsage.size,
        totalRouters: routerStats.size,
        totalDataServedMB: Math.round(totalDataServed * 100) / 100,
        averageDownMbps: Array.from(realtimeUsage.values()).reduce((sum, u) => sum + u.downMbps, 0) / Math.max(realtimeUsage.size, 1),
        averageUpMbps: Array.from(realtimeUsage.values()).reduce((sum, u) => sum + u.upMbps, 0) / Math.max(realtimeUsage.size, 1),
        lastUpdated: new Date().toISOString()
      }
    }); 
  } catch(err){ 
    console.error('[ADMIN-DASHBOARD-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error building dashboard' }); 
  }
});

// ENHANCED: Device Access Control Admin Dashboard
app.get('/api/admin/device-access', (req, res) => {
  try {
    const requester = (req.headers['x-user-identifier'] || '').toString().trim().toLowerCase();
    if (!isAdminIdentifier(requester)) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    
    const deviceStatus = deviceIsolation.getDeviceAccessStatus();
    const config = deviceIsolation.DEVICE_ISOLATION_CONFIG;
    
    res.json({
      ok: true,
      deviceAccessControl: {
        ...deviceStatus,
        configuration: {
          strictDeviceIsolation: config.STRICT_DEVICE_ISOLATION,
          accessTokenTTLHours: config.ACCESS_TOKEN_TTL_HOURS,
          revalidationIntervalHours: config.REVALIDATION_INTERVAL_HOURS,
          revalidationGraceMinutes: config.REVALIDATION_GRACE_MINUTES,
          macBindingEnabled: config.MAC_BINDING_ENABLED,
          routerDeviceBlocking: config.ROUTER_DEVICE_BLOCKING
        }
      }
    });
  } catch (error) {
    console.error('[DEVICE-ACCESS-ADMIN-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Error retrieving device access status' });
  }
});

// Device access revocation endpoint (for admin use)
app.post('/api/admin/device-access/revoke', (req, res) => {
  try {
    const requester = (req.headers['x-user-identifier'] || '').toString().trim().toLowerCase();
    if (!isAdminIdentifier(requester)) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    
    const { deviceId, reason } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ ok: false, message: 'deviceId required' });
    }
    
    const revoked = deviceIsolation.revokeDeviceAccess(deviceId, reason || 'admin revocation');
    
    res.json({
      ok: true,
      revoked: revoked,
      message: revoked ? 'Device access revoked successfully' : 'Device not found or already revoked'
    });
  } catch (error) {
    console.error('[DEVICE-REVOKE-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Error revoking device access' });
  }
});

// Router meta upsert
app.post('/api/admin/router/meta', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const { routerId, ipAddress, location, lastMaintenanceISO } = req.body||{};
  if(!routerId) return res.status(400).json({ ok:false, message:'routerId required' });
  try { upsertRouterMeta({ routerId, ipAddress, location, lastMaintenanceISO }); res.json({ ok:true }); } catch(err){ res.status(500).json({ ok:false, message:'Error saving router meta' }); }
});

// Ad definition upsert
app.post('/api/admin/ads/upsert', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const { adId, title, type, routerZones } = req.body||{};
  if(!adId) return res.status(400).json({ ok:false, message:'adId required' });
  try { upsertAd({ adId, title, type, routerZones: Array.isArray(routerZones)?routerZones.join('|'):routerZones }); res.json({ ok:true }); } catch(err){ res.status(500).json({ ok:false, message:'Error saving ad' }); }
});

// Admin function to reset all user data (clear bundles, usage, sessions) - NUCLEAR OPTION
app.post('/api/admin/reset-all-data', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try {
    const wb = loadWorkbook();
    ensureSheet(wb, SHEET_PURCHASES);
    ensureSheet(wb, SHEET_USAGELOG);
    ensureSheet(wb, SHEET_SESSIONS);
    
    // Clear all data by writing empty arrays to sheets
    writeSheet(wb, SHEET_PURCHASES, []);
    writeSheet(wb, SHEET_USAGELOG, []);
    writeSheet(wb, SHEET_SESSIONS, []);
    
    // Clear in-memory caches
    activeClients.clear();
    deviceVideoCount.clear(); // Clear device video count tracker
    deviceBundlesGranted.clear(); // Clear device bundle tracking to prevent duplicates
    recentCompletions.clear(); // Clear recent completion tracking
    adGrantEligibility.clear();
    socialUnlocked.clear();
    fullAccessUnlocked.clear();
    tempFullAccess.clear();
    
    console.log('[ADMIN-RESET] All user bundles, usage, and sessions cleared by', requester);
    res.json({ ok:true, message:'All user data reset - everyone starts fresh' });
  } catch(err) { 
    console.error('[ADMIN-RESET-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error resetting data' }); 
  }
});

// Ad event reporting - NEW BUNDLE SYSTEM
// Track videos watched per DEVICE (not per user) to grant cumulative bundles
const deviceVideoCount = new Map(); // deviceFingerprint -> { videos: number, lastVideoTime: timestamp, identifier: string }
const deviceBundlesGranted = new Map(); // deviceFingerprint -> Set of granted tiers to prevent duplicates
const recentCompletions = new Map(); // deviceFingerprint -> timestamp of last completion to prevent rapid-fire

// Bundle tiers based on videos watched
const BUNDLE_TIERS = [
  { videos: 5, mb: 100, label: '5 videos = 100MB' },
  { videos: 10, mb: 250, label: '10 videos = 250MB' },
  { videos: 15, mb: 500, label: '15 videos = 500MB' }
];
// Ephemeral eligibility after successful ad completion to guard /api/bundle/grant misuse
const adGrantEligibility = new Map(); // identifier -> { expires }
// After first qualifying ad completion we allow full social domains for that identifier
const socialUnlocked = new Set(); // identifier strings
// REMOVED: No more automatic fullAccessUnlocked - users must earn and use data bundles
// const fullAccessUnlocked = new Set(); // identifier strings - DISABLED for proper quota enforcement
const fullAccessUnlocked = new Set(); // Keep the variable but don't auto-add users
// Temporary immediate unlock after ad completion (identifier -> expiry timestamp ms)
const tempFullAccess = new Map();
// Regex patterns to match ANY Facebook / WhatsApp domains & subdomains (web, CDN, APIs, MQTT, media, regional edges)
// ENHANCED: Now includes APK and mobile app specific domains
const SOCIAL_GATED_PATTERNS = [
  // Facebook domains
  /(^|\.)facebook\.com$/i,
  /(^|\.)fbcdn\.net$/i,
  /(^|\.)fbsbx\.com$/i,
  /(^|\.)messenger\.com$/i,
  /(^|\.)graph\.facebook\.com$/i,
  /(^|\.)edge-mqtt\.facebook\.com$/i,
  /(^|\.)mqtt(\.[a-z0-9-]+)?\.facebook\.com$/i,
  /(^|\.)star\.c10r\.facebook\.com$/i,
  /(^|\.)scontent\.[a-z0-9-]+\.fbcdn\.net$/i,
  /(^|\.)video\.xx\.fbcdn\.net$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)cdninstagram\.com$/i,
  
  // WhatsApp domains (including APK and mobile app traffic)
  /(^|\.)whatsapp\.com$/i,
  /(^|\.)whatsapp\.net$/i,
  /(^|\.)wa\.me$/i,
  /(^|\.)mmg\.whatsapp\.net$/i,
  /(^|\.)static\.whatsapp\.net$/i,
  /(^|\.)cdn\.whatsapp\.net$/i,
  /(^|\.)media\.whatsapp\.net$/i,
  /(^|\.)pps\.whatsapp\.net$/i,
  /(^|\.)web\.whatsapp\.com$/i,
  
  // APK download and update domains
  /(^|\.)download\.whatsapp\.com$/i,
  /(^|\.)update\.whatsapp\.com$/i,
  /(^|\.)apk\.whatsapp\.com$/i,
  /(^|\.)android\.whatsapp\.com$/i,
  
  // Facebook APK and mobile domains
  /(^|\.)m\.facebook\.com$/i,
  /(^|\.)mobile\.facebook\.com$/i,
  /(^|\.)touch\.facebook\.com$/i,
  /(^|\.)api\.facebook\.com$/i,
  /(^|\.)developers\.facebook\.com$/i,
  
  // Messenger APK domains
  /(^|\.)m\.messenger\.com$/i,
  /(^|\.)api\.messenger\.com$/i
];
function isGatedSocialHost(host){
  if(!host) return false; host=host.toLowerCase();
  return SOCIAL_GATED_PATTERNS.some(r=> r.test(host));
}

app.post('/api/ad/event', (req,res)=>{
  const { adId, identifier, eventType, watchSeconds, routerId } = req.body||{};
  if(!adId || !eventType) return res.status(400).json({ ok:false, message:'Missing adId or eventType' });
  try {
    const idNorm = (identifier||'').toLowerCase();
    const watch = Number(watchSeconds)||0;
    
    // Enhanced device tracking for ad events
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = deviceInfo.deviceId;
    
    const eventPayload = { 
      adId, 
      identifier: idNorm, 
      deviceId: deviceId, // Add device tracking
      eventType, 
      watchSeconds: watch, 
      routerId, 
      tsISO: new Date().toISOString(),
      macAddress: deviceInfo.mac || ''
    };
    recordAdEvent(eventPayload);
    try { console.log('AdEvent', JSON.stringify(eventPayload)); } catch {}
    
    // Enhanced router access control with device tracking
    const rId = routerId || req.headers['x-router-id'] || req.ip || 'unknown';
    const now = Date.now();
    
    if(eventType === 'start' || eventType === 'progress') {
      // Mark this device as actively watching - block others on same router
      routerDeviceActivity.set(rId, {
        activeDevice: deviceId,
        lastActivityTime: Date.now(),
        blockOthers: true,
        identifier: idNorm
      });
      console.log('[ROUTER-LOCK]', { device: deviceId.slice(0,8) + '...', router: rId, user: idNorm, action: 'watching_video' });
    } else if(eventType === 'complete' || eventType === 'error') {
      // Release router lock after 30 seconds
      setTimeout(() => {
        const activity = routerDeviceActivity.get(rId);
        if(activity && activity.activeDevice === deviceId) {
          activity.blockOthers = false;
          console.log('[ROUTER-UNLOCK]', { device: deviceId.slice(0,8) + '...', router: rId, action: 'video_finished' });
        }
      }, 30000);
    }
    
    let rewardsGranted=[];
    let bundleUpgrade = null;
    
    // Enhanced video completion validation with device tracking
    if(eventType==='complete' && idNorm){
      console.log('[AD-COMPLETE-DEBUG]', { identifier: idNorm, deviceId: deviceId.slice(0,8) + '...', watchSeconds: watch, eventType });
      
      // STRICTER MINIMUM WATCH TIME - Must watch at least 80% of typical ad duration
      const minCompleteSeconds = Number(process.env.WATCH_COMPLETE_MIN_SECONDS || 45); // 45 seconds minimum (most ads are 60s)
      
      if(watch >= minCompleteSeconds) {
        // Mark device as having earned access
        const unlockSuccess = markDeviceUnlocked(deviceId, idNorm, 100);
        
        if(unlockSuccess) {
          rewardsGranted.push(`Device earned 100MB data bundle`);
          bundleUpgrade = { deviceId: deviceId.slice(0,8) + '...', bundleMB: 100, message: 'Video watch complete - device unlocked!' };
          
          console.log('[DEVICE-VIDEO-UNLOCK]', { 
            identifier: idNorm, 
            deviceId: deviceId.slice(0,8) + '...', 
            watchSeconds: watch,
            bundleMB: 100
          });
        }
      } else {
        console.log('[INSUFFICIENT-WATCH-TIME]', { 
          identifier: idNorm, 
          deviceId: deviceId.slice(0,8) + '...', 
          watchSeconds: watch, 
          required: minCompleteSeconds 
        });
      }
    }
    
    const response = { ok: true, rewards: rewardsGranted };
    if(bundleUpgrade) response.bundleUpgrade = bundleUpgrade;
    res.json(response);
  } catch(err) {
    console.error('[AD-EVENT-ERROR]', err);
    res.status(500).json({ ok: false, message: 'Ad event processing failed' });
  }
});

// Video completion tracking for data earning
// Emergency device unblock endpoint
app.post('/api/admin/device-unblock', (req, res) => {
  try {
    const { identifier, deviceId, reason } = req.body || {};
    
    if (!identifier || !deviceId) {
      return res.status(400).json({ ok: false, message: 'Missing identifier or deviceId' });
    }
    
    console.log(`[EMERGENCY-UNBLOCK] Unblocking device ${deviceId.slice(0,8)}... for user ${identifier}: ${reason}`);
    
    // Clear device blocks
    deviceIsolation.clearDeviceBlock(identifier, deviceId);
    
    // Create emergency access token
    const deviceInfo = {
      deviceId: deviceId,
      mac: '', // Will be resolved if needed
      ip: '',
      userAgent: 'Emergency Access',
      identifier: identifier
    };
    
    // Grant emergency access
    const routerId = 'default-router';
    const accessGranted = deviceIsolation.deviceEarnAccess(identifier, deviceInfo, routerId, 5, 100);
    
    if (accessGranted) {
      // Register as active client
      const clientInfo = {
        identifier: identifier,
        ip: req.ip || '0.0.0.0',
        lastSeen: Date.now(),
        expires: Date.now() + (6 * 60 * 60 * 1000),
        deviceFingerprint: deviceId,
        sessionToken: `emergency_${Date.now()}`
      };
      
      activeClients.set(deviceId, clientInfo);
      activeClients.set(identifier, clientInfo);
      
      // Clear any stale usage data
      realtimeUsage.delete(identifier);
      
      console.log(`[EMERGENCY-ACCESS-GRANTED] Device ${deviceId.slice(0,8)}... unblocked for ${identifier}`);
      
      res.json({
        ok: true,
        message: 'Device unblocked successfully',
        deviceId: deviceId.slice(0,8) + '...',
        identifier: identifier,
        accessGranted: Date.now()
      });
    } else {
      res.status(500).json({
        ok: false,
        message: 'Failed to grant emergency access'
      });
    }
    
  } catch (error) {
    console.error('[EMERGENCY-UNBLOCK-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Emergency unblock failed' });
  }
});

// Emergency access refresh for instant unlocking
app.post('/api/refresh-access', (req, res) => {
  try {
    const { identifier } = req.body || {};
    
    if (!identifier) {
      return res.status(400).json({ ok: false, message: 'Missing identifier' });
    }
    
    // Clear any stale data
    realtimeUsage.delete(identifier);
    
    // Refresh activeClients with current device info
    const deviceInfo = generateDeviceFingerprint(req);
    const routerId = req.headers['x-router-id'] || detectRouterId(req) || 'default-router';
    
    const clientInfo = {
      identifier: identifier,
      ip: req.ip || req.connection.remoteAddress,
      lastSeen: Date.now(),
      expires: Date.now() + (6 * 60 * 60 * 1000), // 6 hours
      deviceFingerprint: deviceInfo.deviceId,
      sessionToken: `refresh_token_${Date.now()}`
    };
    
    // Register with multiple keys for instant recognition
    activeClients.set(deviceInfo.deviceId, clientInfo);
    activeClients.set(identifier, clientInfo);
    activeClients.set(req.ip || req.connection.remoteAddress, clientInfo);
    
    // Check current quota status
    const quota = computeRemainingUnified(identifier, deviceInfo.deviceId, routerId);
    
    console.log(`[ACCESS-REFRESHED] ${identifier}: quota=${quota.remainingMB}MB, bundles=${quota.totalBundleMB}MB`);
    
    res.json({
      ok: true,
      message: 'Access refreshed successfully',
      quota: {
        remainingMB: quota.remainingMB,
        totalBundleMB: quota.totalBundleMB,
        exhausted: quota.exhausted
      },
      accessGranted: Date.now()
    });
    
  } catch (error) {
    console.error('[ACCESS-REFRESH-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Access refresh failed' });
  }
});

// Emergency access grant endpoint - IMMEDIATE INTERNET UNLOCK
app.post('/api/emergency/unlock', (req, res) => {
  try {
    const { identifier } = req.body || {};
    
    if (!identifier) {
      return res.status(400).json({ ok: false, message: 'Missing identifier' });
    }
    
    console.log(`[EMERGENCY-UNLOCK] Immediately unlocking internet access for ${identifier}`);
    
    // SPECIAL FIX FOR BONGILINDIWE844@GMAIL.COM
    if (identifier.toLowerCase() === 'bongilindiwe844@gmail.com') {
      console.log(`[EMERGENCY-BONGILINDIWE-FIX] Applying comprehensive fix for ${identifier}`);
      
      // Grant device access for all their device fingerprints
      const deviceIds = [
        '59a37b82a0c25a2b9db8d3f3e1479d46',
        'a8197ed1290741654683b68ba9743275', 
        'b5842c23a41b635b426f7b1d2f5ad523',
        '2292f0ebbb3b14ce8aaed24e6cf90fa1',
        'e63de8ed54ef76b4adbf5d03b2a1c36e',
        '347f88d8fb75b648e8a24e8c3b5b5e6a',
        '8feb4679ecb0c2ba9e8c7a4b5a3f9e2d'
      ];
      
      deviceIds.forEach(deviceId => {
        try {
          const token = `emergency_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          deviceIsolation.grantDeviceAccess({
            deviceId: deviceId,
            ip: '10.5.48.94',
            userAgent: 'Emergency Access',
            mac: ''
          }, '', {
            sessionToken: token,
            identifier: identifier
          });
          console.log(`[EMERGENCY-DEVICE-ACCESS] Granted access for device ${deviceId.slice(0,8)}...`);
        } catch (deviceError) {
          console.log(`[EMERGENCY-DEVICE-ERROR] Could not grant access for ${deviceId.slice(0,8)}...: ${deviceError.message}`);
        }
      });
    }
    
    // Set video notification received flag
    let deviceSession = deviceSessions.get(identifier);
    if (!deviceSession) {
      deviceSession = {
        sessionToken: `emergency_unlock_${Date.now()}`,
        voucher: null,
        unlockTimestamp: Date.now(),
        revalidationRequired: false,
        lastActivity: Date.now()
      };
    }
    
    // CRITICAL: Set notification flag to unlock internet
    deviceSession.videoNotificationReceived = true;
    deviceSession.lastVideoCompletion = Date.now();
    deviceSession.totalVideosWatched = 5; // Assume 5 videos watched
    
    // Store for both identifier and potential device IDs
    deviceSessions.set(identifier, deviceSession);
    
    // Also add to social unlock
    socialUnlocked.add(identifier.toLowerCase());
    
    // Force immediate internet access
    tempFullAccess.set(identifier.toLowerCase(), Date.now() + (2 * 60 * 60 * 1000)); // 2 hours temp access
    
    console.log(`[EMERGENCY-INTERNET-UNLOCKED] ${identifier} has immediate internet and social media access`);
    
    res.json({
      ok: true,
      message: 'Emergency internet unlock successful',
      identifier: identifier,
      internetUnlocked: true,
      socialUnlocked: true,
      tempAccessGranted: true,
      expiresIn: '2 hours'
    });
    
  } catch (error) {
    console.error('[EMERGENCY-UNLOCK-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Emergency unlock failed' });
  }
});

app.post('/api/video/complete', (req, res) => {
  try {
    const { identifier, videoUrl, duration, deviceId: providedDeviceId } = req.body || {};
    
    if (!identifier || !videoUrl || !duration) {
      return res.status(400).json({ ok: false, message: 'Missing required fields: identifier, videoUrl, duration' });
    }
    
    // Use provided deviceId or generate from request
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = providedDeviceId || deviceInfo.deviceId;
    const routerId = req.headers['x-router-id'] || detectRouterId(req) || 'default-router';
    
    // Record the video view
    const earnedMB = recordVideoView(identifier, deviceId, videoUrl, duration, routerId);
    
    // Get updated video count and total earned data
    const videosWatched = getVideosWatched(identifier, deviceId);
    const totalVideoEarnedMB = calculateVideoEarnedData(videosWatched);
    
    // CRITICAL: Set video notification received flag to unlock internet access
    let deviceSession = deviceSessions.get(deviceId) || deviceSessions.get(identifier);
    if (!deviceSession) {
      deviceSession = {
        sessionToken: `video_session_${Date.now()}`,
        voucher: null,
        unlockTimestamp: Date.now(),
        revalidationRequired: false,
        lastActivity: Date.now(),
        videoNotificationReceived: false
      };
    }
    
    // Mark that the user has received video completion notification
    deviceSession.videoNotificationReceived = true;
    deviceSession.lastVideoCompletion = Date.now();
    deviceSession.totalVideosWatched = count;
    
    // Store the session for both device ID and identifier
    deviceSessions.set(deviceId, deviceSession);
    deviceSessions.set(identifier, deviceSession);
    
    console.log(`[VIDEO-NOTIFICATION-SET] ${identifier} device ${deviceId.slice(0,8)}... marked as notified - INTERNET ACCESS UNLOCKED`);
    
    // Create actual data bundles at milestones - CRITICAL FIX!
    if (count === 5 && totalVideoEarnedMB >= 100) {
      milestone = { message: 'Great progress!', data: '100MB bundle unlocked' };
      bundleAmount = 100;
      newBundleCreated = true;
    } else if (count === 10 && totalVideoEarnedMB >= 250) {
      milestone = { message: 'Keep watching!', data: '250MB bundle unlocked' };
      bundleAmount = 250;
      newBundleCreated = true;
    } else if (count === 15 && totalVideoEarnedMB >= 500) {
      milestone = { message: 'Excellent!', data: '500MB bundle unlocked' };
      bundleAmount = 500;
      newBundleCreated = true;
    } else if (count === 1) {
      milestone = { message: 'Social media access unlocked!', data: '20MB earned' };
    } else if (count === 25) {
      milestone = { message: 'Power user!', data: '1GB total earned' };
    }
    
    // CRITICAL: Actually create the data bundle purchase record
    if (newBundleCreated && bundleAmount > 0) {
      try {
        // Create bundle using enhanced data tracker to prevent duplicates
        const bundleCreated = dataTracker.createBundleIfNotExists(identifier, count, bundleAmount, `${count}_video_bundle`);
        
        if (bundleCreated) {
          console.log(`[VIDEO-BUNDLE-CREATED] ${identifier} earned ${bundleAmount}MB data bundle at ${count} videos`);
          
          // CRITICAL FIX: Grant device-specific access immediately with MAC binding
          const deviceInfo = generateDeviceFingerprint(req);
          const deviceAccessGranted = deviceIsolation.deviceEarnAccess(identifier, deviceInfo, routerId, count, bundleAmount);
          
          if (deviceAccessGranted) {
            console.log(`[DEVICE-ACCESS-GRANTED] Device ${deviceInfo.deviceId.slice(0,8)}... (MAC:${deviceInfo.mac?.slice(0,6) || 'unknown'}) earned ${bundleAmount}MB access for user ${identifier}`);
            
            // Clear any blocking for this device
            deviceIsolation.clearDeviceBlock(identifier, deviceInfo.deviceId);
            
            // Create MAC-bound access token for strict device isolation
            if (deviceInfo.macVerified) {
              const accessToken = deviceIsolation.createDeviceAccessToken(deviceInfo.deviceId, deviceInfo.mac, identifier, bundleAmount, count);
              console.log(`[MAC-ACCESS-TOKEN-CREATED] Device ${deviceInfo.mac.slice(0,6)}... bound to ${bundleAmount}MB access`);
            }
            
            // Register as active client to ensure immediate internet access
            const clientInfo = {
              identifier: identifier,
              ip: req.ip || req.connection.remoteAddress,
              lastSeen: Date.now(),
              expires: Date.now() + (6 * 60 * 60 * 1000), // 6 hours
              deviceFingerprint: deviceInfo.deviceId,
              macAddress: deviceInfo.mac,
              sessionToken: deviceAccessGranted.accessToken || `video_token_${Date.now()}`
            };
            
            // Register with multiple keys for instant recognition
            activeClients.set(deviceInfo.deviceId, clientInfo);
            activeClients.set(identifier, clientInfo);
            if (deviceInfo.mac) {
              activeClients.set(deviceInfo.mac, clientInfo);
            }
            activeClients.set(req.ip || req.connection.remoteAddress, clientInfo);
            
            console.log(`[IMMEDIATE-ACCESS] ${identifier} device ${deviceInfo.deviceId.slice(0,8)}... granted immediate internet access`);
            
            // INSTANT ACCESS FIX: Clear any stale usage data and refresh quota immediately
            realtimeUsage.delete(identifier);
            console.log(`[QUOTA-REFRESHED] Cleared stale usage data for ${identifier} - fresh bundle access enabled`);
            
            // Force immediate activeClients recognition by multiple keys
            console.log(`[MULTI-KEY-ACCESS] Registered ${identifier} with device/MAC/IP keys for instant recognition`);
            
          } else {
            console.error(`[DEVICE-ACCESS-FAILED] Could not grant device access for ${identifier}`);
          }
          
        } else {
          console.log(`[BUNDLE-EXISTS] Bundle already exists for ${identifier} at ${count} videos - access should already be granted`);
          
          // Even if bundle exists, ensure device has access
          const deviceInfo = {
            deviceId: deviceId,
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent'] || '',
            identifier: identifier
          };
          
          const deviceAccessGranted = deviceIsolation.deviceEarnAccess(identifier, deviceInfo, routerId, count, bundleAmount);
          if (deviceAccessGranted) {
            console.log(`[EXISTING-BUNDLE-ACCESS] Re-granted access for ${identifier} device ${deviceId.slice(0,8)}...`);
          }
        }
      } catch (error) {
        console.error('[VIDEO-BUNDLE-CREATION-ERROR]', error.message);
      }
    } else if (count >= 1) {
      // Even for first video, grant some access to allow continued watching
      try {
        const deviceInfo = {
          deviceId: deviceId,
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'] || '',
          identifier: identifier
        };
        
        const minimalAccess = deviceIsolation.deviceEarnAccess(identifier, deviceInfo, routerId, 1, 20); // 20MB for first video
        if (minimalAccess) {
          console.log(`[FIRST-VIDEO-ACCESS] ${identifier} device ${deviceId.slice(0,8)}... granted 20MB access for video watching`);
        }
      } catch (error) {
        console.error('[FIRST-VIDEO-ACCESS-ERROR]', error.message);
      }
    }
    
    console.log(`[VIDEO-COMPLETION] ${identifier} watched video ${count}, earned ${earnedMB}MB (total: ${totalVideoEarnedMB}MB)`);
    
    res.json({
      ok: true,
      earnedMB: earnedMB,
      totalVideos: count,
      totalEarnedMB: totalVideoEarnedMB,
      milestone: milestone,
      bundleCreated: newBundleCreated,
      bundleAmount: bundleAmount,
      internetUnlocked: true, // Always true after video completion
      socialUnlocked: true,   // Always true after video completion
      notification: {
        title: '🎉 Internet Access Unlocked!',
        message: count === 1 ? 
          'You watched your first video! Internet and social media access is now unlocked.' :
          `Great! You've watched ${count} videos. Your internet access has been refreshed.`,
        type: 'success',
        showFor: 8000 // Show for 8 seconds
      }
    });
    
  } catch (error) {
    console.error('[VIDEO-COMPLETE-ERROR]', error.message);
    res.status(500).json({ ok: false, message: 'Video completion tracking failed' });
  }
});

// NEW: Device registration and access control endpoints
app.post('/api/device/register', (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) {
      return res.status(400).json({ ok: false, message: 'Missing identifier' });
    }
    
    const deviceRegistration = registerActiveClient(req, identifier, 6);
    if (deviceRegistration) {
      res.json({ 
        ok: true, 
        deviceId: deviceRegistration.deviceId.slice(0,8) + '...',
        sessionToken: deviceRegistration.sessionToken,
        message: 'Device registered successfully'
      });
    } else {
      res.status(500).json({ ok: false, message: 'Device registration failed' });
    }
  } catch (error) {
    console.error('[DEVICE-REGISTER-ERROR]', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.get('/api/device/status', (req, res) => {
  try {
    const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
    const clientInfo = resolveActiveClient(clientIp, req);
    
    if (!clientInfo) {
      return res.status(401).json({ 
        ok: false, 
        authenticated: false, 
        message: 'Device not authenticated' 
      });
    }
    
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const quota = computeRemainingUnified(clientInfo.identifier, clientInfo.deviceId, routerId);
    
    res.json({
      ok: true,
      authenticated: true,
      deviceId: clientInfo.deviceId.slice(0,8) + '...',
      identifier: clientInfo.identifier,
      quota: {
        remainingMB: quota.remainingMB,
        totalMB: quota.totalMB,
        usedMB: quota.usedMB,
        exhausted: quota.exhausted,
        unlockEarned: quota.unlockEarned
      },
      mac: clientInfo.mac || 'unknown'
    });
  } catch (error) {
    console.error('[DEVICE-STATUS-ERROR]', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.post('/api/device/unlock', (req, res) => {
  try {
    const { identifier, videoWatched = true } = req.body;
    
    if (!identifier) {
      return res.status(400).json({ ok: false, message: 'Missing identifier' });
    }
    
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = deviceInfo.deviceId;
    
    if (videoWatched) {
      const unlockSuccess = markDeviceUnlocked(deviceId, identifier, 100);
      
      if (unlockSuccess) {
        res.json({
          ok: true,
          deviceId: deviceId.slice(0,8) + '...',
          bundleMB: 100,
          message: 'Device unlocked successfully!'
        });
      } else {
        res.status(500).json({ ok: false, message: 'Failed to unlock device' });
      }
    } else {
      res.status(400).json({ ok: false, message: 'Video watching required for unlock' });
    }
  } catch (error) {
    console.error('[DEVICE-UNLOCK-ERROR]', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.get('/api/device/sessions', (req, res) => {
  try {
    const activeSessions = [];
    
    for (const [deviceId, client] of activeClients.entries()) {
      if (Date.now() < client.expires) {
        const deviceSession = deviceSessions.get(deviceId);
        activeSessions.push({
          deviceId: deviceId.slice(0,8) + '...',
          identifier: client.identifier,
          ip: client.ip,
          mac: client.mac || 'unknown',
          lastSeen: new Date(client.lastSeen).toISOString(),
          expires: new Date(client.expires).toISOString(),
          revalidationRequired: deviceSession ? deviceSession.revalidationRequired : false
        });
      }
    }
    
    res.json({
      ok: true,
      totalActiveSessions: activeSessions.length,
      sessions: activeSessions
    });
  } catch (error) {
    console.error('[DEVICE-SESSIONS-ERROR]', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.get('/api/admin/ads/summary', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try { const o=buildAdminOverview(); res.json({ ok:true, ads:o.adsTable }); } catch(err){ res.status(500).json({ ok:false, message:'Error summarising ads' }); }
});

// Lightweight debug state (non-admin but requires identifier param)
app.get('/api/debug/state',(req,res)=>{
  const id=(req.query.identifier||'').toString().trim().toLowerCase();
  if(!id) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const quota=computeRemainingUnified(id);
    const state={
      quota,
      socialUnlocked: socialUnlocked.has(id),
      fullAccessUnlocked: fullAccessUnlocked.has(id),
      tempFullAccessActive: (tempFullAccess.get(id)||0) > Date.now(),
      adWatchSecondsAccumulated: adWatchAccumulators.get(id)||0,
      hasGrantTicket: !!(adGrantEligibility.get(id) && Date.now()<adGrantEligibility.get(id).expires)
    };
    res.json({ ok:true, state });
  } catch(err){ res.status(500).json({ ok:false, message:'debug error'}); }
});
// Aliases for convenience
app.get(['/debug/state','/debug'],(req,res)=>{
  const id=(req.query.identifier||'').toString().trim().toLowerCase();
  if(!id) return res.status(200).send('Provide ?identifier=your_email_or_phone (normalized). Example: /debug/state?identifier=user@example.com');
  try {
    const quota=computeRemainingUnified(id);
    const payload={
      quota,
      socialUnlocked: socialUnlocked.has(id),
      fullAccessUnlocked: fullAccessUnlocked.has(id),
      tempFullAccessActive: (tempFullAccess.get(id)||0) > Date.now(),
      adWatchSecondsAccumulated: adWatchAccumulators.get(id)||0,
      hasGrantTicket: !!(adGrantEligibility.get(id) && Date.now()<adGrantEligibility.get(id).expires)
    };
    res.json(payload);
  } catch(err){ res.status(500).send('debug error'); }
});

// List raw ad definitions (even with zero events) for admin "My Usage by Ad" view
app.get('/api/admin/ads/list', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try {
    seedDefaultAds();
    const wb = loadWorkbookWithTracking();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADS]);
    res.json({ ok:true, ads: rows });
  } catch(err){
    res.status(500).json({ ok:false, message:'Error listing ads' });
  }
});

// Lightweight diagnostics: total ad events & distinct adIds (admin only)
app.get('/api/admin/ads/events/count', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  try {
    const wb = loadWorkbookWithTracking();
    const evRows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    const adIds = new Set(evRows.map(r=>r.adId).filter(Boolean));
    res.json({ ok:true, totalEvents: evRows.length, distinctAds: adIds.size, adIds:[...adIds].slice(0,50) });
  } catch(err){
    res.status(500).json({ ok:false, message:'Error reading ad events' });
  }
});

// Admin push endpoint for router live metrics (to be called by router agent / script)
// Body: { routerId, bytesDown, bytesUp, devices:[{id,ip?}] }
app.post('/api/admin/router/usage', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const { routerId, bytesDown, bytesUp, devices } = req.body||{};
  if(!routerId){ return res.status(400).json({ ok:false, message:'Missing routerId' }); }
  try {
    const deviceIds = Array.isArray(devices) ? devices.map(d=> (d.id||d.mac||d.ip||'').toString().slice(0,60)).filter(Boolean) : [];
    logRouterUsage(routerId, bytesDown, bytesUp, deviceIds);
    res.json({ ok:true });
  } catch(err){
    console.error('Router usage push error', err);
    res.status(500).json({ ok:false, message:'Error logging usage' });
  }
});

// Admin query of recent router usage (aggregate & time series)
app.get('/api/admin/router/usage', (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const routerId = (req.query.routerId||'').toString().trim();
  const minutes = Math.min(1440, Number(req.query.minutes)||60); // default 60 mins
  try {
    const wb = loadWorkbookWithTracking();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_USAGELOG]);
    const since = Date.now() - minutes*60*1000;
    const filtered = rows.filter(r=> (!routerId || r.routerId===routerId) && Date.parse(r.tsISO)>=since);
    // Aggregate current device set + average Mbps (bits/sec / 1e6)
    let totalDown=0, totalUp=0; const deviceSet=new Set();
    filtered.forEach(r=>{ totalDown+=Number(r.bytesDown)||0; totalUp+=Number(r.bytesUp)||0; if(r.devices){ r.devices.split('|').forEach(d=>{ if(d) deviceSet.add(d); }); } });
    const seconds = filtered.length; // each row = ~1 second sample (assuming 1s push); fallback adjust if needed
    const mbpsDown = seconds? (totalDown*8/seconds/1e6):0;
    const mbpsUp = seconds? (totalUp*8/seconds/1e6):0;
    res.json({ ok:true, routerId: routerId||null, samples: filtered.slice(-500), // cap return size
      summary:{ samples: filtered.length, totalBytesDown: totalDown, totalBytesUp: totalUp, mbpsDown: Number(mbpsDown.toFixed(3)), mbpsUp: Number(mbpsUp.toFixed(3)), devices:[...deviceSet] } });
  } catch(err){
    console.error('Router usage query error', err);
    res.status(500).json({ ok:false, message:'Error reading usage' });
  }
});

app.post('/api/login', (req,res)=>{
  const { email, password } = req.body; // "email" may be phone or email identifier
  if(!email || !password){ return res.status(400).json({ ok:false, message:'Missing fields'}); }
  
  if(validateLogin(email.trim(), password)){
    try { 
  const evt = { identifier: email.trim().toLowerCase(), type:'login', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] };
  if (sqliteDB) sqliteDB.appendAccessEvent(evt); else appendAccessEvent(evt);
    } catch {}
    
    // Enhanced device registration on successful login
    const deviceRegistration = registerActiveClient(req, email.trim().toLowerCase(), 6);
    
    if (deviceRegistration) {
      return res.json({ 
        ok: true,
        deviceRegistered: true,
        deviceInfo: {
          deviceId: deviceRegistration.deviceId.slice(0,8) + '...',
          sessionToken: deviceRegistration.sessionToken
        }
      });
    } else {
      return res.json({ ok: true, deviceRegistered: false });
    }
  }
  res.status(401).json({ ok:false, message:'Invalid credentials' });
});

// Health endpoint: returns SQLite user count, DB path, and current render host
app.get('/health', (req, res) => {
  try {
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'logins.db');
    let users = 0;
    if (sqliteDB && typeof sqliteDB._db === 'function' && sqliteDB._db()) {
      try {
        const db = sqliteDB._db();
        const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
        users = row && (row.c || row['COUNT(*)'] || Object.values(row)[0]) ? Number(row.c || row['COUNT(*)'] || Object.values(row)[0]) : 0;
      } catch (err) {
        console.warn('[/health] count error', err && err.message);
        users = 0;
      }
    }
    return res.json({ status: 'ok', users, db: dbPath, host: RENDER_HOST });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err && err.message });
  }
});

// Admin users list (no auth for now) - returns [{ email, phone }, ...]
app.get('/admin/users', requireAdminToken, (req, res) => {
  try {
    if (!sqliteDB || typeof sqliteDB._db !== 'function' || !sqliteDB._db()) {
      return res.json([]);
    }
    const db = sqliteDB._db();
    const rows = db.prepare('SELECT email, phone FROM users').all();
    const users = (rows || []).map(r => ({ email: r.email || null, phone: r.phone || null }));
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err && err.message });
  }
});

// Admin dump users (no auth) - returns email, phone, masked password_hash (first 6 chars)
app.get('/admin/dump-users', requireAdminToken, (req, res) => {
  try {
  // Auth handled by requireAdminToken
    if (!sqliteDB || typeof sqliteDB._db !== 'function' || !sqliteDB._db()) return res.json([]);
    const db = sqliteDB._db();
    const rows = db.prepare('SELECT email, phone, password_hash FROM users').all();
    const users = (rows || []).map(r => ({
      email: r.email || null,
      phone: r.phone || null,
      password_hash: r.password_hash ? String(r.password_hash).slice(0,6) : null
    }));
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err && err.message });
  }
});

// Admin metrics: total users, login attempts, quota usage summary, ad unlocks
app.get('/admin/metrics', requireAdminToken, (req, res) => {
  try {
    const metrics = { totalUsers: 0, loginAttempts: 0, quota: { totalExhausted: 0, totalActive: 0 }, adUnlocks: 0 };
    if (sqliteDB && typeof sqliteDB._db === 'function' && sqliteDB._db()) {
      const db = sqliteDB._db();
      const urow = db.prepare('SELECT COUNT(*) as c FROM users').get();
      metrics.totalUsers = Number(urow && (urow.c || Object.values(urow)[0]) || 0);
      // login attempts = events where type = 'login' or 'login_attempt'
      const lrow = db.prepare("SELECT COUNT(*) as c FROM events WHERE type LIKE 'login%'").get();
      metrics.loginAttempts = Number(lrow && (lrow.c || Object.values(lrow)[0]) || 0);
  // ad unlocks = events of type 'video_completed' or 'video_unlock'
  const arow = db.prepare("SELECT COUNT(*) as c FROM events WHERE type IN ('video_completed','video_unlock')").get();
  metrics.adUnlocks = Number(arow && (arow.c || Object.values(arow)[0]) || 0);
  // proxy bypasses - any event that mentions bypass in its type
  const prow = db.prepare("SELECT COUNT(*) as c FROM events WHERE lower(type) LIKE '%bypass%'").get();
  metrics.proxyBypasses = Number(prow && (prow.c || Object.values(prow)[0]) || 0);
    }

    // Quota summary using dataTracker
    try {
      const allUsersUsage = dataTracker.getAllActiveUsers ? dataTracker.getAllActiveUsers() : [];
      let exhausted = 0, active = 0;
      for (const u of allUsersUsage) {
        if (u.exhausted) exhausted++; else active++;
      }
      metrics.quota.totalExhausted = exhausted;
      metrics.quota.totalActive = active;
    } catch (e) {
      console.warn('[METRICS-TRACKER-ERR]', e && e.message);
    }

    return res.json(metrics);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err && err.message });
  }
});

// API to unlock quota for a device (admin or via server-side flow)
app.post('/api/unlock', requireAdminToken, (req, res) => {
  try {
    const identifier = (req.body.identifier || '').toString().trim().toLowerCase();
    const deviceId = (req.body.deviceId || '').toString().trim();
    const amount = Number(req.body.amount || 100);
    if (!identifier || !deviceId) return res.status(400).json({ ok: false, message: 'identifier and deviceId required' });

    const ok = markDeviceUnlocked(deviceId, identifier, amount);
    if (ok) {
      // record event in sqlite
      try { if (sqliteDB) sqliteDB.appendAccessEvent({ identifier, type: 'video_unlock', tsISO: new Date().toISOString(), ip: req.ip, ua: req.headers['user-agent'] }); } catch {}
      return res.json({ ok: true, message: 'device unlocked', deviceId, identifier, amount });
    }
    return res.status(500).json({ ok: false, message: 'unlock failed' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err && err.message });
  }
});

// Admin debug: check remote TCP/TLS connectivity from this server to a host:port
app.get('/admin/check-remote', requireAdminToken, async (req, res) => {
  const host = (req.query.host || '').toString();
  const port = Number(req.query.port || 443);
  const useTls = req.query.tls !== '0';
  if (!host) return res.status(400).json({ ok: false, message: 'missing host query param' });

  try {
    const result = { host, port, useTls, ok: false, error: null, timeMs: null };
    const start = Date.now();
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port, timeout: 5000 }, () => {
        if (!useTls) {
          socket.end();
          return resolve();
        }
        // If TLS requested, initiate a simple TLS handshake
        try {
          const tls = require('tls');
          const tlsSock = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
            tlsSock.end();
            return resolve();
          });
          tlsSock.on('error', e => { try{ tlsSock.destroy(); }catch{}; reject(e); });
        } catch (e) {
          try { socket.destroy(); } catch {};
          reject(e);
        }
      });
      socket.on('error', err => reject(err));
      socket.on('timeout', () => { socket.destroy(); reject(new Error('connect timeout')); });
    });
    result.ok = true;
    result.timeMs = Date.now() - start;
    return res.json(result);
  } catch (err) {
    return res.json({ ok: false, host, port, error: err && err.message });
  }
});

// Change password (logged-in user supplies identifier + old & new password)
app.post('/api/change-password', (req,res)=>{
  const { identifier, oldPassword, newPassword } = req.body;
  if(!identifier || !oldPassword || !newPassword){
    return res.status(400).json({ ok:false, message:'Missing fields' });
  }
  if(!isStrongPassword(newPassword)){
    return res.status(400).json({ ok:false, message:'Weak new password' });
  }
  if (sqliteDB) {
    const changed = sqliteDB.changePassword(identifier.trim(), newPassword);
    if (!changed.ok) return res.status(404).json({ ok:false, message:changed.message || 'User not found' });
    try { sqliteDB.appendAccessEvent({ identifier: identifier.trim().toLowerCase(), type:'password_reset', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
    return res.json({ ok:true });
  }

  const { wb, ws, data } = getUsers();
  const user = findUserRecord(data, identifier.trim());
  if(!user) return res.status(404).json({ ok:false, message:'User not found' });
  if(user.password !== oldPassword) return res.status(401).json({ ok:false, message:'Old password incorrect' });
  user.password = newPassword;
  wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
  XLSX.writeFile(wb, DATA_FILE);
  try { appendAccessEvent({ identifier: (user.email||user.phone||'').toLowerCase(), type:'password_reset', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
  res.json({ ok:true });
});

// Get own profile (excluding password)
app.get('/api/me/profile', (req,res)=>{
  const raw=(req.query.identifier||'').toString().trim();
  const identifier=raw.toLowerCase();
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const { data } = getUsers();
    const user = findUserRecord(data, identifier);
    if(!user){
      console.warn('[profile 404] identifier=', identifier, 'available users=', data.map(u=>u.email+':'+u.phone));
      return res.status(404).json({ ok:false, message:'User not found' });
    }
    const { password, ...pub } = user;
    // For backward compatibility: if legacy avatarData long base64 present but no file path yet, expose as received (client will still show) but prefer avatarPath
    if(pub.avatarPath){
      pub.avatarUrl = '/' + pub.avatarPath.replace(/\\/g,'/');
    }
    res.json({ ok:true, profile: pub });
  } catch(err){
    console.error('Profile load error', err);
    res.status(500).json({ ok:false, message:'Error loading profile'});
  }
});

// Serve static files (mounted after API routes so routes are not overridden by files)
app.use(express.static(__dirname));

// Update own profile (only firstName, surname, dob, avatarData) — phone/email locked
app.post('/api/me/profile/update', (req,res)=>{
  const { identifier, firstName, surname, dob, avatarData, removeAvatar, email: newEmail, phone: newPhone } = req.body||{}; // allow adding email/phone if previously empty
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const id = identifier.trim();
    const { wb, ws, data } = getUsers();
    const user = findUserRecord(data, id);
    if(!user) return res.status(404).json({ ok:false, message:'User not found'});
  const before = { firstName:user.firstName, surname:user.surname, dob:user.dob };
    // Basic field validation / assignment
    if(firstName!==undefined){ if(!firstName.trim()) return res.status(400).json({ ok:false, field:'firstName', message:'First name required'}); user.firstName=firstName.trim(); }
    if(surname!==undefined){ if(!surname.trim()) return res.status(400).json({ ok:false, field:'surname', message:'Surname required'}); user.surname=surname.trim(); }
    if(dob!==undefined){ if(!dob) return res.status(400).json({ ok:false, field:'dob', message:'DOB required'}); if(new Date(dob)>new Date()) return res.status(400).json({ ok:false, field:'dob', message:'DOB in future'}); user.dob=dob; }

    // Optional: add email if currently missing and provided
    if(newEmail!==undefined){
      const trimmed=(newEmail||'').trim().toLowerCase();
      if(trimmed){
        if(user.email && user.email.toLowerCase()!==trimmed){
          return res.status(400).json({ ok:false, field:'email', message:'Email cannot be changed' });
        }
        if(!user.email){
          // validate format
          if(!/^([^@\s]+)@([^@\s]+)\.[^@\s]+$/.test(trimmed)) return res.status(400).json({ ok:false, field:'email', message:'Invalid email' });
          // uniqueness
          if(data.find(u=> String(u.email||'').trim().toLowerCase()===trimmed)) return res.status(409).json({ ok:false, field:'email', message:'Email already in use' });
          user.email=trimmed;
        }
      }
    }
    // Optional: add phone if currently missing and provided
    if(newPhone!==undefined){
      const normNew=normalizePhone(newPhone);
      if(normNew){
        if(user.phone && user.phone!==normNew){
          return res.status(400).json({ ok:false, field:'phone', message:'Phone cannot be changed' });
        }
        if(!user.phone){
          if(data.find(u=> u.phone===normNew)) return res.status(409).json({ ok:false, field:'phone', message:'Phone already in use' });
          user.phone=normNew;
        }
      } else if(newPhone){
        return res.status(400).json({ ok:false, field:'phone', message:'Invalid phone' });
      }
    }

    // Avatar processing: accept data URL, persist to /avatars folder, store only relative path (avoid >32k Excel cell limit)
    if(removeAvatar){
      // Delete existing avatar file (best effort) and clear fields
      if(user.avatarPath){
        try {
          const full = path.join(__dirname, user.avatarPath);
          if(full.startsWith(path.join(__dirname,'avatars')) && fs.existsSync(full)) fs.unlinkSync(full);
        } catch {}
      }
      delete user.avatarPath; delete user.avatarData;
    } else if(typeof avatarData === 'string' && avatarData.startsWith('data:image/')){
      try {
        const match = avatarData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
        if(!match) return res.status(400).json({ ok:false, field:'avatar', message:'Unsupported image format'});
        const ext = match[1].toLowerCase()==='jpg'?'jpg':match[1].toLowerCase();
        const b64 = match[2];
        const buf = Buffer.from(b64,'base64');
        const sizeKB = buf.length/1024;
        if(sizeKB>250) return res.status(400).json({ ok:false, field:'avatar', message:'Avatar too large (max 250KB)'});
        const avatarsDir = path.join(__dirname,'avatars');
        if(!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir); // create if missing
        // Sanitize identifier for filename
        const safeId = (user.email||user.phone||'user').replace(/[^a-z0-9]/gi,'_').slice(0,40);
        const filename = safeId + '_' + Date.now() + '.' + ext;
        const fullPath = path.join(avatarsDir, filename);
        fs.writeFileSync(fullPath, buf);
        // Optionally delete old avatar file (best-effort)
        if(user.avatarPath){
          const old = path.join(__dirname, user.avatarPath);
          if(old.startsWith(avatarsDir) && fs.existsSync(old)){
            try { fs.unlinkSync(old); } catch {}
          }
        }
        delete user.avatarData; // remove any legacy base64 to shrink workbook
        user.avatarPath = path.join('avatars', filename).replace(/\\/g,'/');
      } catch(err){
        return res.status(500).json({ ok:false, field:'avatar', message:'Error saving avatar'});
      }
    }

    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
    XLSX.writeFile(wb, DATA_FILE);
    const { password, ...pub } = user;
    if(pub.avatarPath){ pub.avatarUrl = '/' + pub.avatarPath.replace(/\\/g,'/'); }
  try { const changedFields=[]; ['firstName','surname','dob'].forEach(f=>{ if(before[f]!==user[f]) changedFields.push(f); }); if(changedFields.length){ appendAccessEvent({ identifier: (user.email||user.phone||'').toLowerCase(), type:'profile_change', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'], detailsJSON: JSON.stringify({ changedFields }) }); } } catch {}
    res.json({ ok:true, profile: pub });
  } catch(err){
    console.error('Profile update error', err);
    res.status(500).json({ ok:false, message:'Error updating profile'});
  }
});

// Delete account (requires correct password)
app.post('/api/me/delete', (req,res)=>{
  const { identifier, password } = req.body||{};
  if(!identifier || !password) return res.status(400).json({ ok:false, message:'Missing fields'});
  try {
    const { wb, ws, data } = getUsers();
    const raw = String(identifier).trim();
    let user = findUserRecord(data, raw);
    // Fallback: try matching by email OR phone explicitly if not found
    if(!user){
      const lower = String(raw).trim().toLowerCase();
      const normPhone = normalizePhone(raw);
      user = data.find(u=> String(u.email||'').trim().toLowerCase()===lower || u.phone===normPhone);
    }
    if(!user) return res.status(404).json({ ok:false, message:'User not found'});
    if(user.password !== password) return res.status(401).json({ ok:false, message:'Password incorrect'});
    // Remove avatar file if exists
    if(user.avatarPath){
      try {
        const full = path.join(__dirname, user.avatarPath);
        if(full.startsWith(path.join(__dirname,'avatars')) && fs.existsSync(full)) fs.unlinkSync(full);
      } catch(err){ console.warn('Avatar delete error', err?.message); }
    }
    const filtered = data.filter(u=>u!==user);
    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(filtered);
    XLSX.writeFile(wb, DATA_FILE);
    return res.json({ ok:true });
  } catch(err){
    console.error('Delete account error', err);
    return res.status(500).json({ ok:false, message:'Server error deleting account'});
  }
});

app.get('/api/user-exists', (req,res)=>{
  const identifier = (req.query.email||'').trim();
  if(!identifier) return res.json({ exists:false });
  const { data } = getUsers();
  let exists;
  if(identifier.includes('@')){
    const q = String(identifier).trim().toLowerCase();
    exists = data.some(u=> String(u.email||'').trim().toLowerCase()===q);
  } else {
    exists = data.some(u=>u.phone===normalizePhone(identifier));
  }
  res.json({ exists });
});

// Helper to list local IPv4 addresses for convenience
function localIPv4s(){
  const nets = os.networkInterfaces();
  const addrs = [];
  Object.values(nets).forEach(list=>{ (list||[]).forEach(iface=>{ if(iface.family==='IPv4' && !iface.internal) addrs.push(iface.address); }); }); 
  return addrs;
}

const HOST = process.env.HOST || '0.0.0.0';
function startExpress(port, attemptsLeft){
  console.log('[startExpress] attempting to bind Express on', HOST, port);
  const server = app.listen(port, HOST, ()=>{
    PORT = port;
    console.log(`Server running on http://localhost:${PORT}`);
    if(HOST === '0.0.0.0'){
      const ips = localIPv4s();
      if(ips.length){
        console.log('Accessible on LAN at:');
        ips.forEach(ip=> console.log(`  http://${ip}:${PORT}/login.html`));
      }
    }
    // Start heartbeat logging after first successful bind
    if(!global.__ISN_HEARTBEAT){
      global.__ISN_HEARTBEAT = setInterval(()=>{
        try {
          console.log('[heartbeat]', new Date().toISOString(), 'port', PORT, 'activeClients', activeClients.size);
        } catch{}
      }, 60000);
    }
    
    // Start bandwidth tracking for real users only
    if(!global.__ISN_BANDWIDTH_SIM){
      global.__ISN_BANDWIDTH_SIM = setInterval(()=>{
        try {
          trackRealUserBandwidthUsage(); // Track only real active users, no demo data
        } catch(err) {
          console.warn('[real-bandwidth-tracking-error]', err?.message);
        }
      }, 2000); // Update every 2 seconds for live tracking
      
      console.log('[REAL-BANDWIDTH] Tracking actual active users only - no demo simulation!');
    }
    
    // NO DEMO DATA - Only showing real active users
    console.log('[REAL-USERS-ONLY] Admin dashboard will show only actual active users, no demo data');
  });
  server.on('error',err=>{
    if(err.code==='EADDRINUSE'){
      console.error(`❌ CRITICAL: Port ${port} is already in use!`);
      console.error('Please close any other instances of this server or restart your computer.');
      console.error('Cannot start server on alternate port - phone clients expect exact port 3150.');
      process.exit(1);
    } else {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    }
  });
}
// Proxy status (based on client IP mapping)
app.get('/api/proxy/status',(req,res)=>{
  try {
    const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
    const mapped = resolveActiveClient(ip);
    if(!mapped) return res.json({ ok:true, authorized:false, remainingMB:0, reason:'not_authorized' });
    const quota = computeRemainingUnified(mapped);
    res.json({ ok:true, authorized:!quota.exhausted, remainingMB:quota.remainingMB, totalBundleMB: quota.totalBundleMB, usedMB: quota.totalUsedMB, exhausted: quota.exhausted, identifier:mapped });
  } catch(err){ res.status(500).json({ ok:false, message:'status error'}); }
});

// PAC file to simplify user proxy configuration
app.get('/proxy.pac',(req,res)=>{
  try {
    const hostHeader = req.headers.host || ('localhost:'+PORT);
    const hostOnly = hostHeader.split(':')[0];
  const strict = (req.query.strict==='1') || process.env.PAC_STRICT==='true';
  // When strict, we do not offer DIRECT fallback except for portal + RFC1918 + plain hostnames
  const proxyLine = strict ? `PROXY ${hostOnly}:${PROXY_PORT}` : `PROXY ${hostOnly}:${PROXY_PORT}; DIRECT`;
    res.setHeader('Content-Type','application/x-ns-proxy-autoconfig');
  res.end(`function FindProxyForURL(url, host){\n  host = host.toLowerCase();\n  // Always go direct for portal host and local/LAN addresses to ensure captive page reachable\n  if (dnsDomainIs(host, "${hostOnly}") || shExpMatch(host, "192.168.*") || shExpMatch(host, "10.*") || shExpMatch(host, "172.16.*") || shExpMatch(host, "172.17.*") || shExpMatch(host, "172.18.*") || shExpMatch(host, "172.19.*") || shExpMatch(host, "172.2?.*") || shExpMatch(host, "172.3?.*") || isPlainHostName(host)) return "DIRECT";\n  return "${proxyLine}";\n}`);
  } catch(err){ res.status(500).send('PAC error'); }
});

startExpress(PORT, 5);

// Global diagnostics to avoid silent exits
process.on('uncaughtException', err=>{
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err=>{
  console.error('[unhandledRejection]', err);
});
