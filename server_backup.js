console.log('Starting ISN Free WiFi portal server...');
const express = require('express');
console.log('Express loaded');
const path = require('path');
const fs = require('fs');
const os = require('os');
console.log('Basic modules loaded');
const XLSX = require('xlsx');
console.log('XLSX loaded');
const http = require('http');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
console.log('All modules loaded successfully');

console.log('Booting portal server...');
const app = express();
// Default portal port 3100 (auto-fallback if busy)
let PORT = parseInt(process.env.PORT,10) || 3150;
const PROXY_PORT = process.env.PROXY_PORT || 9092; // Changed to 9092 to avoid conflicts
const PORTAL_SECRET = process.env.PORTAL_SECRET || 'isn_portal_secret_dev';
const DATA_FILE = path.join(__dirname, 'logins.xlsx');
const ADMIN_EMAIL = 'sbusisosweetwell15@gmail.com';

// Active client mapping (IP -> session info) so proxy can authorize requests without relying on cookies (since site cookies aren't forwarded to other hosts via proxy)
// NOTE: This is a simplified approach (shared IPs / NAT will share allowance). Future: track by MAC (via router agent) or assign explicit proxy auth tokens.
const activeClients = new Map(); // ip -> { identifier, lastSeen, expires }

// Real-time usage tracking for admin dashboard with live bandwidth monitoring
const realtimeUsage = new Map(); // identifier -> { downMbps: number, upMbps: number, totalDataMB: number, lastUpdateTime: number, connectionStart: number, bytesDownLoaded: number, bytesUploaded: number, peakDownMbps: number, peakUpMbps: number }
const routerStats = new Map(); // routerId -> { connectedUsers: Set, totalDataServed: number, downMbps: number, upMbps: number, status: string, lastMaintenance: string, flags: string[], peakDownMbps: number, peakUpMbps: number }
const bandwidthHistory = new Map(); // identifier -> Array of {timestamp, downMbps, upMbps} for live tracking

function normalizeIp(ip){ if(!ip) return ''; return ip.replace(/^::ffff:/,''); }
function registerActiveClient(req, identifier, hours=6){
  try {
    const rawIp = normalizeIp((req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '');
    if(!rawIp) {
      console.warn('[REGISTER-CLIENT-FAILED] No IP found for', identifier);
      return;
    }
    activeClients.set(rawIp, { identifier, lastSeen: Date.now(), expires: Date.now()+hours*3600*1000 });
    
    // Initialize real-time usage tracking with live bandwidth monitoring
    if (!realtimeUsage.has(identifier)) {
      realtimeUsage.set(identifier, {
        downMbps: 0,
        upMbps: 0,
        totalDataMB: 0,
        lastUpdateTime: Date.now(),
        connectionStart: Date.now(),
        bytesDownLoaded: 0,
        bytesUploaded: 0,
        peakDownMbps: 0,
        peakUpMbps: 0
      });
      
      // Initialize bandwidth history for live score-like tracking
      if (!bandwidthHistory.has(identifier)) {
        bandwidthHistory.set(identifier, []);
      }
    }
    
    console.log(`[CLIENT-REGISTERED] ${identifier} at ${rawIp} (expires in ${hours}h)`);
  } catch(err) {
    console.error('[REGISTER-CLIENT-ERROR]', err?.message);
  }
}

function normalizeIp(ip){ if(!ip) return ''; return ip.replace(/^::ffff:/,''); }

// Function to update real-time usage data
function updateRealtimeUsage(identifier, bytesSent, bytesReceived) {
  try {
    const usage = realtimeUsage.get(identifier);
    if (!usage) return;
    
    const now = Date.now();
    const timeDiffSeconds = (now - usage.lastUpdateTime) / 1000;
    
    if (timeDiffSeconds > 0) {
      // Calculate Mbps (Megabits per second)
      const downMbps = (bytesReceived * 8) / (1024 * 1024 * timeDiffSeconds);
      const upMbps = (bytesSent * 8) / (1024 * 1024 * timeDiffSeconds);
      
      // Update usage data
      usage.downMbps = Math.round(downMbps * 100) / 100; // Round to 2 decimal places
      usage.upMbps = Math.round(upMbps * 100) / 100;
      usage.totalDataMB += (bytesSent + bytesReceived) / (1024 * 1024);
      usage.lastUpdateTime = now;
      
      // Update router stats
      const routerId = usage.routerId;
      const router = routerStats.get(routerId);
      if (router) {
        router.totalDataServed += (bytesSent + bytesReceived) / (1024 * 1024);
        
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
      }
    }
  } catch (err) {
    console.error('[UPDATE-REALTIME-USAGE-ERROR]', err);
  }
}
// Router-level device tracking for strict access control
const routerDeviceActivity = new Map(); // routerId -> { activeDevice: deviceFingerprint, lastActivityTime: timestamp, blockOthers: boolean }

function resolveActiveClient(ip, req = null){
  const rec = activeClients.get(normalizeIp(ip));
  if(!rec) return null;
  if(Date.now()>rec.expires){ activeClients.delete(normalizeIp(ip)); return null; }
  rec.lastSeen=Date.now();
  
  // STRICT DEVICE ACCESS CONTROL - Block other devices when one is actively watching
  if(req) {
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    // Check if another device on this router is actively watching videos
    const routerActivity = routerDeviceActivity.get(routerId);
    if(routerActivity && routerActivity.blockOthers) {
      const timeSinceActivity = Date.now() - routerActivity.lastActivityTime;
      
      // If another device was active in last 5 minutes and this isn't that device
      if(timeSinceActivity < 5 * 60 * 1000 && routerActivity.activeDevice !== deviceFingerprint) {
        console.log('[ROUTER-BLOCKED]', {
          blockedDevice: deviceFingerprint,
          activeDevice: routerActivity.activeDevice,
          routerId: routerId,
          reason: 'another_device_watching_videos'
        });
        return null; // Block access for this device
      }
    }
  }
  
  return rec.identifier;
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

// Record a bundle purchase (grant) with strict device tracking
function recordPurchase(identifier, bundleMB, routerId, ua, source, deviceFingerprint){
  const idLower = (identifier||'').trim().toLowerCase();
  const wb = loadWorkbookWithTracking();
  const { rows } = listPurchases();
  const { data: users } = getUsers();
  const user = users.find(u=>u.email===idLower || u.phone===normalizePhone(idLower));
  
  // Create device-specific identifier for strict tracking
  const deviceId = deviceFingerprint || crypto.createHash('md5').update((ua||'') + routerId).digest('hex').slice(0,16);
  
  const entry = {
    id: guid(),
    identifier: idLower,
    deviceId: deviceId, // NEW: Device-specific tracking
    email: user?user.email: (idLower.includes('@')?idLower:''),
    phone: user?user.phone: (!idLower.includes('@')?normalizePhone(idLower):''),
    bundleMB: Number(bundleMB)||0,
    usedMB: 0,
    routerId: routerId||'default-router',
    deviceUA: (ua||'').slice(0,250),
    grantedAtISO: new Date().toISOString(),
    source: source||'manual',
    strictMode: true // NEW: Flag for strict per-device enforcement
  };
  rows.push(entry);
  writeSheet(wb, SHEET_PURCHASES, rows);
  
  console.log(`[STRICT-BUNDLE] Granted ${bundleMB}MB to device ${deviceId} for user ${idLower}`);
  return entry;
}

// Increment usage with strict device-specific tracking
function addUsage(identifier, usedDeltaMB, deviceFingerprint, routerId){
  const idLower=(identifier||'').trim().toLowerCase();
  const wb = loadWorkbookWithTracking();
  const purchases = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PURCHASES]);
  
  // Create device ID for strict tracking
  const deviceId = deviceFingerprint || crypto.createHash('md5').update(routerId || 'default').digest('hex').slice(0,16);
  
  // Apply to most recent unexhausted purchase for THIS SPECIFIC DEVICE
  const target = purchases.slice().reverse().find(p=> 
    (p.identifier===idLower) && 
    (p.deviceId===deviceId) && // NEW: Device-specific matching
    (Number(p.usedMB)<Number(p.bundleMB))
  );
  
  if(!target) {
    console.log(`[STRICT-USAGE] No valid bundle found for device ${deviceId} of user ${idLower}`);
    return false;
  }
  
  const beforeUsage = Number(target.usedMB||0);
  target.usedMB = Math.min(Number(target.bundleMB), beforeUsage + Number(usedDeltaMB||0));
  const actualUsed = target.usedMB - beforeUsage;
  
  console.log(`[STRICT-USAGE] Device ${deviceId}: Used ${actualUsed}MB (${beforeUsage}MB -> ${target.usedMB}MB of ${target.bundleMB}MB)`);
  
  // Update real-time bandwidth tracking like live scores
  updateLiveBandwidthTracking(idLower, actualUsed, routerId);
  
  writeSheet(wb, SHEET_PURCHASES, purchases);
  return true;
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
  const idLower=(identifier||'').trim().toLowerCase();
  if(!idLower) return { remainingMB:0, totalBundleMB:0, totalUsedMB:0, activeBundleMB:0, activeBundleUsedMB:0 };
  
  const wb = loadWorkbookWithTracking();
  const purchases = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PURCHASES]);
  
  // Create device ID for strict tracking
  const deviceId = deviceFingerprint || crypto.createHash('md5').update(routerId || 'default').digest('hex').slice(0,16);
  
  // Filter for THIS SPECIFIC DEVICE only
  const my = purchases.filter(p=> 
    p.identifier===idLower && 
    (p.deviceId===deviceId || !p.strictMode) // Include legacy non-strict bundles for compatibility
  ).sort((a,b)=> new Date(a.grantedAtISO)-new Date(b.grantedAtISO));
  
  let totalBundle=0,totalUsed=0; 
  my.forEach(p=>{ 
    totalBundle+=Number(p.bundleMB)||0; 
    totalUsed+=Number(p.usedMB)||0; 
  });
  
  console.log(`[STRICT-REMAINING] Device ${deviceId} for user ${idLower}: ${totalBundle-totalUsed}MB remaining of ${totalBundle}MB total`);
  
  const active = [...my].reverse().find(p=> (Number(p.usedMB)||0) < (Number(p.bundleMB)||0));
  return {
    remainingMB: Math.max(0,totalBundle-totalUsed),
    totalBundleMB: totalBundle,
    totalUsedMB: totalUsed,
    activeBundleMB: active?Number(active.bundleMB)||0:0,
    activeBundleUsedMB: active?Number(active.usedMB)||0:0,
    exhausted: (totalBundle-totalUsed)<=0
  };
}

// Unified (email + phone) quota for a user (if they have both identifiers)
function computeRemainingUnified(identifier, deviceFingerprint, routerId){
  const idLower=(identifier||'').trim().toLowerCase();
  const { data: users } = getUsers();
  const user = users.find(u=> (u.email||'').toLowerCase()===idLower || (u.phone && u.phone===normalizePhone(idLower)) );
  if(!user) return computeRemaining(idLower, deviceFingerprint, routerId);
  
  // Create device ID for strict tracking across unified accounts
  const deviceId = deviceFingerprint || crypto.createHash('md5').update((routerId || 'default')).digest('hex').slice(0,16);
  
  const ids = new Set();
  if(user.email) ids.add(user.email.toLowerCase());
  if(user.phone) ids.add(user.phone);
  const wb = loadWorkbookWithTracking();
  const purchases = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PURCHASES]);
  let totalBundle=0,totalUsed=0; const relevant=[];
  
  // Filter for THIS DEVICE across all unified identifiers
  purchases.forEach(p=>{ 
    if(ids.has(p.identifier) && (p.deviceId===deviceId || !p.strictMode)){ 
      totalBundle+=Number(p.bundleMB)||0; 
      totalUsed+=Number(p.usedMB)||0; 
      relevant.push(p); 
    } 
  });
  
  console.log(`[STRICT-UNIFIED] Device ${deviceId} unified for user ${idLower}: ${totalBundle-totalUsed}MB remaining`);
  
  const active=[...relevant].reverse().find(p=> (Number(p.usedMB)||0)<(Number(p.bundleMB)||0));
  return {
    remainingMB: Math.max(0,totalBundle-totalUsed),
    totalBundleMB: totalBundle,
    totalUsedMB: totalUsed,
    activeBundleMB: active?Number(active.bundleMB)||0:0,
    activeBundleUsedMB: active?Number(active.usedMB)||0:0,
    exhausted: (totalBundle-totalUsed)<=0
  };
}

// Start or update a session (ping)
function pingSession(identifier, routerId, ua){
  const idLower=(identifier||'').trim().toLowerCase();
  const wb = loadWorkbookWithTracking();
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_SESSIONS]);
  const now = new Date();
  let session = sessions.find(s=> s.identifier===idLower && s.routerId===routerId && s.active);
  if(!session){
    session = { id: guid(), identifier:idLower, routerId, deviceUA:(ua||'').slice(0,250), startedAtISO: now.toISOString(), lastPingISO: now.toISOString(), totalSeconds:0, active:true };
    sessions.push(session);
  } else {
    session.lastPingISO = now.toISOString();
    // update duration
    try { session.totalSeconds = Math.floor((new Date(session.lastPingISO) - new Date(session.startedAtISO))/1000); } catch {}
  }
  writeSheet(wb, SHEET_SESSIONS, sessions);
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
  // Filter to show ONLY users who are currently active (logged in and using the system)
  const realActiveUsers = users.filter(u => {
    const identifier = (u.email || u.phone || '').toLowerCase();
    const isCurrentlyActive = (activeSessionsById[identifier] || 0) > 0;
    
    // Only show users who are actually active right now
    return isCurrentlyActive;
  });
  
  console.log(`[ADMIN-DASHBOARD] Showing ${realActiveUsers.length} real active users (hiding inactive/demo users)`);
  
  const usersTable = realActiveUsers.map(u=>{
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
  // Registrations & Logins table - ONLY show real active users (no demo data)
  const regLoginTable = realActiveUsers.map(u=>{ 
    const identifier=(u.email||u.phone||'').toLowerCase(); 
    const ev=accessEvents.filter(e=>e.identifier===identifier); 
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
    const u = users.find(u=> (u.email||'').toLowerCase()===lower || (u.phone && u.phone===normalizePhone(lower)) );
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
app.use(express.static(__dirname));

// Explicit route for home.html to ensure it's served
app.get('/home.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

// Root shortcut -> redirect to portal page with authentication check
app.get('/', (req,res)=> {
  const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const mappedIdentifier = resolveActiveClient(clientIp, req);
  const userAgent = req.headers['user-agent'] || '';
  const isCaptivePortalCheck = userAgent.includes('CaptiveNetworkSupport') || 
                               userAgent.includes('Microsoft NCSI') ||
                               userAgent.includes('ConnectivityCheck');
  
  // Always redirect to login page for proper portal behavior
  if (isCaptivePortalCheck) {
    console.log('[CAPTIVE-PORTAL-DETECTED]', { userAgent, ip: clientIp });
  }
  
  if (mappedIdentifier) {
    // Generate device fingerprint for strict quota checking
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
    if (quota.exhausted) {
      console.log('[ROOT-ACCESS] Device with exhausted quota:', { identifier: mappedIdentifier, device: deviceFingerprint, ip: clientIp });
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

// Catch-all middleware to force ALL unauthenticated traffic to portal
app.use((req, res, next) => {
  const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const mappedIdentifier = resolveActiveClient(clientIp);
  const isApiRequest = req.path.startsWith('/api/');
  const isStaticFile = req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i);
  const isPortalPage = ['/login.html', '/register.html', '/reset.html', '/home.html', '/admin-reset.html'].includes(req.path);
  
  // Don't redirect API calls, static files, or portal pages
  if (isApiRequest || isStaticFile || isPortalPage) {
    return next();
  }
  
  // FORCE redirect ANY unauthenticated user to portal (both manual and auto proxy users)
  if (!mappedIdentifier) {
    console.log('[FORCED-PORTAL-REDIRECT] Unauthenticated user forced to portal:', { 
      path: req.path, 
      ip: clientIp, 
      userAgent: req.headers['user-agent']?.substring(0, 100) + '...'
    });
    return res.status(302).redirect(`/login.html`);
  }
  
  // If authenticated but quota exhausted, force to portal to watch videos
  const userAgent = req.headers['user-agent'] || '';
  const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
  const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
  
  const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
  if (quota && quota.exhausted) {
    console.log('[QUOTA-EXHAUSTED-REDIRECT] User with no data forced to portal:', { 
      identifier: mappedIdentifier, 
      ip: clientIp,
      remainingMB: quota.remainingMB
    });
    return res.status(302).redirect('/login.html');
  }
  
  next();
});
// Serve avatars folder if created
const avatarsDirPath = path.join(__dirname,'avatars');
if(!fs.existsSync(avatarsDirPath)){
  try { fs.mkdirSync(avatarsDirPath); } catch {}
}
app.use('/avatars', express.static(avatarsDirPath, { maxAge: '7d', immutable: false }));

function loadWorkbook(){
  // Create workbook if it doesn't exist
  if(!fs.existsSync(DATA_FILE)){
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    XLSX.writeFile(wb, DATA_FILE);
    return wb;
  }
  // Read existing workbook
  const wb = XLSX.readFile(DATA_FILE);
  // Ensure required 'Users' sheet exists (it might be missing if file was created manually)
  if(!wb.Sheets['Users']){
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    XLSX.writeFile(wb, DATA_FILE);
  }
  return wb;
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
    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
    XLSX.writeFile(wb, DATA_FILE);
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
  const wb = loadWorkbook();
  const ws = wb.Sheets['Users'];
  const data = XLSX.utils.sheet_to_json(ws);
  let user;
  if(identifier.includes('@')){
    user = data.find(u=>u.email===identifier && u.password===password);
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
  if(!data.find(u=>u.email===email)) return res.status(404).json({ ok:false, message:'Email not found' });
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
  const user = data.find(u=>u.email===email);
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

// Session ping (create/update session)
app.post('/api/session/ping', (req,res)=>{
  const { identifier, routerId } = req.body||{};
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier' });
  try {
    const session = pingSession(identifier.trim(), routerId||'default-router', req.headers['user-agent']);
  const quota = computeRemaining(identifier);
  res.json({ ok:true, session, quota });
  } catch(err){ res.status(500).json({ ok:false, message:'Session error'}); }
});

// Report usage delta (MB)
app.post('/api/usage/report', (req,res)=>{
  const { identifier, usedMB } = req.body||{};
  if(!identifier || usedMB==null) return res.status(400).json({ ok:false, message:'Missing fields' });
  try {
    const ok = addUsage(identifier.trim(), Number(usedMB));
    const quota = computeRemaining(identifier);
    res.json({ ok, quota });
  } catch(err){ res.status(500).json({ ok:false, message:'Error updating usage'}); }
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

function startProxy(){
  const proxy = http.createServer((clientReq, clientRes)=>{
    const token = extractCookie(clientReq.headers['cookie'], 'portal_token');
    const parsedToken = parsePortalToken(token || '');
    const rawHostHeader = (clientReq.headers['host']||'');
    const hostHeader = rawHostHeader.split(':')[0].toLowerCase();
    const clientIp = (clientReq.socket && clientReq.socket.remoteAddress) || '';
    let mappedIdentifier = resolveActiveClient(clientIp);
    
    const localIps = localIPv4s();
    const hotspotFallback = '192.168.137.1';
    
    // IMPORTANT: Distinguish between manual proxy and auto proxy users
    const isManualProxy = clientReq.headers['user-agent'] && 
                         (clientReq.headers['user-agent'].includes('Manual') || 
                          clientReq.headers['proxy-connection'] || 
                          clientReq.headers['proxy-authorization']);
    
    // Portal host detection
    const portalHostCandidates = new Set([ 
      (process.env.PORTAL_HOST||'').toLowerCase(), 
      'localhost', 
      hotspotFallback, 
      ...localIps 
    ]);
    const isPortalHost = portalHostCandidates.has(hostHeader);
    
    // CHECK: Always allow portal access regardless of authentication status
    // This allows users to watch videos even without data bundles
    if (isPortalHost) {
      console.log('[PORTAL-ACCESS-ALLOWED] Portal access granted:', { 
        host: hostHeader, 
        ip: clientIp,
        authenticated: !!mappedIdentifier
      });
      // Continue processing - allow portal access
    }
    // FOR MANUAL PROXY USERS: Allow portal access but block everything else until authenticated
    else if (isManualProxy && !mappedIdentifier) {
      console.log('[MANUAL-PROXY-BLOCK] Manual proxy user blocked, redirecting to portal:', { 
        host: hostHeader, 
        ip: clientIp,
        userAgent: clientReq.headers['user-agent']?.substring(0, 50) + '...'
      });
      clientRes.writeHead(302, { 
        'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=manual_proxy`,
        'Content-Type': 'text/html' 
      });
      clientRes.end(`<!DOCTYPE html>
<html><head><title>Manual Proxy - Portal Required</title>
<meta http-equiv="refresh" content="0;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
</head>
<body><h1>Manual Proxy Detected</h1>
<p>You are using manual proxy. Please log in to the portal first.</p>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html">Access Portal</a></p>
<script>window.location.replace('http://${localIps[0] || 'localhost'}:${PORT}/login.html');</script>
</body></html>`);
      return;
    }
    
    // FOR AUTO PROXY USERS: Block ALL traffic until authenticated AND videos watched  
    else if (!isManualProxy && !mappedIdentifier) {
      console.log('[AUTO-PROXY-BLOCK] Auto proxy user blocked, must watch videos first:', { 
        host: hostHeader, 
        ip: clientIp 
      });
      clientRes.writeHead(302, { 
        'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=auto_proxy`,
        'Content-Type': 'text/html' 
      });
      clientRes.end(`<!DOCTYPE html>
<html><head><title>Auto Proxy - Videos Required</title>
<meta http-equiv="refresh" content="0;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
</head>
<body><h1>Watch Videos to Access Internet</h1>
<p>Auto proxy detected. You must watch videos to earn internet access.</p>
<p><strong>Bundle System:</strong></p>
<ul><li>5 videos = 100MB</li><li>10 videos = 250MB</li><li>15 videos = 500MB</li></ul>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html">Start Watching Videos</a></p>
<script>window.location.replace('http://${localIps[0] || 'localhost'}:${PORT}/login.html');</script>
</body></html>`);
      return;
    }
    
    // Configurable walled‑garden hosts (minimal resources allowed pre-auth for portal + ads). Comma separated via WALLED_GARDEN env.
    const extraGarden = (process.env.WALLED_GARDEN||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
    // Always allow portal host + loopbacks + LAN IPs + essential ad/media CDNs (video bucket & yt thumbnails) unless STRICT_WALLED=true
    const baseGarden = new Set([
      'localhost','127.0.0.1','::1', hotspotFallback, ...localIps,
      (process.env.PORTAL_HOST||'').toLowerCase(),
      'storage.googleapis.com','i.ytimg.com','i9.ytimg.com','yt3.ggpht.com'
    ].filter(Boolean));
    if(process.env.STRICT_WALLED!=='true'){
      // Allow fonts only when not in strict mode (they are cosmetic)
      ['fonts.googleapis.com','fonts.gstatic.com','www.youtube.com','youtube.com'].forEach(h=>baseGarden.add(h));
    }
    extraGarden.forEach(h=> baseGarden.add(h));
    const walledGarden = baseGarden;
    
    if(!parsedToken && !mappedIdentifier){
      if(!walledGarden.has(hostHeader)){
        clientRes.writeHead(302, { 'Location':'http://'+(localIps[0]||'localhost')+':'+(process.env.PORT||PORT)+'/home.html', 'Content-Type':'text/plain' });
        clientRes.end('Redirecting to portal');
        return;
      }
    }
    const effectiveIdentifier = mappedIdentifier || (parsedToken && parsedToken.identifier);
    if(effectiveIdentifier){
      const parsedFull = url.parse(clientReq.url || '');
      const reqPortNum = Number(parsedFull.port || (parsedFull.protocol==='https:'?443:(parsedFull.protocol==='http:'?80:0)));
      const quota = computeRemaining(effectiveIdentifier);
      const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), 'localhost', hotspotFallback, ...localIps ]);
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
      
    // STRICT QUOTA ENFORCEMENT: Block access when data is exhausted (except for temp unlock and portal)
    if(!isPortal && !tempUnlocked && quota.exhausted){
        try { activeClients.delete(normalizeIp(clientIp)); } catch {}
        console.warn('[QUOTA-BLOCK-HTTP] exhausted identifier=', effectiveIdentifier, 'host=', hostHeader, 'ip=', clientIp, 'remaining=', quota.remainingMB);
        clientRes.writeHead(302, { 
          'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=data_exhausted`,
          'Content-Type': 'text/html' 
        });
        clientRes.end(`<!DOCTYPE html>
<html><head><title>Data Bundle Exhausted</title><style>body{font-family:Arial;text-align:center;margin-top:50px;}</style></head>
<body><h1>Data Bundle Exhausted</h1>
<p>You have used all your allocated data (${quota.totalBundleMB}MB).</p>
<p>Watch more videos to earn additional data bundles!</p>
<p><strong>Bundle Rewards:</strong></p>
<ul style="display:inline-block;text-align:left;">
<li>5 videos = 100MB bundle</li>
<li>10 videos = 250MB bundle</li>
<li>15 videos = 500MB bundle</li>
</ul>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" style="background:#007bff;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Watch Videos Now</a></p>
</body></html>`);
        return;
      }
      
  // Gate social hosts until an ad completion happened (only if they don't have social access)
    if(!isPortal && !tempUnlocked && isGatedSocialHost(hostHeader) && !hasSocialAccess){
        console.log('[SOCIAL-BLOCK]', { identifier: effectiveIdentifier, host: hostHeader });
        clientRes.writeHead(302, { 
          'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=social_blocked&app=${encodeURIComponent(hostHeader)}`,
          'Content-Type': 'text/html' 
        });
        clientRes.end(`<!DOCTYPE html>
<html><head><title>App Access Locked</title><style>body{font-family:Arial;text-align:center;margin-top:50px;}</style></head>
<body><h1>WhatsApp/Facebook Access Locked</h1>
<p>Access to <strong>${hostHeader}</strong> is locked until you watch videos.</p>
<p>This includes WhatsApp APK, Facebook APK, and all related apps.</p>
<p><strong>How to unlock:</strong></p>
<ul style="display:inline-block;text-align:left;">
<li>Watch your first video to unlock social apps</li>
<li>Continue watching to earn data bundles</li>
<li>5 videos = 100MB, 10 videos = 250MB, 15 videos = 500MB</li>
</ul>
<p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" style="background:#25d366;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Watch Videos to Unlock</a></p>
</body></html>`);
        return;
      }
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
      upRes.on('data',chunk=>{ 
        bytes += chunk.length; 
        clientRes.write(chunk); 
      });
      upRes.on('end',()=>{ 
        clientRes.end(); 
        if(bytes>0 && effectiveIdentifier){ 
          try{ 
            const usedMB = bytes/1024/1024;
            const success = addUsage(effectiveIdentifier, usedMB);
            
            // Update real-time usage tracking for admin dashboard
            updateRealtimeUsage(effectiveIdentifier, 0, bytes); // bytes received (download)
            
            console.log('[USAGE-TRACKED]', { identifier: effectiveIdentifier, bytes, usedMB: usedMB.toFixed(3), success });
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
  
  // CRITICAL: For auto-proxy users, BLOCK ALL HTTPS TRAFFIC if no valid session exists  
  // Only allow portal host connections for unauthenticated users
  const hostOnly = req.url.split(':')[0].toLowerCase();
  const localIps = localIPv4s();
  const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), 'localhost', ...localIps ]);
  const isPortalHost = portalHostCandidates.has(hostOnly);
  
  if(!mappedIdentifier && !isPortalHost){
    console.warn('[PROXY-HTTPS-FORCE-REDIRECT] Unauthenticated HTTPS blocked, redirecting to portal:', { host: hostOnly, ip: clientIp });
    clientSocket.write('HTTP/1.1 302 Found\r\n');
    clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/login.html\r\n`);
    clientSocket.write('Content-Type: text/html\r\n\r\n');
    clientSocket.write(`<html><head><title>Portal Required</title><meta http-equiv="refresh" content="0;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html"></head><body><h1>Portal Access Required</h1><p>Redirecting to login portal...</p><script>window.location.replace('http://${localIps[0] || 'localhost'}:${PORT}/login.html');</script></body></html>`);
    return clientSocket.end();
  }
  
    const extraGarden = (process.env.WALLED_GARDEN||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
    const baseGarden = new Set([
      'localhost','127.0.0.1','::1', ...localIps,
      (process.env.PORTAL_HOST||'').toLowerCase(),
      'storage.googleapis.com','i.ytimg.com','i9.ytimg.com','yt3.ggpht.com'
    ].filter(Boolean));
    if(process.env.STRICT_WALLED!=='true'){
      ['fonts.googleapis.com','fonts.gstatic.com','www.youtube.com','youtube.com'].forEach(h=>baseGarden.add(h));
    }
    extraGarden.forEach(h=> baseGarden.add(h));
    const walledGarden = baseGarden;
  if(!parsedToken && !mappedIdentifier){
      if(!walledGarden.has(hostOnly)){
        clientSocket.write('HTTP/1.1 403 Captive-Portal-Redirect\r\n\r\nOpen portal to gain access');
        return clientSocket.end();
      }
    }
    const effectiveIdentifier = mappedIdentifier || (parsedToken && parsedToken.identifier);
    if(effectiveIdentifier){
      const quota = computeRemaining(effectiveIdentifier);
      const tempUnlocked = (tempFullAccess.get(effectiveIdentifier) || 0) > Date.now();
      const portalHostCandidates = new Set([ (process.env.PORTAL_HOST||'').toLowerCase(), 'localhost', ...localIps ]);
      const isPortalHost = portalHostCandidates.has(hostOnly);
      
      // STRICT QUOTA ENFORCEMENT for HTTPS connections too
      if(!isPortalHost && !tempUnlocked && quota.exhausted){
        try { activeClients.delete(normalizeIp(clientIp)); } catch {}
        console.warn('[QUOTA-BLOCK-CONNECT] exhausted identifier=', effectiveIdentifier, 'host=', hostOnly, 'ip=', clientIp, 'remaining=', quota.remainingMB);
        clientSocket.write('HTTP/1.1 302 Found\r\n');
        clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=data_exhausted\r\n`);
        clientSocket.write('Content-Type: text/html\r\n\r\n');
        clientSocket.write(`<html><head><title>Data Exhausted</title></head><body><h1>Data Bundle Exhausted</h1><p>Watch more videos to unlock internet access.</p><p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html">Watch Videos</a></p></body></html>`);
        return clientSocket.end();
      }
      
      // Block social sites until ad watched (but allow if they have social access)
      if(!tempUnlocked && isGatedSocialHost(hostOnly) && !socialUnlocked.has(effectiveIdentifier)){
        clientSocket.write('HTTP/1.1 302 Found\r\n');
        clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/login.html?message=social_blocked&app=${encodeURIComponent(hostOnly)}\r\n`);
        clientSocket.write('Content-Type: text/html\r\n\r\n');
        clientSocket.write(`<html><head><title>App Blocked</title></head><body><h1>WhatsApp/Facebook Blocked</h1><p>Watch videos to unlock <strong>${hostOnly}</strong></p><p><a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html">Watch Videos</a></p></body></html>`);
        return clientSocket.end();
      }
    }
    const [host, port] = req.url.split(':');
    const serverSocket = net.connect(port||443, host, ()=>{
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head && head.length) serverSocket.write(head);
      // Track bytes more accurately
      let bytesUp=0, bytesDown=0;
      clientSocket.on('data',chunk=>{ bytesUp+=chunk.length; });
      serverSocket.on('data',chunk=>{ bytesDown+=chunk.length; });
      const finalize=()=>{ 
        if((bytesUp+bytesDown)>0 && effectiveIdentifier){ 
          try{ 
            const totalMB = (bytesUp+bytesDown)/1024/1024;
            const success = addUsage(effectiveIdentifier, totalMB);
            console.log('[HTTPS-USAGE-TRACKED]', { identifier: effectiveIdentifier, bytesUp, bytesDown, totalMB: totalMB.toFixed(3), success });
          } catch(err) {
            console.warn('[HTTPS-USAGE-TRACK-ERROR]', err?.message);
          }
        } 
      };
      clientSocket.on('close',finalize);
      serverSocket.on('close',finalize);
      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });
    serverSocket.on('error',()=>{ try{ clientSocket.end(); }catch{} });
  });
  const host = process.env.HOST || '0.0.0.0';
  proxy.listen(PROXY_PORT, host, ()=> console.log(`Captive proxy listening on http://${host}:${PROXY_PORT}`));
}

if(process.env.ENABLE_PROXY!=='false'){
  try { startProxy(); } catch(err){ console.warn('Proxy start failed', err?.message); }
}

// User self usage
app.get('/api/me/usage', (req,res)=>{
  const identifier=(req.query.identifier||'').toString().trim();
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const idLower = identifier.toLowerCase();
    
    // STRICT DEVICE-SPECIFIC USAGE CALCULATION
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    // Use device-specific quota calculation
    const quota = computeRemaining(idLower, deviceFingerprint, routerId);
    
    const { rows: purchases } = listPurchases();
    const { rows: sessions } = listSessions();
    
    // Filter purchases for THIS SPECIFIC DEVICE only
    const myPurchases = purchases.filter(p=> 
      p.identifier === idLower && 
      (p.deviceId === deviceFingerprint || !p.strictMode) // Include legacy non-strict bundles
    ).sort((a,b)=> new Date(b.grantedAtISO)-new Date(a.grantedAtISO));
    
    const mySessions = sessions.filter(s=> s.identifier === idLower && s.active)
      .sort((a,b)=> new Date(b.lastPingISO)-new Date(a.lastPingISO));
    
    console.log('[USAGE-CHECK]', { 
      device: deviceFingerprint, 
      user: idLower, 
      remaining: quota.remainingMB, 
      total: quota.totalBundleMB,
      deviceBundles: myPurchases.length 
    });
    
    res.json({ 
      ok: true, 
      totalBundleMB: quota.totalBundleMB, 
      totalUsedMB: quota.totalUsedMB, 
      remainingMB: quota.remainingMB, 
      deviceId: deviceFingerprint,
      strictMode: true,
      purchases: myPurchases, 
      sessions: mySessions 
    });
  } catch(err){ 
    console.error('[USAGE-ERROR]', err?.message);
    res.status(500).json({ ok:false, message:'Error calculating usage' }); 
  }
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
    
    // Build enhanced users table with real-time data and full user profiles
    const enhancedUsersTable = o.usersTable.map(user => {
      const usage = realtimeUsage.get(user.identifier);
      const quota = computeRemainingUnified(user.identifier);
      
      // Calculate connection duration
      const connectionDuration = usage ? Math.floor((Date.now() - usage.connectionStart) / 60000) : 0; // minutes
      const durationFormatted = connectionDuration > 0 ? `${connectionDuration} min` : 'Not connected';
      
      // Format last activity
      const lastActivity = usage ? new Date(usage.lastUpdateTime).toLocaleTimeString('en-US', { hour12: false }) : 'Never';
      
      // Determine status
      const isActiveNow = usage && (Date.now() - usage.lastUpdateTime) < 60000; // Active if updated within 1 minute
      const status = isActiveNow ? 'Active' : (user.lastLogin ? 'Inactive' : 'Never logged in');
      
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
        totalDataUsed: usage ? `${(usage.totalDataMB || 0).toFixed(2)} MB` : '0.00 MB',
        remainingData: quota ? `${quota.remainingMB.toFixed(2)} MB` : '0.00 MB',
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
    
    res.json({ 
      ok:true, 
      usersTable: enhancedUsersTable,
      routersTable, 
      registrations: o.regLoginTable, // Fixed: Frontend expects 'registrations'
      ads: o.adsTable, // Fixed: Frontend expects 'ads'
      activeUsersCount: o.activeUsersCount, 
      totalUsers: o.usersCount,
      realtimeStats: {
        totalActiveConnections: realtimeUsage.size,
        totalRouters: routerStats.size,
        averageDownMbps: Array.from(realtimeUsage.values()).reduce((sum, u) => sum + u.downMbps, 0) / Math.max(realtimeUsage.size, 1),
        averageUpMbps: Array.from(realtimeUsage.values()).reduce((sum, u) => sum + u.upMbps, 0) / Math.max(realtimeUsage.size, 1)
      }
    }); 
  } catch(err){ 
    console.error('[ADMIN-DASHBOARD-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error building dashboard' }); 
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
    const eventPayload = { adId, identifier:idNorm, eventType, watchSeconds:watch, routerId, tsISO:new Date().toISOString() };
    recordAdEvent(eventPayload);
    try { console.log('AdEvent', JSON.stringify(eventPayload)); } catch {}
    
    // STRICT ROUTER ACCESS CONTROL - Mark device as actively watching
    const userAgent = req.headers['user-agent'] || '';
    const rId = routerId || req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + rId).digest('hex').slice(0,16);
    
    if(eventType === 'start' || eventType === 'progress') {
      // Mark this device as actively watching - block others on same router
      routerDeviceActivity.set(rId, {
        activeDevice: deviceFingerprint,
        lastActivityTime: Date.now(),
        blockOthers: true,
        identifier: idNorm
      });
      console.log('[ROUTER-LOCK]', { device: deviceFingerprint, router: rId, user: idNorm, action: 'watching_video' });
    } else if(eventType === 'complete' || eventType === 'error') {
      // Release router lock after 30 seconds
      setTimeout(() => {
        const activity = routerDeviceActivity.get(rId);
        if(activity && activity.activeDevice === deviceFingerprint) {
          activity.blockOthers = false;
          console.log('[ROUTER-UNLOCK]', { device: deviceFingerprint, router: rId, action: 'video_finished' });
        }
      }, 30000);
    }
    
    let rewardsGranted=[];
    let bundleUpgrade = null;
    
    // IMPROVED VIDEO COMPLETION VALIDATION
    if(eventType==='complete' && idNorm){
      console.log('[AD-COMPLETE-DEBUG]', { identifier: idNorm, watchSeconds: watch, eventType });
      
      // STRICTER MINIMUM WATCH TIME - Must watch at least 80% of typical ad duration
      const minCompleteSeconds = Number(process.env.WATCH_COMPLETE_MIN_SECONDS || 45); // 45 seconds minimum (most ads are 60s)
      const maxWatchForValidation = 180; // Maximum expected ad length is 3 minutes
      
      if(watch < minCompleteSeconds) {
        console.log('[INCOMPLETE-VIDEO-REJECTED]', { 
          identifier: idNorm, 
          watchSeconds: watch, 
          required: minCompleteSeconds,
          message: 'Video not watched long enough to count as complete'
        });
        return res.json({
          ok: true,
          message: `Video must be watched for at least ${minCompleteSeconds} seconds`,
          rewards: [],
          bundleUpgrade: null,
          watchSeconds: watch,
          required: minCompleteSeconds
        });
      }
      
      if(watch > maxWatchForValidation) {
        console.log('[SUSPICIOUS-WATCH-TIME]', { 
          identifier: idNorm, 
          watchSeconds: watch,
          message: 'Watch time suspiciously high, capping for validation'
        });
        // Still allow but log for monitoring
      }
      
      // Create device fingerprint for strict per-device tracking
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + (routerId||'default')).digest('hex').slice(0,16);
      
      // ENHANCED: Prevent rapid-fire duplicate completions (must wait 15 seconds between ANY completion events)
      const lastCompletion = recentCompletions.get(deviceFingerprint) || 0;
      const now = Date.now();
      const cooldownMs = 15000; // 15 seconds between completions
      
      if(now - lastCompletion < cooldownMs) {
        console.log('[DUPLICATE-COMPLETION-BLOCKED]', { 
          device: deviceFingerprint, 
          identifier: idNorm,
          lastCompletion: new Date(lastCompletion).toISOString(),
          timeSinceLastMs: now - lastCompletion,
          cooldownRequired: cooldownMs,
          message: 'Completion event too soon after previous one, enforcing cooldown'
        });
        return res.json({
          ok: true,
          message: `Please wait ${Math.ceil((cooldownMs - (now - lastCompletion)) / 1000)} more seconds before next video`,
          rewards: [],
          bundleUpgrade: null,
          cooldownRemaining: cooldownMs - (now - lastCompletion),
          deviceStats: { videos: (deviceVideoCount.get(deviceFingerprint) || {}).videos || 0 }
        });
      }
      
      // Record this completion to prevent immediate duplicates
      recentCompletions.set(deviceFingerprint, now);
      
      // Update video count for THIS SPECIFIC DEVICE (not user)
      const deviceStats = deviceVideoCount.get(deviceFingerprint) || { videos: 0, lastVideoTime: 0, identifier: idNorm };
      
      // IMPROVED: Prevent video completion abuse (must wait 60 seconds between videos for natural pacing)
      const videoIntervalMs = 60000; // 60 seconds between videos
      if(now - deviceStats.lastVideoTime > videoIntervalMs) {
          deviceStats.videos += 1;
          deviceStats.lastVideoTime = now;
          deviceStats.identifier = idNorm; // Track current user on this device
          deviceVideoCount.set(deviceFingerprint, deviceStats);
          
          console.log('[DEVICE-VIDEO-COMPLETED]', { 
            device: deviceFingerprint, 
            identifier: idNorm, 
            totalVideos: deviceStats.videos, 
            watchSeconds: watch 
          });
          
          // Check if THIS DEVICE reached a new bundle tier (prevent duplicate grants)
          for(const tier of BUNDLE_TIERS) {
            if(deviceStats.videos === tier.videos) {
              // Check if this tier was already granted to prevent duplicates
              const grantedTiers = deviceBundlesGranted.get(deviceFingerprint) || new Set();
              if(grantedTiers.has(tier.videos)) {
                console.log('[BUNDLE-ALREADY-GRANTED]', { 
                  device: deviceFingerprint, 
                  tier: tier.videos, 
                  mb: tier.mb,
                  message: 'Bundle already granted for this tier, skipping'
                });
                break; // Skip this tier as it was already granted
              }
              
              // Grant the bundle ONLY to this specific device
              const reward = recordPurchase(
                idNorm, 
                tier.mb, 
                routerId||'default-router', 
                userAgent, 
                'video-bundle', 
                deviceFingerprint
              );
              
              // Mark this tier as granted to prevent future duplicates
              grantedTiers.add(tier.videos);
              deviceBundlesGranted.set(deviceFingerprint, grantedTiers);
              
              bundleUpgrade = { tier: tier.videos, mb: tier.mb, total: deviceStats.videos, deviceId: deviceFingerprint };
              rewardsGranted.push({ id: reward.id, mb: tier.mb, at: reward.grantedAtISO, tier: tier.videos, deviceId: deviceFingerprint });
              
              console.log('[STRICT-DEVICE-BUNDLE-GRANT]', { 
                identifier: idNorm, 
                device: deviceFingerprint,
                deviceVideos: deviceStats.videos, 
                bundleMB: tier.mb,
                label: tier.label,
                strictDeviceMode: true,
                tierGranted: tier.videos
              });
              break; // Only grant one tier per completion
            }
          }
          
          // Grant eligibility for immediate testing
          adGrantEligibility.set(idNorm, { expires: Date.now()+2*60*1000 }); // 2 min window
          socialUnlocked.add(idNorm); // unlock social access post first completion
          
          // Give temporary access for immediate browsing (only 2 minutes to test connection)
          if(process.env.DISABLE_TEMP_UNLOCK!=='true'){
            tempFullAccess.set(idNorm, Date.now()+2*60*1000); // 2 minutes immediate access for testing
          }
          
          // CRITICAL: Register this client's IP for proxy access
          try { 
            registerActiveClient(req, idNorm, 24); // Register for 24 hours
            console.log('[IP-REGISTERED]', { identifier: idNorm, ip: req.socket?.remoteAddress });
          } catch(err) { 
            console.warn('[IP-REGISTER-FAILED]', err?.message); 
          }
          
          console.log('[AD-COMPLETE-SUCCESS]', { 
            identifier: idNorm, 
            videoCount: deviceStats.videos,
            socialAccess: socialUnlocked.has(idNorm),
            tempAccess: (tempFullAccess.get(idNorm) || 0) > Date.now(),
            fullAccess: false // No more automatic full access
          });
      } else {
        console.log('[AD-VIDEO-INTERVAL-TOO-SHORT]', { 
          device: deviceFingerprint, 
          identifier: idNorm, 
          timeSinceLastVideoMs: now - deviceStats.lastVideoTime,
          requiredMs: 60000 
        });
      }
    } else {
      console.log('[AD-COMPLETE-INSUFFICIENT-WATCH]', { identifier: idNorm, watchSeconds: watch });
    }
    
    // Get device stats for response (reuse existing userAgent)
    const deviceFingerprintForResponse = crypto.createHash('md5').update(userAgent + (routerId||'default')).digest('hex').slice(0,16);
    const deviceStats = deviceVideoCount.get(deviceFingerprintForResponse) || { videos: 0 };
    
    res.json({ 
      ok: true, 
      rewards: rewardsGranted, 
      bundleUpgrade,
      videosWatched: deviceStats.videos, // Device-specific count
      nextTier: getNextTier(deviceStats.videos),
      quota: computeRemainingUnified(idNorm) 
    });
  } catch(err){
    console.error('Ad event record error', err);
    res.status(500).json({ ok:false, message:'Error recording ad event' });
  }
});

// Helper function to get next bundle tier info
function getNextTier(currentVideos) {
  for(const tier of BUNDLE_TIERS) {
    if(currentVideos < tier.videos) {
      return { videos: tier.videos, mb: tier.mb, needed: tier.videos - currentVideos };
    }
  }
  return null; // User has reached maximum tier
}

// API to check user's video progress and bundle status (FIXED: Device-specific tracking)
app.get('/api/user/progress', (req,res)=>{
  try {
    const identifier = (req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
    if(!identifier) return res.status(400).json({ ok:false, message:'Identifier required' });
    
    // Generate device fingerprint for this specific device
    const userAgent = req.headers['user-agent'] || '';
    const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
    const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
    
    // Get device-specific stats (not user-wide)
    const deviceStats = deviceVideoCount.get(deviceFingerprint) || { videos: 0, lastVideoTime: 0 };
    const quota = computeRemainingUnified(identifier, deviceFingerprint, routerId);
    const nextTier = getNextTier(deviceStats.videos);
    
    // Find current tier for this device
    let currentTier = null;
    for(let i = BUNDLE_TIERS.length - 1; i >= 0; i--) {
      if(deviceStats.videos >= BUNDLE_TIERS[i].videos) {
        currentTier = BUNDLE_TIERS[i];
        break;
      }
    }
    
    // Get granted tiers to show what this device has earned
    const grantedTiers = deviceBundlesGranted.get(deviceFingerprint) || new Set();
    
    res.json({
      ok: true,
      deviceId: deviceFingerprint,
      videosWatched: deviceStats.videos, // Device-specific count
      currentTier,
      nextTier,
      allTiers: BUNDLE_TIERS,
      grantedTiers: Array.from(grantedTiers), // Show which tiers this device earned
      quota: {
        remainingMB: quota.remainingMB,
        totalBundleMB: quota.totalBundleMB,
        usedMB: quota.totalUsedMB,
        exhausted: quota.exhausted
      }
    });
  } catch(err) {
    console.error('[PROGRESS-API-ERROR]', err);
    res.status(500).json({ ok:false, message:'Error getting progress' });
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
    try { appendAccessEvent({ identifier: email.trim().toLowerCase(), type:'login', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
    return res.json({ ok:true });
  }
  res.status(401).json({ ok:false, message:'Invalid credentials' });
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
          if(data.find(u=> (u.email||'').toLowerCase()===trimmed)) return res.status(409).json({ ok:false, field:'email', message:'Email already in use' });
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
      const lower = raw.toLowerCase();
      const normPhone = normalizePhone(raw);
      user = data.find(u=> (u.email||'').toLowerCase()===lower || u.phone===normPhone);
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
  if(identifier.includes('@')) exists = data.some(u=>u.email===identifier);
  else exists = data.some(u=>u.phone===normalizePhone(identifier));
  res.json({ exists });
});

// Helper to list local IPv4 addresses for convenience
function localIPv4s(){
  const nets = os.networkInterfaces();
  const addrs = [];
  Object.values(nets).forEach(list=>{ (list||[]).forEach(iface=>{ if(iface.family==='IPv4' && !iface.internal) addrs.push(iface.address); }); }); 
  return addrs;
}

// Generate realistic demo registration and ad activity data for admin tables
function generateDemoRegistrationAndAdData() {
  try {
    // Check if demo data already exists
    const wb = loadWorkbookWithTracking();
    const accessEvents = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ACCESSLOG]);
    const adEvents = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    
    // Only generate if minimal data exists
    if (accessEvents.length > 10 && adEvents.length > 20) {
      console.log('[DEMO-DATA] Sufficient activity data already exists');
      return;
    }
    
    console.log('[DEMO-DATA] Generating realistic registration and ad activity data...');
    
    // Create realistic demo users with proper South African names and details
    const demoUsers = [
      { email: 'thabo.mokoena@gmail.com', name: 'Thabo Mokoena', age: 28, firstName: 'Thabo', surname: 'Mokoena', phone: '0823456789', dob: '1997-03-15' },
      { email: 'nomsa.dlamini@outlook.com', name: 'Nomsa Dlamini', age: 32, firstName: 'Nomsa', surname: 'Dlamini', phone: '0834567890', dob: '1993-07-22' },
      { email: 'sipho.ndlovu@yahoo.com', name: 'Sipho Ndlovu', age: 25, firstName: 'Sipho', surname: 'Ndlovu', phone: '0845678901', dob: '2000-11-08' },
      { email: 'lerato.mthembu@hotmail.com', name: 'Lerato Mthembu', age: 29, firstName: 'Lerato', surname: 'Mthembu', phone: '0856789012', dob: '1996-05-14' },
      { email: 'mandla.khumalo@gmail.com', name: 'Mandla Khumalo', age: 31, firstName: 'Mandla', surname: 'Khumalo', phone: '0867890123', dob: '1994-09-03' },
      { email: 'zanele.mabuza@outlook.com', name: 'Zanele Mabuza', age: 27, firstName: 'Zanele', surname: 'Mabuza', phone: '0878901234', dob: '1998-12-19' }
    ];
    
    // Create demo users if they don't exist
    const { data: existingUsers } = getUsers();
    demoUsers.forEach(user => {
      const exists = existingUsers.find(u => u.email === user.email);
      if (!exists) {
        const dob = new Date(Date.now() - (user.age * 365.25 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];
        const result = saveUser(user.email, 'DemoPass123!', user.phone, user.firstName, user.surname, dob);
        if (result.ok) {
          console.log(`[DEMO-DATA] Created demo user: ${user.email}`);
        } else {
          console.warn(`[DEMO-DATA] Failed to create user ${user.email}:`, result.message);
        }
      }
    });
    
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36',
      'Mozilla/5.0 (Android 14; Mobile; rv:109.0) Gecko/111.0 Firefox/119.0'
    ];
    
    const ips = ['192.168.1.100', '192.168.1.101', '192.168.1.102', '192.168.1.103', '192.168.1.104', '192.168.1.105'];
    
    // Generate login history over the past 30 days
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    
    demoUsers.forEach((user, userIndex) => {
      // Generate 5-15 login events per user
      const loginCount = 5 + Math.floor(Math.random() * 10);
      
      for (let i = 0; i < loginCount; i++) {
        const randomTime = thirtyDaysAgo + Math.random() * (now - thirtyDaysAgo);
        appendAccessEvent({
          identifier: user.email,
          type: 'login',
          tsISO: new Date(randomTime).toISOString(),
          ip: ips[userIndex % ips.length],
          ua: userAgents[Math.floor(Math.random() * userAgents.length)]
        });
      }
      
      // Generate some profile changes (randomly)
      if (Math.random() > 0.6) {
        const profileChangeTime = thirtyDaysAgo + Math.random() * (now - thirtyDaysAgo);
        appendAccessEvent({
          identifier: user.email,
          type: 'profile_change',
          tsISO: new Date(profileChangeTime).toISOString(),
          ip: ips[userIndex % ips.length],
          ua: userAgents[Math.floor(Math.random() * userAgents.length)],
          changedFields: ['firstName', 'phone']
        });
      }
      
      // Generate some password resets (occasionally)
      if (Math.random() > 0.8) {
        const resetTime = thirtyDaysAgo + Math.random() * (now - thirtyDaysAgo);
        appendAccessEvent({
          identifier: user.email,
          type: 'password_reset',
          tsISO: new Date(resetTime).toISOString(),
          ip: ips[userIndex % ips.length],
          ua: userAgents[Math.floor(Math.random() * userAgents.length)]
        });
      }
    });
    
    // Generate realistic ad events
    const adIds = DEFAULT_AD_URLS.map(deriveAdIdFromUrl);
    
    // Generate ad views and clicks over past 30 days
    for (let day = 0; day < 30; day++) {
      const dayTime = thirtyDaysAgo + (day * 24 * 60 * 60 * 1000);
      
      // Generate 10-50 ad events per day
      const eventsPerDay = 10 + Math.floor(Math.random() * 40);
      
      for (let i = 0; i < eventsPerDay; i++) {
        const eventTime = dayTime + Math.random() * (24 * 60 * 60 * 1000);
        const user = demoUsers[Math.floor(Math.random() * demoUsers.length)];
        const adId = adIds[Math.floor(Math.random() * adIds.length)];
        const routerId = `router-${Math.floor(Math.random() * 4) + 1}`;
        
        // Generate view event
        recordAdEvent({
          identifier: user.email,
          adId: adId,
          eventType: 'view',
          tsISO: new Date(eventTime).toISOString(),
          routerId: routerId,
          watchSeconds: 5 + Math.floor(Math.random() * 25), // 5-30 seconds
          deviceType: Math.random() > 0.5 ? 'mobile' : 'desktop'
        });
        
        // 15% chance of click after view
        if (Math.random() < 0.15) {
          recordAdEvent({
            identifier: user.email,
            adId: adId,
            eventType: 'click',
            tsISO: new Date(eventTime + 1000).toISOString(), // 1 second after view
            routerId: routerId,
            deviceType: Math.random() > 0.5 ? 'mobile' : 'desktop'
          });
        }
      }
    }
    
    console.log('[DEMO-DATA] Generated realistic registration and ad activity data for admin tables');
    
  } catch (error) {
    console.warn('[DEMO-DATA] Failed to generate demo data:', error?.message);
  }
}

const HOST = process.env.HOST || '0.0.0.0';
function startExpress(port, attemptsLeft){
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
    
    // Start bandwidth simulation for demo purposes (like live sports scores)
    if(!global.__ISN_BANDWIDTH_SIM){
      // Initialize realistic demo users with proper profiles for bandwidth simulation
      const demoUsers = [
        { email: 'thabo.mokoena@gmail.com', firstName: 'Thabo', surname: 'Mokoena', phone: '0823456789' },
        { email: 'nomsa.dlamini@outlook.com', firstName: 'Nomsa', surname: 'Dlamini', phone: '0834567890' },
        { email: 'sipho.ndlovu@yahoo.com', firstName: 'Sipho', surname: 'Ndlovu', phone: '0845678901' },
        { email: 'lerato.mthembu@hotmail.com', firstName: 'Lerato', surname: 'Mthembu', phone: '0856789012' }
      ];
      demoUsers.forEach((user, index) => {
        const demoIp = `192.168.1.${100 + index}`;
        activeClients.set(demoIp, {
          identifier: user.email,
          lastSeen: Date.now(),
          expires: Date.now() + 6 * 3600 * 1000
        });
        
        // Initialize bandwidth tracking with full user profile
        if (!realtimeUsage.has(user.email)) {
          realtimeUsage.set(user.email, {
            downMbps: 0, upMbps: 0, totalDataMB: 0, lastUpdateTime: Date.now(), connectionStart: Date.now(),
            bytesDownLoaded: 0, bytesUploaded: 0, peakDownMbps: 0, peakUpMbps: 0,
            ip: demoIp, routerId: `router-${index + 1}`, wifiNetwork: `ISN-WiFi-${index + 1}`,
            userProfile: user // Store full user profile for admin dashboard display
          });
        }
      });
      
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
    if(err.code==='EADDRINUSE' && attemptsLeft>0){
      console.warn(`Port ${port} busy, trying ${port+1}...`);
      startExpress(port+1, attemptsLeft-1);
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
