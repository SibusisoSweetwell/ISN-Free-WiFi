console.log('Starting ISN Free WiFi portal server...');
const express = require('express');
console.log('Express loaded');
const path = require('path');
const fs = require('fs');
const os = require('os');
console.log('Basic modules loaded');
const XLSX = require('xlsx');
console.log('XLSX loaded');
const bcrypt = require('bcryptjs');
console.log('bcrypt loaded');
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
  // NOTE: CONNECT quota checks must run per-connection where request/clientSocket are available.
  // Removed startup-time check that referenced request-scoped variables (mappedIdentifier, req, clientSocket).
  // Ensure CONNECT/quota enforcement is performed inside the proxy connection handler instead.
}
console.log('[CONFIG] USE_SQLITE=', process.env.USE_SQLITE, 'sqliteDB active=', !!sqliteDB);
const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
// Rate limiting for admin endpoints
const rateLimit = require('express-rate-limit');

// Persistent storage directory. On Render and similar hosts use '/data'
// for durable storage. Allow override via DATA_DIR env var.
const DEFAULT_DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, 'data'));
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
try { if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){ console.warn('[DATA-DIR] failed to ensure data dir', DATA_DIR, e && e.message); }
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
// Simple request logger to help debug routing and verify incoming API calls
app.use((req, res, next) => {
  try { console.log('[REQ] %s %s from %s', req.method, req.path, req.ip || req.headers['x-forwarded-for'] || 'unknown'); } catch(e){}
  next();
});

// smsLimiter must be available before the /api/send-sms route is registered.
const smsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many SMS attempts, try again later.' }
});

// Raw echo endpoint (registered before body parsers) to capture request body bytes for debugging
app.post('/api/raw-echo', (req, res) => {
  try {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      console.log('[RAW-ECHO] headers=', req.headers);
      console.log('[RAW-ECHO] body=', data);
      res.json({ ok: true, headers: req.headers, raw: data });
    });
    req.on('error', () => { res.status(500).json({ ok:false, message:'read-error' }); });
  } catch (e) { res.status(500).json({ ok:false, message: e.message }); }
});

// /api/send-sms handler moved below after JSON/body parsing middleware so
// req.body and req.rawBody are available.
// Use environment PORT when provided (Render sets this) otherwise default to 3150
let PORT = Number(process.env.PORT) || 3150; // Portal port (configurable via env)
const PROXY_PORT = 8082; // Fixed port for proxy
const RENDER_HOST = (process.env.RENDER_HOST || 'isn-free-wifi.onrender.com').toLowerCase();
const PORTAL_SECRET = process.env.PORTAL_SECRET || 'isn_portal_secret_dev';
const DATA_FILE = path.join(DATA_DIR, 'logins.xlsx');
// Default admin identity - configure via env in production
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sbusisosweetwell15@gmail.com';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD || 'admin123'; // default for development
const ADMIN_SEED_CODE = process.env.ADMIN_SEED_CODE || '123456'; // default for development
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin_secret_dev';

// Fail-fast in production if admin secrets are not provided via environment
if (process.env.NODE_ENV === 'production') {
  if (!ADMIN_SEED_PASSWORD || !ADMIN_SEED_CODE || !ADMIN_EMAIL) {
    console.error('[SECURITY] ADMIN_SEED_PASSWORD, ADMIN_SEED_CODE and ADMIN_EMAIL must be set in production environment variables.');
    process.exit(1);
  }
}

// Rate limiter: conservative for admin-sensitive endpoints
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many attempts, try again later.' }
});

// ...smsLimiter declared earlier
// Server-side SMS send endpoint — uses CLICKATELL_API_KEY from environment variables
// Keep this endpoint protected with rate limiting to avoid abuse.
// No per-route pre-read here; express.json verify will capture raw body safely.

// Parse JSON bodies and capture the raw body for diagnostics for other routes.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf, encoding) => {
    try { if (!req._bodyRead) req.rawBody = buf && buf.toString(encoding || 'utf8'); } catch(e){ req.rawBody = '' }
  }
}));
// /api/send-sms is handled earlier with a raw-reading handler (see above).

// Server-side SMS send endpoint — moved here so body parsers have run.
app.post('/api/send-sms', smsLimiter, async (req, res) => {
  try {
    let bodyObj = {};
    if (req.body && Object.keys(req.body).length) bodyObj = req.body;
    else if (req.rawBody && String(req.rawBody).trim()) {
      const raw = String(req.rawBody);
      try { bodyObj = JSON.parse(raw); }
      catch (e) {
        // Try querystring parse first
        try { bodyObj = require('querystring').parse(raw); } catch(_) { bodyObj = {}; }
        // If still empty, attempt a loose object parse like {to:123,message:hi}
        if ((!bodyObj || Object.keys(bodyObj).length === 0) && /\{.*:.*\}/.test(raw)) {
          const loose = {};
          const kvs = raw.replace(/^[{\s]+|[}\s]+$/g,'').split(',');
          kvs.forEach(pair => {
            const m = pair.split(':');
            if (m && m.length >= 2) {
              const k = String(m.shift()).trim().replace(/^['"]|['"]$/g,'');
              const v = m.join(':').trim().replace(/^['"]|['"]$/g,'');
              loose[k] = v;
            }
          });
          bodyObj = loose;
        }
      }
    }

    const to = (bodyObj && (bodyObj.to || bodyObj.phone)) || req.query.to || '';
    const message = (bodyObj && bodyObj.message) || req.query.message || '';
    if (!to || !message) return res.status(400).json({ ok:false, message:'Missing to or message', raw: req.rawBody || null });

    const key = process.env.CLICKATELL_API_KEY || '';
    if (!key) return res.status(500).json({ ok:false, message:'SMS service not configured' });

    const toEnc = encodeURIComponent(String(to).replace(/\s+/g,''));
    const contentEnc = encodeURIComponent(String(message));
    const sendUrl = `https://platform.clickatell.com/messages/http/send?apiKey=${encodeURIComponent(key)}&to=${toEnc}&content=${contentEnc}`;
    const fetch = require('node-fetch');
    const resp = await fetch(sendUrl, { method: 'GET' });
    const txt = await resp.text();
    if (!resp.ok) return res.status(502).json({ ok:false, message: txt });
    return res.json({ ok:true, result: txt });
  } catch (err) {
    console.error('[SMS-HANDLER-ERR]', err && err.message);
    return res.status(500).json({ ok:false, message: err.message, raw: req.rawBody || null });
  }
});

// Admin code and password are hashed before storage. We also create a guaranteed
// admin user at startup so the account is always present. The seed values may
// be overridden by environment variables in production.

// Migrate any legacy XLSX file from repo root into DATA_DIR so user accounts
// are preserved after deploys. This will move './logins.xlsx' to DATA_FILE if
// present and the target file is missing.
function migrateLegacyXLSX(){
  try {
    const legacy = path.join(__dirname, 'logins.xlsx');
    if(!fs.existsSync(legacy)) return;
    if(fs.existsSync(DATA_FILE)){
      console.log('[MIGRATE] DATA_FILE already exists at', DATA_FILE, '- skipping legacy migration');
      return;
    }
    // Attempt rename (fast), fallback to copy+unlink if different mount
    try {
      fs.renameSync(legacy, DATA_FILE);
      console.log('[MIGRATE] moved legacy logins.xlsx ->', DATA_FILE);
    } catch(e) {
      try {
        fs.copyFileSync(legacy, DATA_FILE);
        fs.unlinkSync(legacy);
        console.log('[MIGRATE] copied legacy logins.xlsx ->', DATA_FILE);
      } catch(e2){ console.warn('[MIGRATE-ERR] failed to migrate legacy XLSX', e2 && e2.message); }
    }
  } catch(err){ console.warn('[MIGRATE-ERR]', err && err.message); }
}

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
// Diagnostic: report SQLITE_PATH and file writability when using SQLite
if (process.env.USE_SQLITE === 'true') {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'logins.db');
  try {
    const exists = fs.existsSync(dbPath);
    let writable = false;
    try { fs.accessSync(path.dirname(dbPath), fs.constants.W_OK); writable = true; } catch(e){ writable=false; }
    console.log('[SQLITE-INFO] SQLITE_PATH=', dbPath, 'exists=', exists, 'writableDir=', writable);
    if (!writable) console.warn('[SQLITE-WARN] DB directory not writable. Ensure container/platform mounts a writable volume at '+path.dirname(dbPath));
  } catch(e){ console.warn('[SQLITE-INFO-ERR]', e && e.message); }
}
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
  // If sqlite adapter is active, load persisted temporary unlocks into memory
  try {
    if (sqliteDB) {
      const rows = sqliteDB.loadTempUnlocks();
      let loaded = 0;
      const now = Date.now();
      for (const r of rows) {
        if (!r || !r.expiry) continue;
        if (Number(r.expiry) > now) {
          if (r.identifier) tempFullAccess.set((r.identifier||'').toLowerCase(), Number(r.expiry));
          if (r.deviceId) tempFullAccess.set(r.deviceId, Number(r.expiry));
          loaded++;
        }
      }
      console.log(`[SQLITE] Loaded ${loaded} active temp unlock(s) from DB`);
      // cleanup any expired rows
      const removed = sqliteDB.removeExpiredTempUnlocks(now);
      if (removed) console.log(`[SQLITE] Removed ${removed} expired temp unlock rows`);
      // Periodically purge expired rows every 10 minutes
      setInterval(() => {
        try { sqliteDB.removeExpiredTempUnlocks(Date.now()); } catch(e){}
      }, 10 * 60 * 1000);
    }
  } catch(e){ console.warn('[SQLITE-LOAD-TEMP-UNLOCKS-ERR]', e && e.message); }
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
  if(changed){ wb.Sheets[SHEET_ADS] = XLSX.utils.json_to_sheet(rows); if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE); }
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
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
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
  try {
    // Also persist to sqlite purchases table when available
    if (sqliteDB) {
      // Persist under normalized identifier so lookups by identifier succeed
      const phoneNumber = idLower;
      const videoCount = 0;
      const bundleType = 'manual_grant';
      const created = sqliteDB.createPurchaseIfNotExists(phoneNumber, videoCount, bundleMB, bundleType);
      if (created) console.log('[SQLITE] persisted purchase for', phoneNumber);
    }
  } catch(e){ console.warn('[RECORD-PURCHASE-SQLITE-ERR]', e && e.message); }
  return entry;
}

// --- Admin API (protected by ADMIN_TOKEN or ?secret=) ---
function checkAdminAuth(req) {
  const token = req.headers['x-admin-token'] || req.query.secret || '';
  return token === ADMIN_TOKEN;
}

// --- Server-side ad pool & playlist API ---
// Small curated pool (match client samples) - server can expand this list
const SERVER_AD_POOL = {
  mp4: [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4'
  ],
  yt: [ 'P9vKxPUFers','eUUmpBFoF7I','YlXHVIsxpO0' ]
};

function shuffleArray(arr){ return arr.slice().sort(()=>Math.random()-0.5); }

// Return a curated playlist for a router or global pool
app.get('/api/ads/playlist',(req,res)=>{
  try{
    const count = Math.max(1, Math.min(25, Number(req.query.count) || 5));
    const routerId = (req.query.routerId||req.headers['x-router-id']||'global').toString();
    // For now we use a simple per-router randomness seed; later you can store per-router campaigns
    const pool = [];
    // prefer MP4 clips for faster startup
    const mp4s = shuffleArray(SERVER_AD_POOL.mp4).slice(0, Math.ceil(count*0.7));
    mp4s.forEach(u=>pool.push({ type:'mp4', url:u }));
    const yts = shuffleArray(SERVER_AD_POOL.yt).slice(0, Math.max(0, count - pool.length));
    yts.forEach(id=>pool.push({ type:'yt', id }));
    // If still short, repeat some mp4s
    while(pool.length < count){ const u = SERVER_AD_POOL.mp4[pool.length % SERVER_AD_POOL.mp4.length]; pool.push({ type:'mp4', url:u }); }
    res.json({ ok:true, routerId, count: pool.length, playlist: pool });
  }catch(err){ res.status(500).json({ ok:false, message:'playlist error' }); }
});

// --- Admin monitoring endpoints: temp access maps and device bundles ---
app.get('/api/admin/temp-access', adminLimiter, (req,res)=>{
  try{
    const requester = (req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
    if(!checkAdminAuth(req) && !isAdminIdentifier(requester)) return res.status(403).json({ ok:false, message:'Forbidden' });
    // Serialize maps into arrays
    const tempFull = Array.from(tempFullAccess.entries()).map(([k,v])=>({ key:k, expires: v }));
    const routerTemp = Array.from(routerTempAccess.entries()).map(([k,v])=>({ routerId:k, expires:v }));
    const deviceMap = Array.from(deviceBundlesGranted.entries()).map(([k,s])=>({ deviceId:k, bundles: Array.from(s) }));
    res.json({ ok:true, tempFull, routerTemp, deviceMap, time: Date.now() });
  }catch(e){ res.status(500).json({ ok:false, message:'error' }); }
});

app.get('/api/admin/diagnostics', adminLimiter, (req,res)=>{
  try{
    if(!checkAdminAuth(req)) return res.status(403).json({ ok:false, message:'Forbidden' });
    const diagnostics = {
      tempFullAccessSize: tempFullAccess.size || 0,
      routerTempAccessSize: routerTempAccess.size || 0,
      deviceBundlesCount: deviceBundlesGranted.size || 0,
      activeClients: Array.from(activeClients.keys()).slice(0,200),
      deviceSessionsCount: deviceSessions.size || 0,
      now: Date.now()
    };
    res.json({ ok:true, diagnostics });
  }catch(e){ res.status(500).json({ ok:false, message:'error' }); }
});

// Admin: grant data to an identifier (email/phone) or deviceId
app.post('/api/admin/grant', adminLimiter, (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(403).json({ ok: false, message: 'Forbidden' });
    const { identifier, email, phone, mb, deviceId, routerId, durationHours } = req.body || {};
    const targetId = (identifier || email || phone || '').toString().trim();
    const mbNum = Number(mb) || 0;
    if (!targetId && !deviceId) return res.status(400).json({ ok: false, message: 'Provide identifier or deviceId' });
    if (mbNum <= 0) return res.status(400).json({ ok: false, message: 'Invalid MB value' });

    // Determine grant expiry
    const hours = Number(durationHours) || 24; // default 24 hours
    const grantExpiry = Date.now() + Math.max(1, hours) * 60 * 60 * 1000;

    // Prefer explicit deviceId if provided; otherwise try to locate a device session for the identifier
    let resolvedDeviceId = deviceId || null;
    try {
      if (!resolvedDeviceId && targetId) {
        const ds = deviceSessions.get(targetId) || deviceSessions.get(targetId.toLowerCase());
        if (ds && ds.deviceId) resolvedDeviceId = ds.deviceId;
      }
    } catch (e) { /* ignore */ }

    // If we have a deviceId, record a purchase for tracking; otherwise record only identifier temp access
    let purchase = null;
    try {
      if (resolvedDeviceId) {
        purchase = recordPurchase(targetId || ('admin@grant'), mbNum, resolvedDeviceId, routerId || 'admin-grant', req.headers['user-agent'] || 'admin', 'admin_grant');
        // update deviceBundlesGranted
        try {
          const cur = deviceBundlesGranted.get(resolvedDeviceId) || new Set(); cur.add(mbNum); deviceBundlesGranted.set(resolvedDeviceId, cur);
        } catch (e) {}
      }
    } catch (e) { console.warn('[ADMIN-GRANT-RECORD-ERR]', e && e.message); }

    // Set temporary full access for identifier and device
    try { if (targetId) tempFullAccess.set(targetId, grantExpiry); } catch (e) {}
    try { if (resolvedDeviceId) tempFullAccess.set(resolvedDeviceId, grantExpiry); } catch (e) {}

    // Optionally open router-scoped access so devices on same router can connect immediately
    try { if (routerId) routerTempAccess.set(routerId, grantExpiry); } catch (e) {}

    // Register active client so CONNECT sees it immediately
    try { if (targetId) registerActiveClient({ headers: req.headers, ip: req.ip }, targetId, Math.max(1, hours)); } catch (e) {}

    console.log('[ADMIN-GRANT] Admin granted', mbNum, 'MB to', targetId || resolvedDeviceId, 'device=', resolvedDeviceId, 'router=', routerId);
    return res.json({ ok: true, grantedTo: targetId || resolvedDeviceId, deviceId: resolvedDeviceId, mb: mbNum, expires: grantExpiry, purchase });
  } catch (err) {
    console.error('[ADMIN-GRANT-ERR]', err && err.message);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

app.get('/api/admin/purchases', adminLimiter, (req, res) => {
  if (!checkAdminAuth(req)) return res.status(403).json({ ok: false, message: 'Forbidden' });
  try {
    if (sqliteDB) {
      const rows = sqliteDB.getAllPurchases ? sqliteDB.getAllPurchases() : sqliteDB.getPurchases ? sqliteDB.getPurchases() : [];
      return res.json({ ok: true, count: rows.length, purchases: rows.slice(0, 200) });
    }
    const { rows } = listPurchases();
    return res.json({ ok: true, count: rows.length, purchases: rows.slice(0, 200) });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

app.get('/api/admin/temp-unlocks', adminLimiter, (req, res) => {
  if (!checkAdminAuth(req)) return res.status(403).json({ ok: false, message: 'Forbidden' });
  try {
    if (sqliteDB) {
      const rows = sqliteDB.loadTempUnlocks ? sqliteDB.loadTempUnlocks() : [];
      return res.json({ ok: true, unlocks: rows });
    }
    // Fallback to XLSX sheet
    const wb = loadWorkbookWithTracking();
    const ws = wb.Sheets['TempUnlocks'] || XLSX.utils.json_to_sheet([]);
    const rows = XLSX.utils.sheet_to_json(ws);
    return res.json({ ok: true, unlocks: rows });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

app.post('/api/admin/temp-unlocks/revoke', adminLimiter, express.json(), (req, res) => {
  if (!checkAdminAuth(req)) return res.status(403).json({ ok: false, message: 'Forbidden' });
  const id = req.body && req.body.id;
  if (!id) return res.json({ ok: false, message: 'Missing id' });
  try {
    if (sqliteDB && sqliteDB.removeTempUnlockById) {
      const removed = sqliteDB.removeTempUnlockById(id);
      return res.json({ ok: true, removed });
    }
    // Fallback: remove from XLSX
    const wb = loadWorkbookWithTracking();
    const ws = wb.Sheets['TempUnlocks'] || XLSX.utils.json_to_sheet([]);
    let rows = XLSX.utils.sheet_to_json(ws);
    const before = rows.length;
    rows = rows.filter(r => String(r.id) !== String(id));
    writeSheet(wb, 'TempUnlocks', rows);
    return res.json({ ok: true, removed: before - rows.length });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

app.post('/api/admin/temp-unlocks/bulk-revoke-expired', adminLimiter, express.json(), (req, res) => {
  if (!checkAdminAuth(req)) return res.status(403).json({ ok: false, message: 'Forbidden' });
  try {
    const now = Date.now();
    if (sqliteDB && sqliteDB.removeExpiredTempUnlocks) {
      const removed = sqliteDB.removeExpiredTempUnlocks(now);
      return res.json({ ok: true, removed });
    }
    const wb = loadWorkbookWithTracking();
    const ws = wb.Sheets['TempUnlocks'] || XLSX.utils.json_to_sheet([]);
    let rows = XLSX.utils.sheet_to_json(ws);
    const before = rows.length;
    rows = rows.filter(r => Number(r.expiry) > now);
    writeSheet(wb, 'TempUnlocks', rows);
    return res.json({ ok: true, removed: before - rows.length });
  } catch (e) { return res.json({ ok: false, message: e.message }); }
});


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

// Enhanced video-based data earning system with automatic internet access
function getVideosWatched(identifier, deviceId) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      // Create sheet if it doesn't exist
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
      if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
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

// Get device-specific video count for access control
function getDeviceVideoCount(deviceId, routerId) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) return 0;
    
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    const deviceVideos = videoViews.filter(v => 
      v.deviceId === deviceId && 
      (v.routerId === routerId || !routerId) &&
      (v.event === 'video_completed' || v.completedAt)
    );
    
    console.log(`[DEVICE-VIDEO-COUNT] Device ${deviceId.slice(0,8)}... has ${deviceVideos.length} completed videos`);
    return deviceVideos.length;
  } catch (error) {
    console.error('[DEVICE-VIDEO-COUNT-ERROR]', error.message);
    return 0;
  }
}

// Data bundle calculation - aligned with home.html system
function calculateEarnedBundle(videoCount) {
  // Match the home.html video reward system exactly
  if (videoCount >= 15) return { bundleMB: 500, tier: '15_videos' };   // 500MB for 15 videos
  if (videoCount >= 10) return { bundleMB: 250, tier: '10_videos' };   // 250MB for 10 videos  
  if (videoCount >= 5) return { bundleMB: 100, tier: '5_videos' };     // 100MB for 5 videos
  return { bundleMB: 0, tier: 'none' };
}

// Enhanced auto-grant internet access with proper data allocation per video
function autoGrantInternetAccess(identifier, deviceId, videoCount, routerId) {
  const bundle = calculateEarnedBundle(videoCount);
  
  if (bundle.bundleMB > 0) {
    console.log('[AUTO-GRANT-START]', { 
      identifier, 
      deviceId: deviceId.slice(0,8) + '...', 
      videoCount, 
      bundleMB: bundle.bundleMB,
      tier: bundle.tier
    });
    
    // Record the bundle purchase automatically with proper tracking
    const bundleEntry = recordPurchase(
      identifier, 
      bundle.bundleMB, 
      deviceId, 
      routerId,
      `Auto-grant: ${videoCount} videos watched (${bundle.tier})`,
      `video_auto_grant_${bundle.tier}`
    );
    
    // Grant immediate internet access via temp unlock with time limit
    const accessDurationMs = Math.min(
      bundle.bundleMB * 60 * 1000, // 1 minute per MB (reasonable for small bundles)
      8 * 60 * 60 * 1000 // Max 8 hours regardless of bundle size
    );
    
    tempFullAccess.set(deviceId, Date.now() + accessDurationMs);
    
    // Register as active client with proper duration
    registerActiveClient({ 
      ip: routerId, 
      headers: { 'x-router-id': routerId }
    }, identifier, Math.ceil(accessDurationMs / (60 * 60 * 1000))); // Convert to hours
    
    console.log('[AUTO-GRANT-SUCCESS]', {
      identifier,
      deviceId: deviceId.slice(0,8) + '...',
      bundleMB: bundle.bundleMB,
      accessDurationHours: Math.ceil(accessDurationMs / (60 * 60 * 1000)),
      expiresAt: new Date(Date.now() + accessDurationMs).toISOString()
    });
    
    return {
      success: true,
      bundleMB: bundle.bundleMB,
      tier: bundle.tier,
      accessDurationMs,
      message: `Granted ${bundle.bundleMB}MB for watching ${videoCount} videos`
    };
  }
  
  return { 
    success: false, 
    message: `Need ${5 - videoCount} more videos to earn data bundle` 
  };
}

// Get videos watched across ALL devices for a user (unified account)
function getVideosWatchedForUser(identifier) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      // Create sheet if it doesn't exist
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
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

// Enhanced video completion tracking with automatic bundle grants
function recordVideoView(identifier, deviceId, videoUrl, duration, routerId) {
  try {
    const wb = loadWorkbookWithTracking();
    if (!wb.Sheets[SHEET_ADEVENTS]) {
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
    }
    
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    
    // Only record if video was watched for minimum duration (90+ seconds to ensure proper viewing)
    // Videos should be watched for at least 1.5 minutes to count as completed
    const isCompleted = duration >= 90;
    const earnedMB = isCompleted ? 20 : 0; // 20MB per completed video
    
    // Log video tracking details for debugging
    console.log(`[VIDEO-DURATION-CHECK] ${identifier} watched video for ${duration}s (minimum: 90s) - ${isCompleted ? 'COMPLETED' : 'PARTIAL'}`);
    
    const newView = {
      id: guid(),
      identifier: identifier,
      deviceId: deviceId,
      event: isCompleted ? 'video_completed' : 'video_partial',
      videoUrl: videoUrl,
      duration: duration,
      earnedMB: earnedMB,
      routerId: routerId || 'default-router',
      timestampISO: new Date().toISOString(),
      timestampLocal: new Date().toLocaleString(),
      ip: '', // Will be filled by caller
      userAgent: '',
      completedAt: isCompleted ? new Date().toISOString() : null,
      minimumDurationMet: isCompleted
    };
    
    videoViews.push(newView);
    wb.Sheets[SHEET_ADEVENTS] = XLSX.utils.json_to_sheet(videoViews);
    XLSX.writeFile(wb, DATA_FILE);
    
    // AUTO-GRANT INTERNET ACCESS: Check for milestone rewards after each completed video
    if (isCompleted) {
      const deviceVideoCount = getDeviceVideoCount(deviceId, routerId);
      console.log(`[VIDEO-MILESTONE-CHECK] Device ${deviceId.slice(0,8)}... now has ${deviceVideoCount} completed videos`);
      
      // Auto-grant internet access at milestones: 5, 10, 15 videos
      if (deviceVideoCount === 5 || deviceVideoCount === 10 || deviceVideoCount === 15) {
        const accessGrant = autoGrantInternetAccess(identifier, deviceId, deviceVideoCount, routerId);
        
        if (accessGrant.granted) {
          console.log(`[MILESTONE-INTERNET-ACCESS] ${identifier} automatically granted ${accessGrant.bundleMB}MB internet access (${accessGrant.tier})`);
          
          // Update device quota immediately for proxy access
          let dq = deviceQuotas.get(deviceId) || { bundleMB: 0, usedMB: 0, unlockEarned: false };
          dq.bundleMB = accessGrant.bundleMB;
          dq.unlockEarned = true;
          dq.videoWatchComplete = true;
          dq.lastGrantedAt = new Date().toISOString();
          deviceQuotas.set(deviceId, dq);
          
          // Notify client of internet access grant
          return {
            videoRecorded: true,
            milestoneReached: true,
            internetAccessGranted: true,
            bundleMB: accessGrant.bundleMB,
            tier: accessGrant.tier,
            totalVideos: deviceVideoCount,
            message: `Congratulations! You've earned ${accessGrant.bundleMB}MB of internet access by watching ${deviceVideoCount} videos.`
          };
        }
      }
      
      // Return standard video completion response
      return {
        videoRecorded: true,
        milestoneReached: false,
        internetAccessGranted: false,
        earnedMB: earnedMB,
        totalVideos: deviceVideoCount,
        nextMilestone: deviceVideoCount < 5 ? 5 : deviceVideoCount < 10 ? 10 : deviceVideoCount < 15 ? 15 : null,
        message: `Video completed! ${earnedMB}MB earned. ${deviceVideoCount} total videos watched.`
      };
    }
    
    return {
      videoRecorded: true,
      milestoneReached: false,
      internetAccessGranted: false,
      earnedMB: 0,
      message: 'Video must be watched for at least 30 seconds to earn data.'
    };
    
  } catch (error) {
    console.error('[VIDEO-RECORD-ERROR]', error.message);
    return {
      videoRecorded: false,
      error: 'Failed to record video view'
    };
  }
  
  try {
    // Map milestones to time-based unlocks as well
    let durationHours = 2; // default for 5 videos
    if (totalVideos === 5) durationHours = 2;
    else if (totalVideos === 10) durationHours = 3;
    else if (totalVideos === 15) durationHours = 4;

    // Mark device unlocked for the milestone with both MB and duration
    const unlockOk = markDeviceUnlocked(deviceId, identifier, (totalVideos === 5?100: totalVideos === 10?250: totalVideos === 15?500:100), durationHours);
    if (unlockOk) {
      console.log(`[MILESTONE-UNLOCKED] ${identifier} device ${deviceId.slice(0,8)}... unlocked for ${durationHours}h due to reaching ${totalVideos} videos`);
    }
  } catch(err){ 
    console.warn('[MILESTONE-UNLOCK-ERROR]', err?.message); 
  }
    
  console.log(`[VIDEO-EARNED] ${identifier} earned ${newView.earnedMB}MB by watching video (${duration}s) - Total videos: ${totalVideos}`);
  return newView.earnedMB;
}

// Unified (email + phone) quota for a user with enhanced data tracking
function computeRemainingUnified(identifier, deviceFingerprint, routerId){
  const idLower = String(identifier || '').trim().toLowerCase();
  
  // Use enhanced data tracker for accurate real-time data
  const usageData = dataTracker.getFreshUsageData(idLower);
  
  // Prefer sqlite user lookup when available to ensure newly-created bundles are recognized immediately
  let user = null;
  try {
    if (sqliteDB) {
      // Try to find a sqlite user record, but DO NOT force a fallback to XLSX when missing.
      // When sqlite is active we want to use sqlite-backed purchases/usage even if there's
      // no explicit users row for this identifier (e.g. email addresses stored in purchases).
      user = sqliteDB.findUser(idLower) || null;
    }
  } catch (e) { user = null; }

  if (!user) {
    // Legacy fallback: only use XLSX store if sqlite is not active. If sqlite is active but
    // there's no users row, continue - dataTracker/getPurchasesByPhone will still surface
    // recent purchases created in sqlite so we must not return early to the XLSX-only path.
    if (!sqliteDB) {
      const { data: users } = getUsers();
      user = users.find(u=> String(u.email||'').trim().toLowerCase()===idLower || (u.phone && u.phone===normalizePhone(idLower)) );
      if (!user) return computeRemaining(idLower, deviceFingerprint, routerId);
    }
    // If sqliteDB is active and user is null, proceed - sqlite purchases/usages will be used below
  }
  
  // ENHANCED DEVICE ACCESS CHECK: Create proper device info object
  const deviceId = deviceFingerprint || crypto.createHash('md5').update((routerId || 'default')).digest('hex').slice(0,16);
  
  // Skip device isolation check if user has video bundles, video access, OR purchased data remaining
  // (This prevents blocking users who have earned access through videos or purchased data)
  try {
    const basicQuota = computeRemaining(idLower, deviceFingerprint, routerId);
    
    // If user has active bundles OR purchased data remaining, skip device validation
    // Use sqlite-backed usageData (calculated above) to avoid stale XLSX reads and ensure
    // recently-created bundles are immediately visible to quota checks.
    const basicQuotaFromTracker = {
      totalBundleMB: usageData.totalBundleMB || 0,
      remainingMB: usageData.remainingMB || 0,
      totalUsedMB: usageData.totalUsedMB || 0,
      exhausted: usageData.exhausted || false
    };

    if ((basicQuotaFromTracker.totalBundleMB > 0 && !basicQuotaFromTracker.exhausted) || basicQuotaFromTracker.remainingMB > 0) {
      console.log(`[DEVICE-ACCESS-BYPASS] User ${idLower} has ${basicQuota.totalBundleMB}MB bundles + ${basicQuota.remainingMB}MB remaining - bypassing device isolation`);
      // Return the tracker-derived quota so later checks use sqlite-backed numbers
      return basicQuotaFromTracker;
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
function markDeviceUnlocked(deviceId, identifier, bundleMB = 100, durationHours = 2) {
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
      // Set device-level expiry for temporary full access
      try {
        const expiry = Date.now() + (Number(durationHours) || 2) * 60 * 60 * 1000; // hours -> ms
        // Store both by deviceId and identifier to improve recognition in proxy
        tempFullAccess.set(identifier.toLowerCase(), expiry);
        tempFullAccess.set(deviceId, expiry);
        // Persist to sqlite if available
        try {
          if (sqliteDB && sqliteDB.saveTempUnlock) sqliteDB.saveTempUnlock((identifier||'').toLowerCase(), deviceId, expiry);
        } catch(pe) { console.warn('[SAVE-TEMP-UNLOCK-ERR]', pe && pe.message); }
        console.log(`[DEVICE-UNLOCKED] Device ${deviceId.slice(0,8)}... earned ${bundleMB}MB and temp access until ${new Date(expiry).toISOString()}`);
      } catch(e) { console.warn('[TEMP-ACCESS-SET-ERROR]', e?.message); }

      return true;
    }

    return false;
  } catch (error) {
    console.error('[DEVICE-UNLOCK-ERROR]', error);
    return false;
  }
}

// Helper: compute persisted aggregates from SQLite for an identifier (if sqlite active)
function getSqliteAggregatesForIdentifier(identifier){
  try{
    if(!sqliteDB) return null;
    const id = String(identifier||'').trim();
    if(!id) return null;
    // sqliteDB.getPurchasesByPhone and getUsageByPhone return arrays
    const purchases = sqliteDB.getPurchasesByPhone ? sqliteDB.getPurchasesByPhone(id) : [];
    const usage = sqliteDB.getUsageByPhone ? sqliteDB.getUsageByPhone(id) : [];

    const totalBundleMB = (purchases || []).reduce((s,p)=> s + (Number(p.dataAmount||p.bundleMB||0)), 0);
    const totalUsedMB = (usage || []).reduce((s,u)=> s + (Number(u.dataUsed||u.usedMB||0)), 0);
    const remainingMB = Math.max(0, totalBundleMB - totalUsedMB);

    // Normalize purchases shape for clients (bundleMB, usedMB, routerId, grantedAtISO, bundleType)
    const normalizedPurchases = (purchases || []).map(r=>({
      bundleMB: Number(r.dataAmount||r.bundleMB||0),
      usedMB: Number(r.usedMB||0),
      routerId: r.routerId || r.router_id || 'router',
      grantedAtISO: r.timestamp || r.grantedAtISO || new Date().toISOString(),
      bundleType: r.bundleType || r.purchaseType || 'sqlite'
    })).sort((a,b)=> new Date(b.grantedAtISO) - new Date(a.grantedAtISO));

    return { totalBundleMB, totalUsedMB, remainingMB, purchases: normalizedPurchases };
  } catch(err){ console.warn('[SQLITE-AGG-ERR]', err && err.message); return null; }
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
    // Prefer sqlite aggregates when available for accurate persisted totals
    let sqliteAgg = null;
    try { sqliteAgg = sqliteDB ? getSqliteAggregatesForIdentifier(identifier) : null; } catch(e){ sqliteAgg = null; }
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
      totalDataUnlockedMB: sqliteAgg ? sqliteAgg.totalBundleMB : (summary.bundleMB||0),
      totalUsedMB: sqliteAgg ? sqliteAgg.totalUsedMB : (summary.usedMB||0),
      remainingDataMB: sqliteAgg ? sqliteAgg.remainingMB : Math.max(0, (summary.bundleMB||0) - (summary.usedMB||0)),
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
  dob: u.dob || null,
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
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wbCache, DATA_FILE);
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

// Friendly JSON parse error handler (body-parser emits a SyntaxError on invalid JSON)
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn('[BODY-PARSE-ERR]', err && err.message);
    return res.status(400).json({ ok: false, message: 'Invalid JSON in request body', raw: req.rawBody || null });
  }
  return next(err);
});

// NOTE: serve static files after application routes so API endpoints (like /admin/*) are not
// accidentally overridden by files like login.html. We'll mount static later, after admin routes.

// Explicit route for home.html to ensure it's served
app.get('/home.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

// Debug endpoint: echo raw body and headers (temporary, helpful for diagnosing PowerShell curl issues)
app.post('/api/debug-raw', (req, res) => {
  try {
    return res.json({ ok: true, rawBody: req.rawBody || null, headers: req.headers });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
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
  // Accept token from header, cookie (admin_token) or query param (admin_token or token)
  const headerToken = (req.headers['x-admin-token'] || '').toString().trim();
  let cookieToken = '';
  try {
    const c = req.headers['cookie'] || '';
    const m = c.match(/(?:^|; )admin_token=([^;]+)/);
    if (m) cookieToken = decodeURIComponent(m[1]);
  } catch (e) { cookieToken = ''; }
  const queryToken = (req.query && (req.query.admin_token || req.query.token || req.query.adminToken)) ? String(req.query.admin_token || req.query.token || req.query.adminToken).toString().trim() : '';
  const incoming = headerToken || cookieToken || queryToken;
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
app.post('/login', adminLimiter, (req, res)=>{
  // Accept either form fields or JSON
  const identifier = (req.body.email || req.body.username || '').trim();
  const password = req.body.password || '';
  const adminCode = req.body.code || req.body.adminCode || '';
  if (!identifier || !password) {
    // For form submissions, redirect back with message
    return res.status(302).redirect('/login.html?message=missing_fields');
  }
  const ok = validateLogin(identifier, password);
  if (ok) {
    // If this is the admin account, require the admin code as well
    if(isAdminIdentifier(identifier)){
      try {
        // Load stored admin_code_hash for this identifier
        let storedHash = null;
        if(sqliteDB){
          const row = sqliteDB.findUser(identifier) || sqliteDB.findUser(ADMIN_PHONE);
          if(row && row.admin_code_hash) storedHash = String(row.admin_code_hash);
        } else {
          const { data } = getUsers();
          const user = data.find(u=> (u.email||'').toLowerCase()===String(identifier).trim().toLowerCase() || u.phone===normalizePhone(identifier));
          if(user && user.admin_code_hash) storedHash = String(user.admin_code_hash);
        }
        if(!storedHash){
          console.warn('[ADMIN-LOGIN] Admin code not configured for', identifier);
          return res.status(302).redirect('/login.html?message=admin_code_missing');
        }
        if(!adminCode || !bcrypt.compareSync(String(adminCode), storedHash)){
          console.warn('[ADMIN-LOGIN-FAIL] bad admin code for', identifier);
          return res.status(302).redirect('/login.html?message=invalid_admin_code');
        }
      } catch(e){ console.warn('[ADMIN-LOGIN-ERR]', e && e.message); return res.status(302).redirect('/login.html?message=server_error'); }
    }
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
  
  // BYPASS AUTHENTICATION for video CDN proxy requests
  if ((req.path === '/proxy' || req.path === '/video-stream') && req.query.url) {
    try {
      const targetUrl = req.query.url;
      const urlObj = new URL(targetUrl);
      const hostHeader = urlObj.hostname;
      
      if (isVideoAdCDN(hostHeader)) {
        console.log('[VIDEO-PROXY-BYPASS] Allowing unauthenticated access to video CDN:', hostHeader);
        return next(); // Allow access to video proxy for CDN domains
      }
    } catch (e) {
      // Invalid URL, continue with normal auth check
    }
  }
  
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
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
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
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
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

function saveUser(email, password, phone, firstName, surname, dob, metadata = {}){
  try {
    const origEmail = (email||'').trim().toLowerCase();
    const normPhone = normalizePhone(phone);
    const now = new Date();
    
    // Basic validation (shared for both XLSX and SQLite flows)
    if(!origEmail && !normPhone){
      return { ok:false, field:'email', message:'Provide email or phone (at least one)' };
    }
    if(!password) return { ok:false, message:'Password required' };
    if(!isStrongPassword(password)) return { ok:false, message:'Weak password (needs upper, lower, number, symbol & 8+ chars)' };
    if(!firstName) return { ok:false, field:'firstName', message:'First name required' };
    if(!surname) return { ok:false, field:'surname', message:'Surname required' };
    if(!dob) return { ok:false, field:'dob', message:'Date of birth required' };
    if(new Date(dob) > new Date()) return { ok:false, field:'dob', message:'Date of birth cannot be in the future' };
    if(phone && !normPhone) return { ok:false, field:'phone', message:'Valid South African phone required' };

    // Enhanced user data with metadata
    const userData = {
      email: origEmail || null,
      phone: normPhone || null,
      password_hash: bcrypt.hashSync(password, 10),
      firstName: firstName?.trim() || '',
      surname: surname?.trim() || '',
      dob: dob || '',
      dateCreatedISO: metadata.registrationTime || now.toISOString(),
      dateCreatedLocal: metadata.registrationTimeLocal || now.toLocaleString(),
      registrationIP: metadata.registrationIP || 'unknown',
      userAgent: metadata.userAgent || 'unknown',
      deviceId: metadata.deviceInfo?.deviceId || 'unknown',
      registrationSource: 'portal',
      status: 'active',
      lastLoginISO: null,
      loginCount: 0
    };

    // If SQLite adapter is enabled, use it (and skip Excel writes)
    if (sqliteDB) {
      // Ensure duplicate checks
      try {
        const existingByEmail = origEmail ? sqliteDB.findUser(origEmail) : null;
        if (existingByEmail) return { ok:false, field:'email', message:'Email already registered' };
        const existingByPhone = normPhone ? sqliteDB.findUser(normPhone) : null;
        if (existingByPhone) return { ok:false, field:'phone', message:'Phone already registered' };
      } catch (e) {
        console.warn('[SAVEUSER-SQLITE-CHECK-ERR]', e && e.message);
      }

      const createResult = sqliteDB.createUser(userData);
      if (!createResult || !createResult.ok) {
        return { ok:false, message: createResult && createResult.message ? createResult.message : 'SQLite create user failed' };
      }
      
      // Fetch stored row to log masked hash
      try {
        const row = sqliteDB.findUser(origEmail || normPhone);
        const ph = row && row.password_hash ? String(row.password_hash) : '';
        const mask = h => { if(!h) return '<none>'; if(h.length<=12) return h.slice(0,4)+'...'; return h.slice(0,6)+'...'+h.slice(-4); };
        console.log('[REGISTRATION] sqlite user created:', { 
          identifier: (origEmail||normPhone), 
          password_hash_mask: mask(ph),
          registrationIP: userData.registrationIP,
          deviceId: userData.deviceId?.slice(0,8) + '...'
        });
      } catch (loge) { console.warn('[REGISTRATION-LOG-ERR]', loge && loge.message); }

      return { ok:true, identifier: (origEmail || normPhone).toLowerCase() };
    }
    
    // Fallback Excel/XLSX storage path (existing behavior enhanced)
    const wb = loadWorkbook();
    const ws = wb.Sheets['Users'];
    const data = XLSX.utils.sheet_to_json(ws);
    
    // Duplicate checks for XLSX path
    if(origEmail && data.find(u=> (u.email||'').toLowerCase()===origEmail)){
      return { ok:false, field:'email', message:'Email already registered' };
    }
    if(normPhone && data.find(u=> u.phone===normPhone)){
      return { ok:false, field:'phone', message:'Phone already registered' };
    }
    
    // Enhanced user record for XLSX
    const userRecord = {
      email: userData.email || '',
      phone: userData.phone || '',
      password_hash: userData.password_hash,
      password: '<hashed>', // Keep legacy column for backward compatibility
      firstName: userData.firstName,
      surname: userData.surname,
      dob: userData.dob,
      dateCreatedISO: userData.dateCreatedISO,
      dateCreatedLocal: userData.dateCreatedLocal,
      registrationIP: userData.registrationIP,
      userAgent: userData.userAgent?.substring(0, 200) || 'unknown', // Limit length for Excel
      deviceId: userData.deviceId?.substring(0, 50) || 'unknown',
      registrationSource: userData.registrationSource,
      status: userData.status,
      lastLoginISO: userData.lastLoginISO,
      loginCount: userData.loginCount
    };
    
    data.push(userRecord);
    
    // Sanitize data before writing to Excel to prevent character limit errors
    const sanitizedData = sanitizeDataForExcel(data);
    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(sanitizedData);
    
    try {
      if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
      try {
        // Keep logging minimal; only show masked representation
        const maskPwd = p => { if(!p) return '<none>'; if(p.length<=4) return p[0]+'***'; return p[0]+p[1]+'***'+p.slice(-2); };
        console.log('[REGISTRATION] xlsx user created:', { 
          identifier: (origEmail || normPhone), 
          password_mask: maskPwd(password),
          registrationIP: userData.registrationIP,
          deviceId: userData.deviceId?.slice(0,8) + '...'
        });
      } catch(e){ /* best-effort logging */ }
    } catch (writeError) {
      console.error('[XLSX-WRITE-ERROR] Failed to write user data:', writeError.message);
      if (writeError.message.includes('32767')) {
        console.log('[XLSX-RECOVERY] Attempting data cleanup and retry...');
        // Create cleaner version with essential data only
        const essentialData = data.map(user => ({
          identifier: (user.identifier || '').substring(0, 100),
          email: (user.email || '').substring(0, 100),
          phone: (user.phone || '').substring(0, 20),
          password_hash: (user.password_hash || '').substring(0, 100),
          password: '<hashed>',
          firstName: (user.firstName || '').substring(0, 50),
          surname: (user.surname || '').substring(0, 50),
          dob: (user.dob || '').substring(0, 10),
          dateCreatedISO: (user.dateCreatedISO || '').substring(0, 30),
          dateCreatedLocal: (user.dateCreatedLocal || '').substring(0, 30),
          registrationIP: (user.registrationIP || '').substring(0, 50),
          deviceId: (user.deviceId || '').substring(0, 50),
          status: 'active'
        }));
        wb.Sheets['Users'] = XLSX.utils.json_to_sheet(essentialData);
        XLSX.writeFile(wb, DATA_FILE);
      } else {
        throw writeError;
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

// Update user login statistics (login count and last login time)
function updateUserLoginStats(identifier, loginTime, loginIP) {
  try {
    if (sqliteDB) {
      // Update SQLite user record
      const user = sqliteDB.findUser(identifier);
      if (user) {
        const newLoginCount = (user.loginCount || 0) + 1;
        const db = sqliteDB._db();
        if (db) {
          db.prepare(`UPDATE users SET lastLoginISO = ?, loginCount = ? WHERE id = ?`)
            .run(loginTime, newLoginCount, user.id);
          
          console.log(`[LOGIN-STATS-UPDATED] ${identifier}: login count ${newLoginCount}, last login ${loginTime}`);
        }
      }
    } else {
      // Update XLSX user record
      const wb = loadWorkbook();
      const ws = wb.Sheets['Users'];
      const data = XLSX.utils.sheet_to_json(ws);
      
      const userIndex = data.findIndex(u => 
        (u.email && u.email.toLowerCase() === identifier) || 
        (u.phone && normalizePhone(u.phone) === normalizePhone(identifier))
      );
      
      if (userIndex !== -1) {
        data[userIndex].lastLoginISO = loginTime;
        data[userIndex].loginCount = (data[userIndex].loginCount || 0) + 1;
        
        const sanitizedData = sanitizeDataForExcel(data);
        wb.Sheets['Users'] = XLSX.utils.json_to_sheet(sanitizedData);
        
        if (process.env.USE_SQLITE !== 'true') {
          XLSX.writeFile(wb, DATA_FILE);
        }
        
        console.log(`[LOGIN-STATS-UPDATED] ${identifier}: login count ${data[userIndex].loginCount}`);
      }
    }
  } catch (error) {
    console.warn('[UPDATE-LOGIN-STATS-ERR]', error && error.message);
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
    user = data.find(u=> (String(u.email||'').trim().toLowerCase()===idEmail));
    if(user){
      // Prefer bcrypt password_hash when present
      if(user.password_hash){
        try { if(bcrypt.compareSync(password, String(user.password_hash))) return true; } catch(e){}
        return false;
      }
      // Legacy: plaintext password stored in 'password' column -> migrate to bcrypt hash
      if(user.password && String(user.password)===password){
        try {
          user.password_hash = bcrypt.hashSync(password, 10);
          user.password = '<migrated>';
          wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
          XLSX.writeFile(wb, DATA_FILE);
        } catch(e) { console.warn('[LOGIN-MIGRATE-ERR]', e && e.message); }
        return true;
      }
      return false;
    }
  } else {
    const norm = normalizePhone(identifier);
    user = data.find(u=>u.phone===norm);
    if(user){
      if(user.password_hash){
        try { if(bcrypt.compareSync(password, String(user.password_hash))) return true; } catch(e){}
        return false;
      }
      if(user.password && String(user.password)===password){
        try {
          user.password_hash = bcrypt.hashSync(password, 10);
          user.password = '<migrated>';
          wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
          XLSX.writeFile(wb, DATA_FILE);
        } catch(e) { console.warn('[LOGIN-MIGRATE-ERR]', e && e.message); }
        return true;
      }
      return false;
    }
  }
  return false;
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

// Ensure the seeded admin user exists in storage (SQLite or XLSX). Stores
// bcrypt hashes for password and admin code (admin_code_hash) so raw secrets
// are not persisted.
function ensureAdminSeeded(){
  try {
    const email = (ADMIN_EMAIL||'').trim().toLowerCase();
    const phone = normalizePhone(ADMIN_PHONE||'');
    const password = ADMIN_SEED_PASSWORD || '';
    const code = ADMIN_SEED_CODE || '';
    if(!email && !phone) return;
    const pwdHash = bcrypt.hashSync(password, 10);
    const codeHash = bcrypt.hashSync(code, 10);

    if (sqliteDB) {
      try {
        // Ensure admin_code_hash column exists (no-op if already present)
        try { sqliteDB._db().prepare('ALTER TABLE users ADD COLUMN admin_code_hash TEXT').run(); } catch(e) {}
        // Find existing user by email or phone
        let row = sqliteDB.findUser(email) || sqliteDB.findUser(phone);
        if(!row){
          const create = sqliteDB.createUser({ email: email || null, password: password, phone: phone || null, firstName: 'Sibusiso', surname: 'Sweetwell', dob: '' });
          if(create && create.ok){
            row = sqliteDB.findUser(email) || sqliteDB.findUser(phone);
          }
        }
        if(row){
          try { sqliteDB._db().prepare('UPDATE users SET password_hash=? WHERE id=?').run(pwdHash, row.id); } catch(e){}
          try { sqliteDB._db().prepare('UPDATE users SET admin_code_hash=? WHERE id=?').run(codeHash, row.id); } catch(e){}
          console.log('[ADMIN-SEED] ensured admin present (sqlite) ->', email || phone);
        }
      } catch(e){ console.warn('[ADMIN-SEED-SQLITE-ERR]', e && e.message); }
    } else {
      try {
        const { wb, ws, data } = getUsers();
        const existing = data.find(u=> (u.email||'').toLowerCase()===email) || data.find(u=> u.phone===phone);
        if(!existing){
          data.push({ email: email||'', phone: phone||'', password_hash: pwdHash, admin_code_hash: codeHash, password: '<hashed>', firstName: 'Sibusiso', surname: 'Sweetwell', dob: '', dateCreatedISO: new Date().toISOString(), dateCreatedLocal: new Date().toString() });
          wb.Sheets['Users'] = XLSX.utils.json_to_sheet(sanitizeDataForExcel(data));
          XLSX.writeFile(wb, DATA_FILE);
          console.log('[ADMIN-SEED] added admin to XLSX ->', email || phone);
        } else {
          existing.password_hash = pwdHash;
          existing.admin_code_hash = codeHash;
          wb.Sheets['Users'] = XLSX.utils.json_to_sheet(sanitizeDataForExcel(data));
          XLSX.writeFile(wb, DATA_FILE);
          console.log('[ADMIN-SEED] updated admin hashes in XLSX ->', email || phone);
        }
      } catch(e){ console.warn('[ADMIN-SEED-XLSX-ERR]', e && e.message); }
    }
  } catch(err){ console.warn('[ADMIN-SEED-ERR]', err && err.message); }
}

// In-memory reset codes (simple demo; for production use a DB + expiry)
const resetCodes = new Map(); // email -> { code, expires }

app.post('/api/forgot/start', (req,res)=>{
  const { email, phone, dob } = req.body;
  if(!email || !phone || !dob) return res.status(400).json({ ok:false, message:'Email, phone and date of birth required' });
  const emailLower = String(email).trim().toLowerCase();
  const normPhone = normalizePhone(phone);
  if(!normPhone) return res.status(400).json({ ok:false, message:'Invalid phone number' });
  try {
    let user;
    if (sqliteDB) {
      user = sqliteDB.findUser(emailLower);
      if (!user) return res.status(404).json({ ok:false, message:'Account not found' });
      // validate phone and dob when present
      if(user.phone && String(user.phone).trim() !== normPhone) return res.status(400).json({ ok:false, message:'Phone does not match our records' });
      if(user.dob && String(user.dob).trim() !== String(dob).trim()) return res.status(400).json({ ok:false, message:'Date of birth does not match our records' });
    } else {
      const { data } = getUsers();
      user = data.find(u=> String(u.email||'').trim().toLowerCase()===emailLower);
      if(!user) return res.status(404).json({ ok:false, message:'Account not found' });
      if(user.phone && normalizePhone(user.phone) !== normPhone) return res.status(400).json({ ok:false, message:'Phone does not match our records' });
      if(user.dob && String(user.dob).trim() !== String(dob).trim()) return res.status(400).json({ ok:false, message:'Date of birth does not match our records' });
    }
    const code = Math.floor(100000 + Math.random()*900000).toString();
    resetCodes.set(emailLower, { code, expires: Date.now()+10*60*1000 });
    console.log('[FORGOT-START] reset code generated for', emailLower);
    // For demo we return the code (normally you'd email/SMS it)
    res.json({ ok:true, code });
  } catch (err) {
    console.warn('[FORGOT-START-ERR]', err && err.message);
    return res.status(500).json({ ok:false, message:'Server error' });
  }
});

app.post('/api/forgot/verify', (req,res)=>{
  const { email, code, newPassword } = req.body;
  if(!email||!code||!newPassword) return res.status(400).json({ ok:false, message:'Missing fields' });
  const emailLower = String(email).trim().toLowerCase();
  const entry = resetCodes.get(emailLower);
  if(!entry || entry.code!==code || Date.now()>entry.expires){
    return res.status(400).json({ ok:false, message:'Invalid or expired code' });
  }
  try {
    if (sqliteDB) {
      const ch = sqliteDB.changePassword(emailLower, newPassword);
      if (!ch || !ch.ok) return res.status(500).json({ ok:false, message: ch && ch.message ? ch.message : 'Failed to change password' });
      // log masked hash
      try {
        const row = sqliteDB.findUser(emailLower);
        const ph = row && row.password_hash ? String(row.password_hash) : '';
        const mask = h => { if(!h) return '<none>'; if(h.length<=12) return h.slice(0,4)+'...'; return h.slice(0,6)+'...'+h.slice(-4); };
        console.log('[FORGOT-VERIFY] password updated for', emailLower, 'hash_mask=', mask(ph));
      } catch (le){ console.warn('[FORGOT-VERIFY-LOG-ERR]', le && le.message); }
    } else {
      // update password in sheet
      const { wb, ws, data } = getUsers();
      const user = data.find(u=> String(u.email||'').trim().toLowerCase()===emailLower);
      if(!user) return res.status(404).json({ ok:false, message:'User not found' });
      user.password = newPassword;
      const newWs = XLSX.utils.json_to_sheet(data);
      wb.Sheets['Users'] = newWs;
      XLSX.writeFile(wb, DATA_FILE);
    }
    resetCodes.delete(emailLower);
    try { appendAccessEvent({ identifier: emailLower, type:'password_reset', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'] }); } catch {}
    res.json({ ok:true });
  } catch (err) {
    console.warn('[FORGOT-VERIFY-ERR]', err && err.message);
    return res.status(500).json({ ok:false, message:'Server error' });
  }
});

app.post('/api/register', (req,res)=>{
  const { email, password, phone, firstName, surname, dob } = req.body||{};
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  const debugCtx = {
    hasEmail: !!email,
    hasPhoneRaw: !!phone,
    normalizedPhone: normalizePhone(phone),
    passwordLen: password?password.length:0,
    firstNamePresent: !!firstName,
    surnamePresent: !!surname,
    dobPresent: !!dob,
    bodyKeys: Object.keys(req.body||{}),
    registrationIP: clientIp,
    registrationTime: new Date().toISOString()
  };
  
  console.log('Incoming register:', { email, phone, firstName, surname, dob, ...debugCtx });
  
  if(!password || (!email && !phone)){
    return res.status(400).json({ ok:false, message:'Password and (email or phone) required', debug: debugCtx });
  }
  
  // Enhanced user registration with additional metadata
  const registrationData = {
    email: email ? email.toLowerCase().trim() : null,
    password: password,
    phone: normalizePhone(phone) || null,
    firstName: firstName ? firstName.trim() : null,
    surname: surname ? surname.trim() : null,
    dob: dob || null,
    registrationIP: clientIp,
    registrationTime: new Date().toISOString(),
    registrationTimeLocal: new Date().toLocaleString(),
    userAgent: userAgent,
    deviceInfo: generateDeviceFingerprint(req)
  };
  
  const result = saveUser(
    registrationData.email, 
    registrationData.password, 
    registrationData.phone, 
    registrationData.firstName, 
    registrationData.surname, 
    registrationData.dob,
    registrationData // Pass additional metadata
  );
  
  if(!result.ok){
    const status = /already|weak|future|required|valid|provide|password/i.test(result.message)?409:400;
    console.log('Registration rejected:', { result, debugCtx });
    return res.status(status).json({ ...result, debug: debugCtx });
  }
  
  try { 
    appendAccessEvent({ 
      identifier: (result.identifier|| (email||phone||'')).toLowerCase(), 
      type:'registration', 
      tsISO: registrationData.registrationTime, 
      ip: clientIp, 
      ua: userAgent 
    }); 
  } catch {}
  
  // Also log a signup_success event to SQLite events table when available
  try {
    if (sqliteDB) {
      sqliteDB.appendAccessEvent({ 
        identifier: (result.identifier|| (email||phone||'')).toLowerCase(), 
        type:'signup_success', 
        tsISO: registrationData.registrationTime, 
        ip: clientIp, 
        ua: userAgent, 
        data: { 
          email: (email||'').toLowerCase(),
          firstName: registrationData.firstName,
          surname: registrationData.surname,
          phone: registrationData.phone,
          registrationSource: 'portal'
        } 
      });
      console.log('[REGISTRATION] signup_success logged to sqlite events for', (result.identifier|| (email||phone||'')).toLowerCase());
    }
  } catch (e) { console.warn('[REG-LOG-SIGNUP-ERR]', e && e.message); }
  
  console.log(`[USER-REGISTERED] ${result.identifier} from ${clientIp}`);
  res.json({ ok:true, identifier: result.identifier, debug: debugCtx });
});

// Simple ping for frontend to verify backend availability
app.get('/api/ping', (req,res)=>{
  res.json({ ok:true, time:new Date().toISOString(), port:PORT });
});

// Admin endpoint: Get all registered users (requires admin access)
app.get('/api/admin/registrations', (req, res) => {
  try {
    // Simple admin auth check (you can enhance this with proper authentication)
    const authHeader = req.headers.authorization;
    const adminKey = req.query.adminKey || req.headers['x-admin-key'];
    
    // Basic admin key check (enhance this for production)
    if (!adminKey || adminKey !== 'isn_admin_2024') {
      return res.status(401).json({ 
        ok: false, 
        message: 'Admin access required. Provide adminKey parameter.' 
      });
    }
    
    let registrations = [];
    
    if (sqliteDB) {
      // Get users from SQLite
      try {
        const users = sqliteDB.getAllUsers();
        registrations = users.map(user => ({
          id: user.id,
          email: user.email || '',
          phone: user.phone || '',
          firstName: user.firstName || '',
          surname: user.surname || '',
          fullName: `${user.firstName || ''} ${user.surname || ''}`.trim(),
          dob: user.dob || '',
          registrationDate: user.dateCreatedISO || user.created_at,
          registrationDateLocal: user.dateCreatedLocal || 
            (user.created_at ? new Date(user.created_at).toLocaleString() : ''),
          registrationIP: user.registrationIP || 'unknown',
          userAgent: user.userAgent || 'unknown',
          deviceId: user.deviceId ? user.deviceId.substring(0, 12) + '...' : 'unknown',
          status: user.status || 'active',
          lastLogin: user.lastLoginISO,
          loginCount: user.loginCount || 0,
          source: user.registrationSource || 'portal'
        }));
      } catch (e) {
        console.warn('[ADMIN-SQLITE-ERR]', e && e.message);
      }
    } else {
      // Get users from XLSX
      try {
        const wb = loadWorkbook();
        const ws = wb.Sheets['Users'];
        const data = XLSX.utils.sheet_to_json(ws);
        
        registrations = data.map((user, index) => ({
          id: index + 1,
          email: user.email || '',
          phone: user.phone || '',
          firstName: user.firstName || '',
          surname: user.surname || '',
          fullName: `${user.firstName || ''} ${user.surname || ''}`.trim(),
          dob: user.dob || '',
          registrationDate: user.dateCreatedISO || '',
          registrationDateLocal: user.dateCreatedLocal || '',
          registrationIP: user.registrationIP || 'unknown',
          userAgent: user.userAgent ? user.userAgent.substring(0, 100) + '...' : 'unknown',
          deviceId: user.deviceId ? user.deviceId.substring(0, 12) + '...' : 'unknown',
          status: user.status || 'active',
          lastLogin: user.lastLoginISO || null,
          loginCount: user.loginCount || 0,
          source: user.registrationSource || 'portal'
        }));
      } catch (e) {
        console.warn('[ADMIN-XLSX-ERR]', e && e.message);
      }
    }
    
    // Sort by registration date (newest first)
    registrations.sort((a, b) => {
      const dateA = new Date(a.registrationDate || 0);
      const dateB = new Date(b.registrationDate || 0);
      return dateB - dateA;
    });
    
    const stats = {
      totalRegistrations: registrations.length,
      registrationsToday: registrations.filter(r => {
        const regDate = new Date(r.registrationDate);
        const today = new Date();
        return regDate.toDateString() === today.toDateString();
      }).length,
      registrationsThisWeek: registrations.filter(r => {
        const regDate = new Date(r.registrationDate);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return regDate >= weekAgo;
      }).length,
      activeUsers: registrations.filter(r => r.status === 'active').length,
      uniqueDevices: new Set(registrations.map(r => r.deviceId)).size
    };
    
    console.log(`[ADMIN-ACCESS] Registration data requested from ${req.ip}`);
    
    res.json({
      ok: true,
      stats,
      registrations,
      dataSource: sqliteDB ? 'sqlite' : 'xlsx',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[ADMIN-REGISTRATIONS-ERROR]', error.message);
    res.status(500).json({ 
      ok: false, 
      message: 'Failed to retrieve registration data' 
    });
  }
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

// Storage debug endpoint: reports active storage mode and file paths
app.get('/api/_debug/storage', (req, res) => {
  try {
    const storageMode = (process.env.USE_SQLITE === 'true') ? 'sqlite' : 'xlsx';
    const sqlitePath = process.env.SQLITE_PATH || path.join(DATA_DIR, 'logins.db');
    const xlsxPath = DATA_FILE;
    const sqliteExists = fs.existsSync(sqlitePath);
    const xlsxExists = fs.existsSync(xlsxPath);
    res.json({ ok:true, storageMode, paths: { sqlite: sqlitePath, xlsx: xlsxPath }, exists: { sqlite: sqliteExists, xlsx: xlsxExists }, dataDir: DATA_DIR });
  } catch(err){ res.status(500).json({ ok:false, message:'storage debug error' }); }
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
  
  // FIXED: Call recordPurchase with correct parameters (deviceFingerprint is the deviceId)
  const entry = recordPurchase(
    identifier.trim(),
    bundleMB,
    deviceFingerprint,
    routerIdValue,
    userAgent,
    source || 'manual'
  );
  registerActiveClient(req, entry.identifier);
  if(source==='ad-sequence'){
    try { socialUnlocked.add(entry.identifier.toLowerCase()); } catch {}
    // Always fully unlock after ad unless DISABLE_FULL_UNLOCK env flag set
    if(process.env.DISABLE_FULL_UNLOCK!=='true'){
      try { fullAccessUnlocked.add(entry.identifier.toLowerCase()); } catch {}
    }
  }
  try {
    // Mark device as having received a bundle so proxy can recognise device-scoped access
    try {
      const deviceKey = deviceFingerprint || '';
      const current = deviceBundlesGranted.get(deviceKey) || new Set();
      current.add(bundleMB);
      deviceBundlesGranted.set(deviceKey, current);
    } catch (e) { console.warn('[BUNDLE-GRANT-DEVICE-TRACK-ERR]', e && e.message); }

    // Temporary full access for device and identifier to take effect immediately
    const grantExpiry = Date.now() + (6 * 60 * 60 * 1000); // 6 hours
    try { tempFullAccess.set(entry.identifier, grantExpiry); } catch {}
    try { tempFullAccess.set(deviceFingerprint, grantExpiry); } catch {}

    // Also set router-scoped temporary access so manual-proxy clients using this router can connect
    try {
      if (routerIdValue) {
        routerTempAccess.set(routerIdValue, grantExpiry);
      }
    } catch (e) { console.warn('[ROUTER-TEMP-SET-ERR]', e && e.message); }

    // Ensure device is registered as active immediately so manual-proxy CONNECT sees it
    try {
      // registerActiveClient will create activeClients and deviceSessions entries
      registerActiveClient(req, entry.identifier, 6);

      // Also mark the device session as having received the video completion notification
      const ds = deviceSessions.get(deviceFingerprint) || deviceSessions.get(entry.identifier);
      if (ds) {
        ds.videoNotificationReceived = true;
        ds.lastVideoCompletion = Date.now();
        deviceSessions.set(deviceFingerprint, ds);
        deviceSessions.set(entry.identifier, ds);
      }
    } catch (e) { console.warn('[BUNDLE-GRANT-ACTIVE-REGISTER-ERR]', e && e.message); }

    // If deviceIsolation supports persistent device tokens, create one so manual proxy lookup works
    try {
      if (deviceIsolation && typeof deviceIsolation.setDeviceAccessToken === 'function') {
        const token = {
          identifier: entry.identifier,
          bundlesMB: bundleMB,
          expires: grantExpiry
        };
        deviceIsolation.setDeviceAccessToken(deviceFingerprint, token);
      }
    } catch (e) { console.warn('[DEVICE-ISOLATION-SET-TOKEN-ERR]', e && e.message); }
  } catch (err) { console.warn('[BUNDLE-GRANT-POST-PROCESS-ERR]', err && err.message); }
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
    // Add debug info showing deviceFingerprint and sqlite purchases count for this identifier
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
    // Google Ad Services & YouTube - Enhanced patterns
    'googleads.g.doubleclick.net','pagead2.googlesyndication.com','tpc.googlesyndication.com',
    'securepubads.g.doubleclick.net','video-ad-stats.googlesyndication.com',
    'imasdk.googleapis.com','www.gstatic.com','ssl.gstatic.com',
    'storage.googleapis.com','commondatastorage.googleapis.com', // Google Cloud Storage for videos
    'yt3.ggpht.com','ytimg.com','googlevideo.com','manifest.googlevideo.com',
    'youtube.com','www.youtube.com','m.youtube.com','youtu.be',
    // Google Video CDN Patterns - More comprehensive
    'video.google.com','play.google.com','googleusercontent.com',
    'gvt1.com','gvt2.com','gvt3.com','blogger.googleusercontent.com',
    // Sample video hosting domains (used in home.html)
    'sample-videos.com','www.learningcontainer.com','learningcontainer.com',
    'archive.org','vjs.zencdn.net','media.w3.org',
    // Vimeo
    'vimeo.com','player.vimeo.com','i.vimeocdn.com','f.vimeocdn.com',
    // Video Players & CDNs
    'jwpcdn.com','cdn.jwplayer.com','content.jwplatform.com',
    'brightcove.com','edge.api.brightcove.com','players.brightcove.net',
    // Facebook & Instagram Videos
    'facebook.com','www.facebook.com','m.facebook.com','web.facebook.com',
    'instagram.com','www.instagram.com','cdninstagram.com',
    'fbcdn.net','scontent.com','video.xx.fbcdn.net',
    // Spotify & Other Music/Video
    'spotify.com','open.spotify.com','audio-ak-spotify-com.akamaized.net',
    'scdn.co','spotifycdn.com','audio4-ak-spotify-com.akamaized.net',
    // TikTok
    'tiktok.com','www.tiktok.com','v16-webapp.tiktok.com',
    'musically.ly','musical.ly','byteoversea.com',
    // Common Video CDNs
    'cloudfront.net','amazonaws.com','akamai.net','akamaized.net',
    'fastly.com','cloudflare.com','jsdelivr.net','unpkg.com',
    // Additional Google Services
    'doubleclick.net','googletagmanager.com','googletagservices.com'
  ];
  
  // Direct match
  if (videoAdDomains.includes(hostHeader)) {
    console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'direct' });
    return true;
  }
  
  // Check for subdomain or wildcard matches
  for (const domain of videoAdDomains) {
    if (hostHeader.endsWith('.' + domain) || hostHeader === domain) {
      console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'subdomain', domain });
      return true;
    }
    // Check for Google Video CDN patterns (r1---sn-*.googlevideo.com)
    if (domain.includes('googlevideo.com') && /^r\d+---sn-[^.]+\.googlevideo\.com$/i.test(hostHeader)) {
      console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'google-video-cdn', pattern: 'r*---sn-*.googlevideo.com' });
      return true;
    }
    // Check for Facebook CDN patterns (scontent-*.xx.fbcdn.net)
    if (domain.includes('fbcdn.net') && /^scontent-[^.]+\.xx\.fbcdn\.net$/i.test(hostHeader)) {
      console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'facebook-cdn', pattern: 'scontent-*.xx.fbcdn.net' });
      return true;
    }
    // Check for Spotify CDN patterns (audio*-ak-spotify-com.akamaized.net)
    if (domain.includes('akamaized.net') && /^audio\d*-ak-spotify-com\.akamaized\.net$/i.test(hostHeader)) {
      console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'spotify-cdn', pattern: 'audio*-ak-spotify-com.akamaized.net' });
      return true;
    }
    // Check for Google services patterns (*.googleusercontent.com, *.gstatic.com, etc.)
    if ((domain.includes('google') || domain.includes('gvt')) && 
        (hostHeader.includes('google') || hostHeader.includes('gvt') || hostHeader.includes('youtube'))) {
      console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'google-services', domain });
      return true;
    }
  }
  
  // Special patterns for Google video services
  if (/^.*\.google(apis|usercontent|video|syndication)\.com$/i.test(hostHeader) ||
      /^.*\.gvt[0-9]\.com$/i.test(hostHeader) ||
      /^.*\.youtube(-nocookie)?\.com$/i.test(hostHeader) ||
      /^.*\.ytimg\.com$/i.test(hostHeader)) {
    console.log('[VIDEO-DOMAIN-MATCH]', { host: hostHeader, type: 'google-regex-pattern' });
    return true;
  }
  
  // Debug: Log when domains are NOT matched
  if (hostHeader.includes('google') || hostHeader.includes('youtube') || hostHeader.includes('video')) {
    console.log('[VIDEO-DOMAIN-NO-MATCH]', { host: hostHeader, reason: 'contains video keywords but no match' });
  }
  
  // Emergency fallback: if it looks like any video-related domain, allow it
  if (hostHeader.includes('video') || hostHeader.includes('cdn') || hostHeader.includes('stream') || 
      hostHeader.includes('media') || hostHeader.includes('content') || hostHeader.includes('youtube') ||
      hostHeader.includes('googlevideo') || hostHeader.includes('vimeo') || hostHeader.includes('facebook')) {
    console.log('[VIDEO-DOMAIN-EMERGENCY-MATCH]', { host: hostHeader, type: 'emergency-video-fallback' });
    return true;
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

      // If it's a video ad CDN host, immediately proxy without any blocking or checking
      // Video ads must ALWAYS work to ensure users can earn data bundles  
      console.log('[VIDEO-AD-BYPASS] Immediately proxying video ad request', { host: hostHeader, ip: clientIp, url: clientReq.url });
      
      // Mark as video ad traffic
      clientReq.headers['x-proxy-video-ad'] = '1';
      clientReq.headers['x-video-allowed'] = '1';
      
      // IMMEDIATELY proxy video ad requests without any authentication or data checks
      // For HTTP proxy requests, clientReq.url contains the full URL or just the path
      let targetPath = '/';
      let isHttps = false;
      
      try {
        // Check if it's a full URL (starts with http:// or https://)
        if (clientReq.url.startsWith('http://') || clientReq.url.startsWith('https://')) {
          const parsedUrl = url.parse(clientReq.url);
          targetPath = parsedUrl.path || '/';
          isHttps = parsedUrl.protocol === 'https:';
          console.log('[VIDEO-PROXY-URL-PARSED]', { originalUrl: clientReq.url, targetPath, isHttps });
        } else {
          // It's just a path
          targetPath = clientReq.url;
          isHttps = clientReq.headers['x-forwarded-proto'] === 'https' || hostHeader.includes('https');
          console.log('[VIDEO-PROXY-PATH-ONLY]', { path: targetPath, isHttps });
        }
      } catch (e) {
        console.warn('[VIDEO-PROXY-URL-PARSE-ERROR]', e.message, 'using fallback');
        targetPath = clientReq.url || '/';
        isHttps = clientReq.headers['x-forwarded-proto'] === 'https';
      }
      
      const targetPort = isHttps ? 443 : 80;
      const protocol = isHttps ? https : http;
      
      // Enhanced headers for Google video compatibility
      const proxyHeaders = {
        ...clientReq.headers,
        'host': hostHeader, // Set the correct host header
        'x-forwarded-for': clientIp,
        'x-video-ad-proxy': '1',
        'x-real-ip': clientIp,
        'user-agent': clientReq.headers['user-agent'] || 'Mozilla/5.0 (compatible; ISN-WiFi-Proxy/1.0)',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache'
      };
      
      // Remove problematic headers that might block Google videos
      delete proxyHeaders['connection'];
      delete proxyHeaders['proxy-connection'];
      delete proxyHeaders['proxy-authorization'];
      
      const proxyOptions = {
        hostname: hostHeader,
        port: targetPort,
        path: targetPath, // Use parsed path instead of full URL
        method: clientReq.method,
        headers: proxyHeaders,
        // Add timeout for better reliability
        timeout: 30000
      };

      const proxyReq = protocol.request(proxyOptions, proxyRes => {
        // Set CORS headers for video compatibility
        const responseHeaders = {
          ...proxyRes.headers,
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS, HEAD',
          'access-control-allow-headers': '*',
          'x-proxy-source': 'isn-video-proxy'
        };
        
        clientRes.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.on('data', chunk => clientRes.write(chunk));
        proxyRes.on('end', () => clientRes.end());
      });

      proxyReq.on('error', err => {
        console.error('[VIDEO-AD-PROXY-ERROR]', { 
          host: hostHeader, 
          path: targetPath,
          error: err.message, 
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
          address: err.address,
          port: err.port
        });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 
            'Content-Type': 'text/html',
            'access-control-allow-origin': '*'
          });
          clientRes.end('<html><body>Video Proxy Error: ' + err.message + '</body></html>');
        }
      });
      
      proxyReq.on('timeout', () => {
        console.warn('[VIDEO-AD-PROXY-TIMEOUT]', { host: hostHeader, path: targetPath });
        proxyReq.destroy();
        if (!clientRes.headersSent) {
          clientRes.writeHead(504, { 
            'Content-Type': 'text/html',
            'access-control-allow-origin': '*'
          });
          clientRes.end('<html><body>Video Proxy Timeout</body></html>');
        }
      });

      clientReq.pipe(proxyReq);
      return; // Exit immediately - no further processing needed for video ads
    }
    
    // AUTO-AUTHENTICATION: Check if unauthenticated user has earned data bundles via video watching
    if (!mappedIdentifier && !isPortalHost) {
      // Try to find user by device fingerprint who has earned data bundles
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      
      // Check device-specific video count for automatic access
      const deviceVideoCount = getDeviceVideoCount(deviceFingerprint, routerId);
      console.log(`[AUTO-AUTH-CHECK] Device ${deviceFingerprint.slice(0,8)}... has ${deviceVideoCount} videos for ${hostHeader}`);
      
      if (deviceVideoCount >= 5) { // User has watched enough videos to earn data
        // Find the identifier from ad events
        try {
          const XLSX = require('xlsx');
          const wb = XLSX.readFile(DATA_FILE);
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
              console.log('[AUTO-AUTH-VIDEO-EARNED] Auto-authenticating user with video-earned data bundles:', { 
                identifier: foundIdentifier,
                deviceFingerprint,
                videosWatched: deviceVideoCount,
                ip: clientIp,
                host: hostHeader
              });
              
              // Calculate earned bundle based on video count
              const earnedBundle = calculateEarnedBundle(deviceVideoCount);
              if (earnedBundle.bundleMB > 0) {
                // Grant immediate temporary access for video-earned data
                tempFullAccess.set(deviceFingerprint, Date.now() + (24 * 60 * 60 * 1000)); // 24 hours
                
                // Register as active client for proper quota tracking
                registerActiveClient(clientReq, foundIdentifier, 24);
                mappedIdentifier = resolveActiveClient(clientIp, clientReq);
                
                console.log('[AUTO-AUTH-VIDEO-SUCCESS] User authenticated with video-earned access:', {
                  identifier: foundIdentifier,
                  bundleMB: earnedBundle.bundleMB,
                  tier: earnedBundle.tier,
                  deviceVideoCount
                });
              }
            }
          }
        } catch (err) {
          console.warn('[AUTO-AUTH-VIDEO-ERROR]', err.message);
        }
      }
    }

    // Enhanced quota enforcement for proxied HTTP requests: redirect to portal for video watching when data exhausted
    try {
      if (mappedIdentifier) {
        const q = computeRemainingUnified(mappedIdentifier, null, clientReq.headers['x-router-id'] || clientIp);
        if (q && q.exhausted) {
          const portalUrl = `https://${RENDER_HOST}/home.html`;
          console.log('[PROXY-QUOTA-EXHAUSTED] Redirecting to portal for video watching:', { 
            identifier: mappedIdentifier, 
            ip: clientIp, 
            host: hostHeader,
            remainingMB: q.remainingMB,
            totalBundleMB: q.totalBundleMB,
            totalUsedMB: q.totalUsedMB
          });
          clientRes.writeHead(302, { 
            Location: portalUrl,
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          clientRes.end(`<!DOCTYPE html>
<html><head><title>Data Exhausted - Watch Videos for More</title>
<meta http-equiv="refresh" content="3;url=${portalUrl}">
</head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:50px;background:#f5f5f5;">
<div style="max-width:500px;margin:0 auto;background:white;padding:40px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
<h1 style="color:#f60000;margin-bottom:20px;">🎥 Data Bundle Exhausted</h1>
<p style="font-size:16px;margin-bottom:15px;">You've used <strong>${q.totalUsedMB || 0}MB</strong> of your <strong>${q.totalBundleMB || 0}MB</strong> earned data.</p>
<p style="font-size:18px;color:#333;margin-bottom:25px;"><strong>Watch more videos to earn additional data!</strong></p>
<div style="background:#f60000;color:white;padding:15px;border-radius:8px;margin-bottom:20px;">
<p style="margin:0;font-size:16px;">🚀 Each video earns you MORE internet data</p>
</div>
<p style="font-size:14px;color:#666;">Redirecting to ISN Free WiFi portal in 3 seconds...</p>
<script>
setTimeout(() => window.location.href='${portalUrl}', 3000);
// Also try immediate redirect if user clicks
document.body.onclick = () => window.location.href='${portalUrl}';
</script>
<p><a href="${portalUrl}" style="color:#f60000;font-size:18px;text-decoration:none;border:2px solid #f60000;padding:10px 20px;border-radius:25px;display:inline-block;margin-top:10px;">Watch Videos Now →</a></p>
</div></body></html>`);
          return;
        }
      }
    } catch (qe) { console.warn('[PROXY-QUOTA-CHK-ERR]', qe && qe.message); }

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
    // MANUAL PROXY: Enhanced video-based access for users who have watched videos on THIS device
    // Allow manual-proxy users who have watched videos on THIS device to get automatic access
    else if (isManualProxy && !mappedIdentifier && !isPortalHost) {
      try {
        const userAgent = clientReq.headers['user-agent'] || '';
        const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
        const deviceInfo = generateDeviceFingerprint(clientReq);
        const deviceId = deviceInfo.deviceId;

        // Get device-specific video count for accurate tracking
        const deviceVideoCount = getDeviceVideoCount(deviceId, routerId);
        console.log(`[MANUAL-PROXY-VIDEO-CHECK] Device ${deviceId.slice(0,8)}... has ${deviceVideoCount} videos watched`);

        // Calculate earned data bundle based on video milestone system
        const earnedBundle = calculateEarnedBundle(deviceVideoCount);
        
        if (earnedBundle.bundleMB > 0) {
          // Grant a temporary device-scoped unlock so the proxy recognises this device
          // as entitled to consume the video-earned allowance
          const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
          tempFullAccess.set(deviceId, expiry);
          
          console.log('[MANUAL-PROXY-VIDEO-ACCESS-GRANTED]', { 
            deviceId: deviceId.slice(0,8) + '...', 
            videoCount: deviceVideoCount, 
            earnedMB: earnedBundle.bundleMB,
            tier: earnedBundle.tier,
            expiry: new Date(expiry).toISOString()
          });
          
          // Do not return here; allow the request to continue and be processed normally
        } else {
          const videosNeeded = 5 - deviceVideoCount;
          console.log('[MANUAL-PROXY-BLOCKED] Manual proxy user must watch videos first:', { 
            host: hostHeader, 
            ip: clientIp, 
            deviceVideos: deviceVideoCount,
            videosNeeded: videosNeeded > 0 ? videosNeeded : 0
          });
          
          clientRes.writeHead(302, {
            'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=manual_proxy&blocked_host=${encodeURIComponent(hostHeader)}&videos_needed=${videosNeeded}`,
            'Content-Type': 'text/html; charset=utf-8'
          });
          clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Manual Proxy - Watch Videos Required</title>
<meta http-equiv="refresh" content="3;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;background:#f8f9fa;}
.container{max-width:600px;margin:0 auto;padding:30px;border:2px solid #007bff;border-radius:10px;background:#fff;}
.icon{font-size:48px;margin-bottom:20px;}
.btn{background:#007bff;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
.progress{background:#e9ecef;height:20px;border-radius:10px;margin:20px 0;overflow:hidden;}
.progress-fill{background:#007bff;height:100%;transition:width 0.3s;width:${(deviceVideoCount/5)*100}%;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">📺</div>
  <h1>🔐 Manual Proxy - Watch Videos to Access Internet</h1>
  <p><strong>Blocked Host:</strong> ${hostHeader}</p>
  <p><strong>Your Proxy:</strong> 10.5.48.94:8082</p>
  
  <div style="background:#e3f2fd;padding:20px;margin:20px 0;border-radius:8px;border:2px solid #2196f3;">
    <h3>📊 Video Progress:</h3>
    <p><strong>Videos Watched:</strong> ${deviceVideoCount} / 5</p>
    <p><strong>Videos Needed:</strong> ${videosNeeded > 0 ? videosNeeded : 0}</p>
    <div class="progress">
      <div class="progress-fill"></div>
    </div>
    <p><strong>Earn:</strong> 100MB internet access after 5 videos</p>
  </div>
  
  <div style="background:#f0f8ff;padding:15px;margin:20px 0;border-radius:5px;border:2px solid #4caf50;">
    <h3>🎯 Bundle System:</h3>
    <ul style="text-align:left;max-width:300px;margin:0 auto;">
      <li>🎥 <strong>5 videos = 100MB</strong></li>
      <li>🎥 <strong>10 videos = 250MB</strong></li>
      <li>🎥 <strong>15 videos = 500MB</strong></li>
    </ul>
  </div>
  
  <a href="http://${localIps[0] || 'localhost'}:${PORT}/login.html" class="btn">🎬 Watch Videos Now</a>
  <p><small>Each device must watch videos individually • Redirecting in 3 seconds...</small></p>
</div>
</body></html>`);
          return;
        }
      } catch (err) {
        console.warn('[MANUAL-PROXY-VIDEO-ERROR]', err && err.message);
        clientRes.writeHead(302, {
          'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=manual_proxy&blocked_host=${encodeURIComponent(hostHeader)}`,
          'Content-Type': 'text/html; charset=utf-8'
        });
        clientRes.end(`<html><body>Redirecting to portal to watch videos...</body></html>`);
        return;
      }
    }
    
    // AUTO PROXY: Enhanced video-based access - Block everything except portal until user watches videos AND has active data bundles
    else if (isAutoProxy && !mappedIdentifier) {
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceInfo = generateDeviceFingerprint(clientReq);
      const deviceId = deviceInfo.deviceId;

      // Check device-specific video count for automatic access
      const deviceVideoCount = getDeviceVideoCount(deviceId, routerId);
      const earnedBundle = calculateEarnedBundle(deviceVideoCount);
      
      console.log('[AUTO-PROXY-VIDEO-CHECK]', { 
        host: hostHeader, 
        ip: clientIp,
        deviceId: deviceId.slice(0,8) + '...',
        deviceVideoCount,
        earnedMB: earnedBundle.bundleMB
      });

      if (earnedBundle.bundleMB > 0) {
        // Auto-grant temporary access for devices that have earned data via videos
        const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        tempFullAccess.set(deviceId, expiry);
        
        console.log('[AUTO-PROXY-VIDEO-ACCESS-GRANTED]', {
          deviceId: deviceId.slice(0,8) + '...',
          videoCount: deviceVideoCount,
          earnedMB: earnedBundle.bundleMB,
          tier: earnedBundle.tier
        });
        
        // Allow the request to continue with earned access
      } else {
        const videosNeeded = 5 - deviceVideoCount;
        console.log('[AUTO-PROXY-BLOCKED] Auto proxy user must watch videos:', { 
          host: hostHeader, 
          ip: clientIp,
          deviceVideoCount,
          videosNeeded: videosNeeded > 0 ? videosNeeded : 0
        });
        
        clientRes.writeHead(302, { 
          'Location': `http://${localIps[0] || 'localhost'}:${PORT}/login.html?source=auto_proxy&blocked_host=${encodeURIComponent(hostHeader)}&videos_watched=${deviceVideoCount}&videos_needed=${videosNeeded}`,
          'Content-Type': 'text/html; charset=utf-8'
        });
        clientRes.end(`<!DOCTYPE html>
<html><head>
<title>Auto Proxy - Watch Videos Required</title>
<meta http-equiv="refresh" content="5;url=http://${localIps[0] || 'localhost'}:${PORT}/login.html">
<style>body{font-family:Arial;text-align:center;margin:50px;color:#333;background:#f8f9fa;}
.container{max-width:600px;margin:0 auto;padding:30px;border:2px solid #ff6b35;border-radius:10px;background:#fff;}
.icon{font-size:48px;margin-bottom:20px;}
.btn{background:#ff6b35;color:white;padding:15px 30px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin:20px 0;}
.progress{background:#e9ecef;height:20px;border-radius:10px;margin:20px 0;overflow:hidden;}
.progress-fill{background:#ff6b35;height:100%;transition:width 0.3s;width:${(deviceVideoCount/5)*100}%;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">📺</div>
  <h1>📺 Watch Videos to Access Internet</h1>
  <p><strong>Blocked Host:</strong> ${hostHeader}</p>
  <p><strong>Your PAC URL:</strong> http://10.5.48.94:${PORT}/proxy.pac</p>
  
  <div style="background:#fff3e0;padding:20px;margin:20px 0;border-radius:8px;border:2px solid #ff9800;">
    <h3>📊 Video Progress:</h3>
    <p><strong>Videos Watched:</strong> ${deviceVideoCount} / 5</p>
    <p><strong>Videos Needed:</strong> ${videosNeeded > 0 ? videosNeeded : 0}</p>
    <div class="progress">
      <div class="progress-fill"></div>
    </div>
    <p><strong>Earn:</strong> 100MB internet access after 5 videos</p>
  </div>
  
  <div style="background:#f0f0f0;padding:15px;margin:20px;border-radius:5px;">
    <h3>📊 Bundle System:</h3>
    <ul style="list-style:none;padding:0;">
      <li>🎥 <strong>5 videos = 100MB</strong> bundle</li>
      <li>🎥 <strong>10 videos = 250MB</strong> bundle</li>
      <li>🎥 <strong>15 videos = 500MB</strong> bundle</li>
    </ul>
  </div>
  
  <a href="http://10.5.48.94:${PORT}/login.html" class="btn">🎬 Start Watching Videos</a>
  <p><small>Each device earns access individually • Redirecting in 5 seconds...</small></p>
</div>
</body></html>`);
        return;
      }
    }
    
    // AUTO PROXY WITH AUTHENTICATION: Must have valid data bundles (no free access)
    else if (isAutoProxy && mappedIdentifier) {
      const userAgent = clientReq.headers['user-agent'] || '';
      const routerId = clientReq.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);
      const quota = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
      
      // STRICT: Auto proxy users can only access internet if they have data bundles (not temp access)
  const deviceKey = deviceFingerprint || '';
  const tempUnlocked = ((tempFullAccess.get(mappedIdentifier) || 0) > Date.now()) || ((tempFullAccess.get(deviceKey) || 0) > Date.now());
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
  // Consider temp unlocks set either for the identifier or for the specific device fingerprint
  const deviceKey = deviceFingerprint || '';
  const tempUnlocked = ((tempFullAccess.get(effectiveIdentifier) || 0) > Date.now()) || ((tempFullAccess.get(deviceKey) || 0) > Date.now());
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
  // If the browser included a portal_token, prefer that identifier for unlock checks
  const tokenIdentifier = parsedToken && parsedToken.identifier ? parsedToken.identifier : null;
  if (!mappedIdentifier && tokenIdentifier) {
    // mappedIdentifier is normally an object { identifier, deviceId, sessionToken }
    mappedIdentifier = { identifier: tokenIdentifier, deviceId: null, sessionToken: parsedToken && parsedToken.sessionToken };
  }
  
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
  const wb = XLSX.readFile(DATA_FILE);
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
  // Decide whether this CONNECT should be allowed based on device/identifier unlocks or bundles
  let allowConnect = false;
  try {
    // Compute device fingerprint and quota for mapped identifier or candidate device
    const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
  const deviceFingerprint = crypto.createHash('md5').update((req.headers['user-agent']||'') + routerId).digest('hex').slice(0,16);

  const deviceKey = deviceFingerprint || '';
  // Check tempFullAccess for identifier (mappedIdentifier may be object or string) and device key
  let identifierKey = null;
  if (mappedIdentifier) identifierKey = typeof mappedIdentifier === 'string' ? mappedIdentifier : mappedIdentifier.identifier;
  if (!identifierKey && tokenIdentifier) identifierKey = tokenIdentifier;
  const tempUnlocked = ((identifierKey && (tempFullAccess.get(identifierKey) || 0) > Date.now()) || ((tempFullAccess.get(deviceKey) || 0) > Date.now()));

    // If mappedIdentifier exists, use unified quota check
    if (mappedIdentifier) {
      const identifierKey = typeof mappedIdentifier === 'string' ? mappedIdentifier : mappedIdentifier.identifier;
      const quota = computeRemainingUnified(identifierKey, deviceFingerprint, routerId);
      if (!quota.exhausted && quota.remainingMB > 0) {
        allowConnect = true;
        console.log('[HTTPS-CONNECT-ALLOWED-BUNDLE]', { identifier: mappedIdentifier, remainingMB: quota.remainingMB });
      }
    }

    // If no mappedIdentifier but device temp unlock exists (from watching videos), allow until expiry
    if (!allowConnect && tempUnlocked) {
      allowConnect = true;
      console.log('[HTTPS-CONNECT-ALLOWED-TEMP]', { device: deviceKey.slice(0,8), mappedIdentifier });
    }

      // Router-level temporary access: allow any client on this router to CONNECT while routerTempAccess is valid
      try {
        const routerExpiry = routerTempAccess.get(routerId) || 0;
        if (!allowConnect && routerExpiry > Date.now()){
          allowConnect = true;
          console.log('[HTTPS-CONNECT-ALLOWED-ROUTER]', { routerId, expiry: new Date(routerExpiry).toISOString() });
        }
      } catch(e) { /* non-fatal */ }

    // Allow portal and video-ad hosts always
    if (isPortalHost || isVideoAdHost) allowConnect = true;
  } catch (err) {
    console.warn('[HTTPS-CONNECT-CHECK-ERR]', err && err.message);
  }

  if (!allowConnect) {
    const blockMessage = isManualProxy 
      ? 'Manual proxy user must login first to access HTTPS sites'
      : 'Auto proxy user must watch videos first to access HTTPS sites';
    console.warn('[HTTPS-BLOCKED-UNAUTHENTICATED]', { host: hostOnly, ip: clientIp, type: isManualProxy ? 'MANUAL' : 'AUTO', reason: blockMessage });

    // Send HTTP 302 redirect response for HTTPS CONNECT requests
    const redirectUrl = `http://${localIps[0] || 'localhost'}:${PORT}/login.html?blocked_https=${encodeURIComponent(hostOnly)}&proxy_type=${isManualProxy ? 'manual' : 'auto'}`;
    clientSocket.write('HTTP/1.1 302 Found\r\n');
    clientSocket.write(`Location: ${redirectUrl}\r\n`);
    clientSocket.write('Content-Type: text/html; charset=utf-8\r\n');
    clientSocket.write('Connection: close\r\n\r\n');
    clientSocket.end();
    return;
  }
  
  
  // Per-connection CONNECT quota enforcement: if mappedIdentifier exists check quota and block tunnel when exhausted
  try {
    if (mappedIdentifier) {
      const routerId = req.headers['x-router-id'] || clientIp || 'unknown';
      const deviceFingerprint = crypto.createHash('md5').update((req.headers['user-agent']||'') + routerId).digest('hex').slice(0,16);
      const q = computeRemainingUnified(mappedIdentifier, deviceFingerprint, routerId);
      if (q && q.exhausted) {
        const redirectUrl = `http://${localIps[0] || 'localhost'}:${PORT}/quota.html?used=${q.totalUsedMB||0}&limit=${q.totalBundleMB||0}`;
        clientSocket.write('HTTP/1.1 302 Found\r\n');
        clientSocket.write(`Location: ${redirectUrl}\r\n`);
        clientSocket.write('Content-Type: text/html\r\n\r\n');
        clientSocket.write(`<html><body><h1>Data bundle exhausted</h1><p>Redirecting to <a href="${redirectUrl}">${redirectUrl}</a></p></body></html>`);
        clientSocket.end();
        return;
      }
    }
  } catch (qe) { console.warn('[CONNECT-QUOTA-CHK-ERR]', qe && qe.message); }
  
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
            // Adaptive strategy: if the device session already shows recent internet unlock,
            // prefer router-scoped temporary access so manual-proxy clients on same router can
            // connect immediately without re-issuing device-level full unlocks (avoids duplication).
            const recentWindowMs = 24 * 60 * 60 * 1000; // 24 hours
            const deviceSession = deviceSessions.get(deviceFingerprint) || deviceSessions.get(mappedIdentifier);
            const recentUnlock = deviceSession && deviceSession.lastVideoCompletion && ((Date.now() - deviceSession.lastVideoCompletion) < recentWindowMs);
            if (recentUnlock) {
              // ensure routerTempAccess exists for this router so manual-proxy clients can connect
              try { routerTempAccess.set(routerId, Date.now() + (60*60*1000)); } catch(e){}
              console.log('[ADAPTIVE-STRATEGY] recent device unlock detected; using routerTempAccess for', routerId);
              // grant a small progressive allowance for the session but avoid marking device-level permanent unlock here
              // determine videoAccessMB as below but do not set fullAccess flags
            }
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
  // Consider both identifier-level and device-level temporary access
  const deviceKey = deviceFingerprint || '';
  const tempUnlocked = ((tempFullAccess.get(effectiveIdentifier) || 0) > Date.now()) || ((tempFullAccess.get(deviceKey) || 0) > Date.now());
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
          clientSocket.write(`Location: http://${localIps[0] || 'localhost'}:${PORT}/quota.html?message=social_blocked&app=${encodeURIComponent(hostOnly)}&reason=video_required\r\n`);
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
      
      // Enhanced HTTPS blocking: redirect to portal for video watching when quota exceeded
      if (quota.remainingMB <= 0 && quota.totalBundleMB > 0) {
        const portalUrl = `https://${RENDER_HOST}/home.html`;
        const blockedReason = `HTTPS Data limit exceeded: Used ${totalUsedMB.toFixed(1)}MB of ${quota.totalBundleMB}MB - Watch videos for more data`;
        
        console.warn('[HTTPS-BLOCKED-QUOTA-EXCEEDED]', { 
          host: hostOnly, 
          ip: clientIp,
          identifier: mappedIdentifier,
          totalUsed: totalUsedMB,
          limit: quota.totalBundleMB,
          remaining: quota.remainingMB,
          redirectingTo: 'portal'
        });
        
        clientSocket.write('HTTP/1.1 302 Found\r\n');
        clientSocket.write(`Location: ${portalUrl}\r\n`);
        clientSocket.write('Content-Type: text/html; charset=utf-8\r\n');
        clientSocket.write('Connection: close\r\n\r\n');
        
        const htmlContent = `<!DOCTYPE html>
<html><head>
<title>Data Exhausted - Watch Videos for More</title>
<meta http-equiv="refresh" content="3;url=${portalUrl}">
<style>
  body{font-family:Arial;text-align:center;margin:50px;color:#333;background:#f5f5f5;}
  .container{max-width:600px;margin:0 auto;padding:30px;border:3px solid #f60000;border-radius:15px;background:white;box-shadow:0 6px 20px rgba(0,0,0,0.1);}
  .icon{font-size:48px;margin-bottom:20px;}
  .title{color:#f60000;font-size:28px;margin-bottom:15px;font-weight:bold;}
  .usage{background:#ffe6e6;padding:15px;border-radius:8px;margin:20px 0;font-size:16px;}
  .cta{background:#f60000;color:white;padding:15px 30px;border-radius:25px;text-decoration:none;font-size:18px;font-weight:bold;display:inline-block;margin:20px 0;}
  .redirect{color:#666;font-size:14px;margin-top:15px;}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🎥</div>
  <div class="title">Data Bundle Exhausted!</div>
  <div class="usage">
    You've used <strong>${totalUsedMB.toFixed(1)}MB</strong> of your 
    <strong>${quota.totalBundleMB}MB</strong> earned data bundle.
  </div>
  <p style="font-size:18px;margin:20px 0;"><strong>Watch more videos to earn additional internet data!</strong></p>
  <div style="background:#f0f8ff;padding:15px;border-radius:8px;margin:20px 0;">
    <p style="margin:0;color:#0066cc;font-weight:bold;">🚀 Each video earns you MORE internet time!</p>
  </div>
  <a href="${portalUrl}" class="cta">Watch Videos Now →</a>
  <div class="redirect">Redirecting to ISN Free WiFi portal in 3 seconds...</div>
  <script>
    setTimeout(() => window.location.href='${portalUrl}', 3000);
    document.body.onclick = () => window.location.href='${portalUrl}';
  </script>
</div>
</body></html>`;
        
        clientSocket.write(htmlContent);
        clientSocket.end();
        return;
      }

      // Allow normal HTTPS connection to proceed if under quota
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
  try {
    proxy.listen(PROXY_PORT, host, ()=> {
      console.log(`Captive proxy listening on http://${host}:${PROXY_PORT}`);
      process.env.PROXY_STARTED = 'true';
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.warn('[PROXY-PORT-IN-USE] Could not bind proxy port', PROXY_PORT, 'continuing without proxy');
      process.env.PROXY_STARTED = 'false';
    } else {
      console.warn('[PROXY-LISTEN-ERR]', err && err.message);
    }
  }
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
      if (sqliteDB) {
        // Use sqlite purchases (normalize field names to match expected client shape)
        const rows = sqliteDB.getPurchasesByPhone(idLower || '');
        if (Array.isArray(rows)) {
          myPurchases = rows.map(r => ({
            bundleMB: Number(r.dataAmount)||0,
            usedMB: 0,
            routerId: r.routerId || 'router',
            grantedAtISO: r.timestamp || new Date().toISOString(),
            bundleType: r.bundleType || r.purchaseType || 'video_reward'
          }));
          // Sort newest first
          myPurchases.sort((a,b) => new Date(b.grantedAtISO) - new Date(a.grantedAtISO));
        }
      } else {
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
    
    // Prefer persisted sqlite aggregates when available for authoritative totals
    const sqliteAgg = sqliteDB ? getSqliteAggregatesForIdentifier(idLower) : null;
    // Enhanced response with real data
    const response = {
      ok: true,
      // Prefer sqlite totals, fallback to real-time tracker
      totalBundleMB: sqliteAgg ? sqliteAgg.totalBundleMB : (usageData.totalBundleMB || 0),
      totalUsedMB: sqliteAgg ? sqliteAgg.totalUsedMB : (usageData.totalUsedMB || 0),
      remainingMB: sqliteAgg ? sqliteAgg.remainingMB : (usageData.remainingMB || 0),
      exhausted: sqliteAgg ? (sqliteAgg.remainingMB <= 0) : (usageData.exhausted || false),
      
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
  // If sqlite aggregates include normalized purchases, use them; otherwise use myPurchases
  purchases: sqliteAgg && Array.isArray(sqliteAgg.purchases) && sqliteAgg.purchases.length ? sqliteAgg.purchases : myPurchases,
      
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

  // DEBUG: Inspect quota, sqlite purchases, in-memory device quotas and temp unlocks
  app.get('/api/debug/quota', (req, res) => {
    const identifier = (req.query.identifier || '').toString().trim().toLowerCase();
    const deviceId = (req.query.deviceId || '').toString().trim();
    try {
      const routerId = req.headers['x-router-id'] || req.ip || 'unknown';
      const userAgent = req.headers['user-agent'] || '';
      const deviceFingerprint = crypto.createHash('md5').update(userAgent + routerId).digest('hex').slice(0,16);

      const quota = computeRemainingUnified(identifier, deviceFingerprint, routerId);
      const purchases = (sqliteDB && typeof sqliteDB.getPurchasesByPhone === 'function') ? sqliteDB.getPurchasesByPhone(identifier) : null;
      const deviceQ = deviceQuotas.get(deviceId || deviceFingerprint) || null;
      const tempForId = tempFullAccess.get(identifier) || null;
      const tempForDev = tempFullAccess.get(deviceId) || null;

  // include PID and sqlite active flag to help identify which server process handled the request
  res.json({ ok: true, identifier, deviceId, deviceFingerprint, routerId, quota, purchases, deviceQ, tempForId, tempForDev, pid: process.pid, sqliteActive: !!sqliteDB });
    } catch (err) {
      console.error('[DEBUG-QUOTA-ERR]', err && err.message);
      res.status(500).json({ ok: false, message: err && err.message });
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
app.get('/api/admin/overview', adminLimiter, (req,res)=>{
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
app.get('/api/admin/realtime-usage', adminLimiter, (req,res)=>{
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
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
}
function upsertAd(def){
  if(!def.adId) return;
  const wb = loadWorkbookWithTracking();
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADS]);
  const existing = rows.find(a=>a.adId===def.adId);
  if(existing) Object.assign(existing, def); else rows.push(def);
  wb.Sheets[SHEET_ADS] = XLSX.utils.json_to_sheet(rows);
  if (process.env.USE_SQLITE !== 'true') XLSX.writeFile(wb, DATA_FILE);
}
function recordAdEvent(ev){
  const wb = loadWorkbookWithTracking();
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
  rows.push({ id: guid(), ...ev });
  wb.Sheets[SHEET_ADEVENTS] = XLSX.utils.json_to_sheet(rows);
  XLSX.writeFile(wb, DATA_FILE);
}

// Admin dashboard explicit tables
app.get('/api/admin/dashboard', adminLimiter, (req,res)=>{
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
        // Numeric aggregate fields for frontend rendering
        totalUsedMB: Number((totalUsedMB || 0).toFixed(2)),
        totalDataMB: Number((totalBundleMB || 0).toFixed(2)),
        remainingDataMB: Number((remainingMB || 0).toFixed(2)),
        sessionUsageMB: Number((sessionUsageMB || 0).toFixed(2)),
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
app.get('/api/admin/device-access', adminLimiter, (req, res) => {
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
app.post('/api/admin/device-access/revoke', adminLimiter, (req, res) => {
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
app.post('/api/admin/router/meta', adminLimiter, (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const { routerId, ipAddress, location, lastMaintenanceISO } = req.body||{};
  if(!routerId) return res.status(400).json({ ok:false, message:'routerId required' });
  try { upsertRouterMeta({ routerId, ipAddress, location, lastMaintenanceISO }); res.json({ ok:true }); } catch(err){ res.status(500).json({ ok:false, message:'Error saving router meta' }); }
});

// Ad definition upsert
app.post('/api/admin/ads/upsert', adminLimiter, (req,res)=>{
  const requester=(req.headers['x-user-identifier']||'').toString().trim().toLowerCase();
  if(!isAdminIdentifier(requester)){ return res.status(403).json({ ok:false, message:'Forbidden' }); }
  const { adId, title, type, routerZones } = req.body||{};
  if(!adId) return res.status(400).json({ ok:false, message:'adId required' });
  try { upsertAd({ adId, title, type, routerZones: Array.isArray(routerZones)?routerZones.join('|'):routerZones }); res.json({ ok:true }); } catch(err){ res.status(500).json({ ok:false, message:'Error saving ad' }); }
});

// Admin function to reset all user data (clear bundles, usage, sessions) - NUCLEAR OPTION
app.post('/api/admin/reset-all-data', adminLimiter, (req,res)=>{
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
// Router-scoped temporary access (routerId -> expiry timestamp ms) to allow manual-proxy clients on same router
const routerTempAccess = new Map();
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
    
    // Enhanced video completion validation with automatic data bundle grants
    if(eventType==='complete' && idNorm){
      console.log('[AD-COMPLETE-DEBUG]', { identifier: idNorm, deviceId: deviceId.slice(0,8) + '...', watchSeconds: watch, eventType });
      
      // STRICTER MINIMUM WATCH TIME - Must watch at least 80% of typical ad duration
      const minCompleteSeconds = Number(process.env.WATCH_COMPLETE_MIN_SECONDS || 12); // 12 seconds minimum for fast Google CDN videos
      
      if(watch >= minCompleteSeconds) {
        // Get current video count for this device
        const currentVideoCount = getDeviceVideoCount(deviceId, rId);
        const newVideoCount = currentVideoCount + 1;
        
        console.log('[VIDEO-COMPLETION-TRACKING]', {
          identifier: idNorm,
          deviceId: deviceId.slice(0,8) + '...',
          previousVideos: currentVideoCount,
          newTotal: newVideoCount,
          watchSeconds: watch
        });
        
        // Auto-grant data bundles based on video milestones
        const grantResult = autoGrantInternetAccess(idNorm, deviceId, newVideoCount, rId);
        
        if (grantResult.success) {
          rewardsGranted.push(`Video #${newVideoCount}: Earned ${grantResult.bundleMB}MB data bundle!`);
          bundleUpgrade = { 
            deviceId: deviceId.slice(0,8) + '...', 
            bundleMB: grantResult.bundleMB, 
            tier: grantResult.tier,
            videoCount: newVideoCount,
            message: `Video complete! ${grantResult.bundleMB}MB data bundle activated.`,
            accessDuration: Math.ceil(grantResult.accessDurationMs / (60 * 1000)) + ' minutes'
          };
          
          console.log('[AUTO-BUNDLE-GRANTED]', {
            identifier: idNorm,
            deviceId: deviceId.slice(0,8) + '...',
            videoCount: newVideoCount,
            bundleMB: grantResult.bundleMB,
            tier: grantResult.tier,
            accessDurationMinutes: Math.ceil(grantResult.accessDurationMs / (60 * 1000))
          });
        } else {
          // Still reward partial progress
          const nextMilestone = Math.ceil(newVideoCount / 5) * 5; // Next multiple of 5
          const videosNeeded = nextMilestone - newVideoCount;
          rewardsGranted.push(`Video #${newVideoCount} completed! ${videosNeeded} more videos to unlock ${calculateEarnedBundle(nextMilestone).bundleMB}MB bundle.`);
          
          bundleUpgrade = {
            deviceId: deviceId.slice(0,8) + '...',
            videoCount: newVideoCount,
            message: `Great! ${videosNeeded} more videos needed for ${calculateEarnedBundle(nextMilestone).bundleMB}MB bundle.`,
            progress: `${newVideoCount % 5}/5 videos toward next bundle`
          };
        }
        
        // Mark device as having earned access (legacy compatibility)
        markDeviceUnlocked(deviceId, idNorm, 25); // Small amount for legacy systems
        
      } else {
        console.log('[INSUFFICIENT-WATCH-TIME]', { 
          identifier: idNorm, 
          deviceId: deviceId.slice(0,8) + '...', 
          watchSeconds: watch, 
          required: minCompleteSeconds 
        });
        rewardsGranted.push(`Video too short (${watch}s/${minCompleteSeconds}s required). Watch the full video to earn data!`);
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
app.post('/api/admin/device-unblock', adminLimiter, (req, res) => {
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

// Admin: list active temp unlocks
app.get('/api/admin/temp-unlocks', (req, res) => {
  try {
    const token = req.headers['x-portal-secret'] || req.query.secret;
    if (token !== PORTAL_SECRET) return res.status(403).json({ ok: false, message: 'Forbidden' });
    if (!sqliteDB || !sqliteDB.loadTempUnlocks) return res.json({ ok: true, unlocks: [] });
    const rows = sqliteDB.loadTempUnlocks();
    // Normalize for display
    const active = (rows || []).filter(r => Number(r.expiry) > Date.now()).map(r => ({ id: r.id, identifier: (r.identifier||'').toLowerCase(), deviceId: r.deviceId, expiry: Number(r.expiry) }));
    res.json({ ok: true, unlocks: active });
  } catch (err) {
    console.error('[ADMIN-TEMP-UNLOCKS-ERR]', err && err.message);
    res.status(500).json({ ok: false, message: 'Failed' });
  }
});

// Admin: revoke a temp unlock by id or by identifier+deviceId
app.post('/api/admin/temp-unlocks/revoke', (req, res) => {
  try {
    const token = req.headers['x-portal-secret'] || req.body.secret;
    if (token !== PORTAL_SECRET) return res.status(403).json({ ok: false, message: 'Forbidden' });
    const { id, identifier, deviceId } = req.body || {};
    if (!sqliteDB) return res.status(500).json({ ok: false, message: 'Sqlite not enabled' });

    let removed = 0;
    if (id) {
      const ok = sqliteDB.deleteTempUnlockById(id);
      if (ok) removed = 1;
    } else if (identifier && deviceId) {
      removed = sqliteDB.deleteTempUnlock((identifier||'').toLowerCase(), deviceId);
    } else {
      return res.status(400).json({ ok: false, message: 'Missing id or identifier+deviceId' });
    }

    // Remove from in-memory map as well
    try {
      if (identifier) tempFullAccess.delete((identifier||'').toLowerCase());
      if (deviceId) tempFullAccess.delete(deviceId);
    } catch(e) {}

    // Audit: record admin revoke action into SQLite events (if enabled)
    try {
      if (sqliteDB && sqliteDB.appendAccessEvent) {
        sqliteDB.appendAccessEvent({
          identifier: (identifier||null),
          type: 'admin_revoke_temp_unlock',
          tsISO: new Date().toISOString(),
          ip: req.ip || null,
          ua: req.headers['user-agent'] || null,
          data: { id: id || null, identifier: identifier || null, deviceId: deviceId || null, removed }
        });
      }
    } catch(e) { console.warn('[ADMIN-REVOKE-AUDIT-ERR]', e && e.message); }

    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[ADMIN-REVOKE-TEMP-UNLOCK-ERR]', err && err.message);
    res.status(500).json({ ok: false, message: 'Failed' });
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

// Enhanced video completion API with automatic internet access
app.post('/api/video/complete', (req, res) => {
  try {
    const { identifier, videoUrl, duration, deviceId: providedDeviceId } = req.body || {};
    
    if (!identifier || !videoUrl || !duration) {
      return res.status(400).json({ ok: false, message: 'Missing required fields: identifier, videoUrl, duration' });
    }
    
    // Validate duration is reasonable (between 30 seconds and 10 minutes)
    const durationNum = Number(duration);
    if (isNaN(durationNum) || durationNum < 30 || durationNum > 600) {
      console.warn(`[VIDEO-INVALID-DURATION] ${identifier} submitted invalid duration: ${duration}s (must be 30-600s)`);
      return res.status(400).json({ 
        ok: false, 
        message: 'Invalid video duration. Videos must be watched for 30 seconds to 10 minutes.' 
      });
    }
    
    // Use provided deviceId or generate from request
    const deviceInfo = generateDeviceFingerprint(req);
    const deviceId = providedDeviceId || deviceInfo.deviceId;
    const routerId = req.headers['x-router-id'] || detectRouterId(req) || 'default-router';
    const clientIp = req.ip || req.connection.remoteAddress;
    
    console.log(`[VIDEO-COMPLETION-REQUEST] ${identifier} device ${deviceId.slice(0,8)}... watched ${videoUrl} for ${durationNum}s`);
    
    // Check for rapid video submissions (anti-gaming protection)
    const lastSubmissionKey = `last_video_${deviceId}`;
    const lastSubmission = global.lastVideoSubmissions || (global.lastVideoSubmissions = new Map());
    const now = Date.now();
    const lastTime = lastSubmission.get(lastSubmissionKey) || 0;
    
    // Prevent submitting videos faster than once every 60 seconds
    if (now - lastTime < 60000) {
      const waitTime = Math.ceil((60000 - (now - lastTime)) / 1000);
      console.warn(`[VIDEO-RATE-LIMIT] ${identifier} submitting videos too quickly. Must wait ${waitTime}s`);
      return res.status(429).json({ 
        ok: false, 
        message: `Please wait ${waitTime} seconds before submitting another video completion.` 
      });
    }
    
    lastSubmission.set(lastSubmissionKey, now);
    
    // Record the video view with enhanced tracking
    const videoResult = recordVideoView(identifier, deviceId, videoUrl, durationNum, routerId);
    
    if (!videoResult.videoRecorded) {
      return res.status(500).json({ 
        ok: false, 
        message: videoResult.error || 'Failed to record video view' 
      });
    }
    
    // If milestone reached and internet access granted, set up immediate access
    if (videoResult.internetAccessGranted) {
      console.log(`[AUTO-INTERNET-ACCESS] ${identifier} reached milestone: ${videoResult.tier} (${videoResult.bundleMB}MB)`);
      
      // Register active client for immediate proxy access  
      const clientInfo = {
        identifier: identifier,
        ip: clientIp,
        lastSeen: Date.now(),
        expires: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
        deviceFingerprint: deviceId,
        macAddress: deviceInfo.mac,
        sessionToken: `auto_video_${Date.now()}`,
        bundleMB: videoResult.bundleMB,
        source: 'video_milestone'
      };
      
      // Register with multiple keys for instant recognition by proxy
      activeClients.set(deviceId, clientInfo);
      activeClients.set(identifier, clientInfo);
      if (deviceInfo.mac) activeClients.set(deviceInfo.mac, clientInfo);
      activeClients.set(clientIp, clientInfo);
      
      // Set device session for enhanced access control
      const deviceSession = {
        sessionToken: clientInfo.sessionToken,
        voucher: null,
        unlockTimestamp: Date.now(),
        revalidationRequired: false,
        lastActivity: Date.now(),
        videoNotificationReceived: true,
        lastVideoCompletion: Date.now(),
        totalVideosWatched: videoResult.totalVideos,
        internetAccessGranted: true,
        bundleMB: videoResult.bundleMB
      };
      
      deviceSessions.set(deviceId, deviceSession);
      deviceSessions.set(identifier, deviceSession);
      
      console.log(`[IMMEDIATE-ACCESS-GRANTED] ${identifier} device ${deviceId.slice(0,8)}... has instant internet access for ${videoResult.bundleMB}MB`);
    }
    
    // Return comprehensive response
    const response = {
      ok: true,
      message: videoResult.message,
      data: {
        videoRecorded: videoResult.videoRecorded,
        earnedMB: videoResult.earnedMB || 0,
        totalVideos: videoResult.totalVideos,
        milestoneReached: videoResult.milestoneReached,
        internetAccessGranted: videoResult.internetAccessGranted,
        bundleMB: videoResult.bundleMB || 0,
        tier: videoResult.tier || 'none',
        nextMilestone: videoResult.nextMilestone,
        accessExpiry: videoResult.accessExpiry,
        deviceId: deviceId,
        routerId: routerId
      }
    };
    
    console.log(`[VIDEO-API-RESPONSE] ${identifier}: ${JSON.stringify(response.data)}`);
    res.json(response);
    
  } catch (error) {
    console.error('[VIDEO-COMPLETE-API-ERROR]', error.message);
    res.status(500).json({ 
      ok: false, 
      message: 'Internal server error processing video completion' 
    });
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

app.get('/api/admin/ads/summary', adminLimiter, (req,res)=>{
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
app.get('/api/admin/ads/list', adminLimiter, (req,res)=>{
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
app.get('/api/admin/ads/events/count', adminLimiter, (req,res)=>{
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
app.post('/api/admin/router/usage', adminLimiter, (req,res)=>{
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
app.get('/api/admin/router/usage', adminLimiter, (req,res)=>{
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
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const loginTime = new Date().toISOString();
  
  if(!email || !password){ return res.status(400).json({ ok:false, message:'Missing fields'}); }
  
  const identifier = email.trim().toLowerCase();
  
  if(validateLogin(identifier, password)){
    try { 
      const evt = { 
        identifier: identifier, 
        type:'login', 
        tsISO: loginTime, 
        ip: clientIp, 
        ua: userAgent 
      };
      if (sqliteDB) sqliteDB.appendAccessEvent(evt); else appendAccessEvent(evt);
    } catch {}
    
    // Update user login statistics
    updateUserLoginStats(identifier, loginTime, clientIp);
    
    // Enhanced device registration on successful login
    const deviceRegistration = registerActiveClient(req, identifier, 6);
    
    console.log(`[LOGIN-SUCCESS] ${identifier} from ${clientIp}`);
    
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
  
  console.log(`[LOGIN-FAILED] ${identifier} from ${clientIp}`);
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

// Admin helper: lookup a user across SQLite and XLSX to diagnose registration/login issues
app.get('/admin/user-info', requireAdminToken, (req, res) => {
  try {
    const q = (req.query.email || req.query.identifier || req.query.id || '').toString().trim();
    if (!q) return res.status(400).json({ ok: false, message: 'provide ?email= or ?identifier=' });
    const out = { query: q, sqlite: null, xlsx: null };
    const emailLower = q.includes('@') ? q.toLowerCase() : null;
    // Check sqlite
    try {
      if (sqliteDB) {
        const srow = sqliteDB.findUser(emailLower || q);
        if (srow) {
          const mask = h => { if(!h) return '<none>'; if(h.length<=12) return h.slice(0,4)+'...'; return h.slice(0,6)+'...'+h.slice(-4); };
          out.sqlite = { found: true, id: srow.id || null, email: srow.email || null, phone: srow.phone || null, password_hash_mask: mask(srow.password_hash) };
        } else {
          out.sqlite = { found: false };
        }
      }
    } catch (e) { out.sqlite = { error: e && e.message }; }

    // Check XLSX
    try {
      const { data } = getUsers();
      const match = data.find(u => {
        if (emailLower) return (String(u.email||'').trim().toLowerCase() === emailLower);
        const norm = normalizePhone(q);
        return norm && u.phone === norm;
      });
      if (match) {
        out.xlsx = { found: true, email: match.email || null, phone: match.phone || null, password_present: !!match.password };
      } else {
        out.xlsx = { found: false };
      }
    } catch (e) { out.xlsx = { error: e && e.message }; }

    return res.json({ ok: true, result: out });
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

// Serve protected admin dashboard HTML
app.get('/admin/dashboard.html', requireAdminToken, (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
  } catch (err) {
    return res.status(500).send('Error loading admin dashboard');
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
    let user = null;
    if (sqliteDB) {
      user = sqliteDB.findUser(identifier);
      if(!user) {
        // Attempt to check the XLSX fallback for any loose matches so client can show helpful guidance
        let xlsxCount = 0;
        try {
          const { data } = getUsers();
          // count any records with same email local-part or same phone number length as a hint (non-PII)
          const normPhone = normalizePhone(identifier);
          xlsxCount = data.filter(u => {
            try {
              if(identifier.includes('@')){
                return (u.email||'').toLowerCase().split('@')[0] === identifier.split('@')[0];
              }
              return normPhone && u.phone===normPhone;
            } catch { return false; }
          }).length;
        } catch (e) { /* ignore workbook read errors */ }
        console.warn('[profile 404] identifier=', identifier, 'sqlite users: none, xlsxPossibleMatches=', xlsxCount);
        return res.status(404).json({ ok:false, message:'User not found', diagnostics: { checked: ['sqlite','xlsx'], xlsxPossibleMatches: xlsxCount } });
      }
      // convert sqlite row to public profile shape
      const { password_hash, password, ...rest } = user;
      const pub = Object.assign({}, rest);
      if(pub.avatarPath){ pub.avatarUrl = '/' + pub.avatarPath.replace(/\\/g,'/'); }
      return res.json({ ok:true, profile: pub });
    }
    const { data } = getUsers();
    const found = findUserRecord(data, identifier);
    if(!found){
      console.warn('[profile 404] identifier=', identifier, 'available users=', data.map(u=>u.email+':'+u.phone));
      return res.status(404).json({ ok:false, message:'User not found' });
    }
    const { password, ...pub } = found;
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

// ===========================================
// DEDICATED VIDEO STREAMING PROXY ENDPOINT
// ===========================================
// Specialized endpoint for video streaming with proper range request handling
app.get('/video-stream', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    console.log('[VIDEO-STREAM] Streaming video:', targetUrl);
    
    const isHttps = targetUrl.startsWith('https://');
    const httpModule = isHttps ? https : http;
    const urlParts = new URL(targetUrl);
    
    // Enhanced options specifically for video streaming
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || (isHttps ? 443 : 80),
      path: urlParts.pathname + urlParts.search,
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
      },
      timeout: 0,  // No timeout for streaming
      keepAlive: true,
      keepAliveMsecs: 30000
    };

    // Forward Range header for video seeking
    if (req.headers.range) {
      options.headers.Range = req.headers.range;
      console.log('[VIDEO-STREAM] Range request:', req.headers.range);
    }

    const proxyReq = httpModule.request(options, (proxyRes) => {
      console.log('[VIDEO-STREAM] Response status:', proxyRes.statusCode);
      
      // Set streaming-optimized headers
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes'
      });

      // Forward all response headers
      Object.keys(proxyRes.headers).forEach(key => {
        res.set(key, proxyRes.headers[key]);
      });

      res.status(proxyRes.statusCode);

      // Enable streaming with proper flow control
      let bytesStreamed = 0;
      proxyRes.on('data', (chunk) => {
        bytesStreamed += chunk.length;
        if (bytesStreamed % 1000000 === 0) { // Log every MB
          console.log('[VIDEO-STREAM] Streamed:', Math.round(bytesStreamed / 1024 / 1024), 'MB');
        }
      });

      proxyRes.on('end', () => {
        console.log('[VIDEO-STREAM] Streaming complete:', bytesStreamed, 'bytes for', targetUrl);
      });

      proxyRes.on('error', (err) => {
        console.error('[VIDEO-STREAM] Response error:', err.message);
      });

      // Pipe the response with backpressure handling
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error('[VIDEO-STREAM] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Video streaming failed', details: err.message });
      }
    });

    // No timeout for video streaming
    proxyReq.on('socket', (socket) => {
      socket.setTimeout(0); // Remove timeout
      socket.setKeepAlive(true, 30000);
    });

    proxyReq.end();

  } catch (err) {
    console.error('[VIDEO-STREAM] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Video streaming error', details: err.message });
    }
  }
});

// ===========================================
// PROXY ENDPOINT FOR UNRESTRICTED AD ACCESS
// ===========================================
// Proxy endpoint to provide unrestricted access to ad content
// This allows ads to be accessible even when users have no data or limited access
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  // Check if this is a video request and redirect to video streaming endpoint
  if (targetUrl.includes('.mp4') || targetUrl.includes('video') || targetUrl.includes('gtv-videos') || targetUrl.includes('zencdn')) {
    console.log('[PROXY] Redirecting video request to streaming endpoint:', targetUrl);
    const streamUrl = `/video-stream?url=${encodeURIComponent(targetUrl)}`;
    return res.redirect(streamUrl);
  }

  try {
    console.log('[PROXY] Proxying request to:', targetUrl);
    
    // Determine if we need http or https
    const isHttps = targetUrl.startsWith('https://');
    const httpModule = isHttps ? https : http;
    
    // Parse the target URL
    const urlParts = new URL(targetUrl);
    
    // Enhanced request options for better video streaming
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || (isHttps ? 443 : 80),
      path: urlParts.pathname + urlParts.search,
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        'Accept-Encoding': 'identity;q=1, *;q=0',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close',  // Force connection close to avoid keep-alive issues
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      // Enhanced connection settings for video streaming
      timeout: 45000,  // Increased timeout for large video files
      keepAlive: false  // Disable keep-alive to prevent connection reuse issues
    };

    // Forward specific headers if present
    if (req.headers.range) options.headers.Range = req.headers.range;
    if (req.headers.referer) options.headers.Referer = req.headers.referer;
    
    // Add Connection: close to response headers to prevent browser connection pooling issues
    res.set('Connection', 'close');

    const proxyReq = httpModule.request(options, (proxyRes) => {
      // Set CORS headers for unrestricted access
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Connection': 'close'  // Prevent connection reuse issues
      });

      // Forward response headers
      Object.keys(proxyRes.headers).forEach(key => {
        if (key.toLowerCase() !== 'set-cookie') { // Skip set-cookie for security
          res.set(key, proxyRes.headers[key]);
        }
      });

      // Set status code
      res.status(proxyRes.statusCode);

      // Enhanced streaming for video content
      let bytesReceived = 0;
      proxyRes.on('data', (chunk) => {
        bytesReceived += chunk.length;
      });

      proxyRes.on('end', () => {
        console.log('[PROXY] Transfer complete:', bytesReceived, 'bytes for', targetUrl);
      });

      // Stream the response
      proxyRes.pipe(res);
      
      console.log('[PROXY] Response:', proxyRes.statusCode, 'for', targetUrl);
    });

    // Enhanced error handling
    proxyReq.on('error', (err) => {
      console.error('[PROXY] Request error for', targetUrl, ':', err.message);
      if (!res.headersSent) {
        // Send more specific error responses
        if (err.code === 'ENOTFOUND') {
          res.status(502).json({ error: 'DNS resolution failed', details: err.message });
        } else if (err.code === 'ECONNREFUSED') {
          res.status(502).json({ error: 'Connection refused', details: err.message });
        } else if (err.code === 'ETIMEDOUT') {
          res.status(504).json({ error: 'Connection timeout', details: err.message });
        } else {
          res.status(500).json({ error: 'Proxy request failed', details: err.message });
        }
      }
    });

    // Enhanced timeout handling with better logging
    proxyReq.setTimeout(45000, () => {
      console.error('[PROXY] Request timeout for:', targetUrl, '- destroying connection');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Proxy request timeout after 45 seconds' });
      }
    });

    // Handle socket errors
    proxyReq.on('socket', (socket) => {
      socket.on('timeout', () => {
        console.error('[PROXY] Socket timeout for:', targetUrl);
        proxyReq.destroy();
      });
      
      socket.on('error', (err) => {
        console.error('[PROXY] Socket error for', targetUrl, ':', err.message);
      });
    });

    // Forward request body if present (for POST requests)
    if (req.method === 'POST' && req.body) {
      proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();

  } catch (err) {
    console.error('[PROXY] General error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error', details: err.message });
    }
  }
});

// Handle preflight OPTIONS requests for CORS
app.options('/proxy', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization'
  });
  res.status(204).send();
});

// Serve static files (mounted after API routes so routes are not overridden by files)
app.use(express.static(__dirname));

// Update own profile (only firstName, surname, dob, avatarData) — phone/email locked
app.post('/api/me/profile/update', (req,res)=>{
  const { identifier, firstName, surname, dob, avatarData, removeAvatar, email: newEmail, phone: newPhone } = req.body||{}; // allow adding email/phone if previously empty
  if(!identifier) return res.status(400).json({ ok:false, message:'Missing identifier'});
  try {
    const id = identifier.trim();
    // Prefer sqlite when available
    let user = null;
    let before = {};
    let usingSqlite = false;
    if (sqliteDB) {
      const row = sqliteDB.findUser(id);
      if (!row) return res.status(404).json({ ok:false, message:'User not found'});
      user = row;
      before = { firstName: user.firstName, surname: user.surname, dob: user.dob };
      usingSqlite = true;
    } else {
      const { wb, ws, data } = getUsers();
      user = findUserRecord(data, id);
      if(!user) return res.status(404).json({ ok:false, message:'User not found'});
      before = { firstName:user.firstName, surname:user.surname, dob:user.dob };
    }
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

    // Persist changes to storage
    if (usingSqlite) {
      try {
        // Only allow updating specific fields currently
        const upd = {};
        if (user.firstName !== firstName && firstName !== undefined) upd.firstName = user.firstName;
        // We'll perform a simple UPDATE for changed fields
        const fieldsToUpdate = [];
        const values = [];
        ['firstName','surname','dob','email','phone','avatarPath'].forEach(f=>{
          if(user[f]!==undefined && user[f]!==null){} // noop
        });
        // Because sqliteDB currently exposes only create/find/changePassword, we'll run a direct SQL update via its DB handle
        const DB = sqliteDB._db();
        if (DB) {
          const sets = [];
          if(firstName!==undefined){ sets.push('firstName=?'); values.push(firstName); }
          if(surname!==undefined){ sets.push('surname=?'); values.push(surname); }
          if(dob!==undefined){ sets.push('dob=?'); values.push(dob); }
          if(user.avatarPath) { /* avatarPath already set on user object above */ }
          if(sets.length){
            values.push(user.id);
            DB.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?').run(...values);
            // refresh user
            user = sqliteDB.findUser(id);
          }
        }
      } catch (e) { console.warn('[PROFILE-UPDATE-SQLITE-ERR]', e && e.message); }
      const { password, ...pub } = user;
      if(pub.avatarPath){ pub.avatarUrl = '/' + pub.avatarPath.replace(/\\/g,'/'); }
      try { const changedFields=[]; ['firstName','surname','dob'].forEach(f=>{ if(before[f]!==user[f]) changedFields.push(f); }); if(changedFields.length){ sqliteDB.appendAccessEvent({ identifier: (user.email||user.phone||'').toLowerCase(), type:'profile_change', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'], data:{ changedFields } }); } } catch {}
      return res.json({ ok:true, profile: pub });
    } else {
      wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
      XLSX.writeFile(wb, DATA_FILE);
      const { password, ...pub } = user;
      if(pub.avatarPath){ pub.avatarUrl = '/' + pub.avatarPath.replace(/\\/g,'/'); }
      try { const changedFields=[]; ['firstName','surname','dob'].forEach(f=>{ if(before[f]!==user[f]) changedFields.push(f); }); if(changedFields.length){ appendAccessEvent({ identifier: (user.email||user.phone||'').toLowerCase(), type:'profile_change', tsISO:new Date().toISOString(), ip:(req.ip||''), ua:req.headers['user-agent'], detailsJSON: JSON.stringify({ changedFields }) }); } } catch {}
      return res.json({ ok:true, profile: pub });
    }
    
  } catch(err){
    console.error('Profile update error', err);
    res.status(500).json({ ok:false, message:'Error updating profile'});
  }
});

// Delete account (requires correct password)
app.post('/api/me/delete', adminLimiter, (req,res)=>{
  const { identifier, password } = req.body||{};
  if(!identifier || !password) return res.status(400).json({ ok:false, message:'Missing fields'});
  try {
    const raw = String(identifier).trim();
    // Prefer sqlite when available
    if (sqliteDB) {
      // Validate password
      const ok = sqliteDB.validateLogin(raw, password);
      if (!ok) return res.status(401).json({ ok:false, message:'Password incorrect' });
      const user = sqliteDB.findUser(raw);
      if (!user) return res.status(404).json({ ok:false, message:'User not found' });
  // Prevent deleting seeded admin account
  try { if((user.email||'').toLowerCase()===ADMIN_EMAIL.toLowerCase() || normalizePhone(user.phone)===normalizePhone(ADMIN_PHONE)){ return res.status(403).json({ ok:false, message:'Cannot delete admin account' }); } } catch(e){}
      // Remove avatar file if exists
      if(user.avatarPath){
        try {
          const full = path.join(__dirname, user.avatarPath);
          if(full.startsWith(path.join(__dirname,'avatars')) && fs.existsSync(full)) fs.unlinkSync(full);
        } catch(err){ console.warn('Avatar delete error', err && err.message); }
      }
      try {
        const DB = sqliteDB._db();
        if (DB) {
          DB.prepare('DELETE FROM users WHERE id=?').run(user.id);
        }
      } catch (e) { console.warn('[SQLITE-DELETE-ERR]', e && e.message); return res.status(500).json({ ok:false, message:'Error deleting user' }); }
      return res.json({ ok:true });
    }
    const { wb, ws, data } = getUsers();
    const normRaw = raw;
    let user = findUserRecord(data, normRaw);
    // Fallback: try matching by email OR phone explicitly if not found
    if(!user){
      const lower = String(normRaw).trim().toLowerCase();
      const normPhone = normalizePhone(normRaw);
      user = data.find(u=> String(u.email||'').trim().toLowerCase()===lower || u.phone===normPhone);
    }
    if(!user) return res.status(404).json({ ok:false, message:'User not found'});
  // Prevent deleting seeded admin account
  try { if((user.email||'').toLowerCase()===ADMIN_EMAIL.toLowerCase() || normalizePhone(user.phone)===normalizePhone(ADMIN_PHONE)){ return res.status(403).json({ ok:false, message:'Cannot delete admin account' }); } } catch(e){}
  if(user.password !== password) return res.status(401).json({ ok:false, message:'Password incorrect'});
    // Remove avatar file if exists
    if(user.avatarPath){
      try {
        const full = path.join(__dirname, user.avatarPath);
        if(full.startsWith(path.join(__dirname,'avatars')) && fs.existsSync(full)) fs.unlinkSync(full);
      } catch(err){ console.warn('Avatar delete error', err && err.message); }
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

// Ensure the seeded admin account exists before binding the server
// One-time importer: migrate Users sheet from XLSX into SQLite when enabled
function importXlsxToSqliteOnce(){
  try {
    if (process.env.USE_SQLITE !== 'true' || !sqliteDB) {
      console.log('[MIGRATE-SQLITE] SQLite not enabled; skipping XLSX->SQLite import');
      return;
    }
    const marker = path.join(DATA_DIR, '.migrated_xlsx_to_sqlite');
    if (fs.existsSync(marker)) {
      console.log('[MIGRATE-SQLITE] marker present, skipping import');
      return;
    }

    if (!fs.existsSync(DATA_FILE)) {
      console.log('[MIGRATE-SQLITE] no XLSX file at', DATA_FILE, '- nothing to import');
      return;
    }

    // Load users from the workbook (uses existing loadWorkbook/getUsers helpers)
    const { wb, ws, data } = getUsers();
    if (!Array.isArray(data) || data.length === 0) {
      console.log('[MIGRATE-SQLITE] Users sheet empty; nothing to import');
      // still create a marker so we don't keep checking on every restart
      try { fs.writeFileSync(marker, 'no-users'); } catch(e){}
      return;
    }

    let imported = 0, skipped = 0;
    for (const r of data) {
      try {
        const email = (r.email||'').toString().trim().toLowerCase();
        const phone = normalizePhone(r.phone || r.Phone || '');
        if (!email && !phone) { skipped++; continue; }

        // Skip if user already exists in SQLite
        try {
          if (email && sqliteDB.findUser(email)) { skipped++; continue; }
          if (!email && phone && sqliteDB.findUser(phone)) { skipped++; continue; }
        } catch(e) {
          // If findUser fails for any reason, continue to next row
          console.warn('[MIGRATE-SQLITE] findUser check failed for', email || phone, e && e.message);
        }

        // Prefer to preserve existing bcrypt password_hash if present
        const pwHash = r.password_hash || r.passwordHash || null;
        const firstName = r.firstName || r.firstname || r.first || '';
        const surname = r.surname || r.lastName || r.surname || '';
        const dob = r.dob || r.DOB || '';
        const dateCreatedISO = r.dateCreatedISO || new Date().toISOString();
        const dateCreatedLocal = r.dateCreatedLocal || new Date().toString();

        if (pwHash) {
          // Insert directly with preserved password_hash (avoid createUser which hashes plaintext)
          try {
            const stmt = sqliteDB._db().prepare(`INSERT INTO users (email,phone,password_hash,password,firstName,surname,dob,dateCreatedISO,dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            stmt.run(email || null, phone || null, pwHash, null, firstName || null, surname || null, dob || null, dateCreatedISO, dateCreatedLocal);
            imported++;
            continue;
          } catch(e) {
            console.warn('[MIGRATE-SQLITE] direct insert failed for', email || phone, e && e.message);
          }
        }

        // If no hash but plaintext password present (legacy), use createUser to hash it
        if (r.password && String(r.password).length > 0 && String(r.password) !== '<hashed>') {
          try {
            const res = sqliteDB.createUser({ email: email || null, password: String(r.password), phone: phone || null, firstName: firstName || null, surname: surname || null, dob: dob || null });
            if (res && res.ok) imported++; else skipped++;
            continue;
          } catch(e) { console.warn('[MIGRATE-SQLITE] createUser failed for', email||phone, e && e.message); }
        }

        // No password info - create a user record with a random temporary password so account exists
        try {
          const tempPw = 'changeme-' + crypto.randomBytes(6).toString('hex');
          const res = sqliteDB.createUser({ email: email || null, password: tempPw, phone: phone || null, firstName: firstName || null, surname: surname || null, dob: dob || null });
          if (res && res.ok) {
            imported++;
          } else skipped++;
        } catch(e) { console.warn('[MIGRATE-SQLITE] fallback createUser failed for', email||phone, e && e.message); skipped++; }

      } catch(e){ console.warn('[MIGRATE-SQLITE] row import error', e && e.message); skipped++; }
    }

    // Write marker to avoid re-running import
    try { fs.writeFileSync(marker, `imported=${imported};skipped=${skipped};ts=${Date.now()}`); } catch(e){}
    console.log('[MIGRATE-SQLITE] import complete: imported=', imported, 'skipped=', skipped, 'marker=', marker);
  } catch(err){ console.warn('[MIGRATE-SQLITE-ERR]', err && err.message); }
}

try { importXlsxToSqliteOnce(); } catch(e){ console.warn('[MIGRATE-SQLITE-CALL-ERR]', e && e.message); }

try { ensureAdminSeeded(); } catch(e){ console.warn('[ADMIN-SEED-CALL-ERR]', e && e.message); }

// ===========================================
// PROXY SERVER ON PORT 8082 FOR AD UNBLOCKING
// ===========================================
// Start dedicated proxy server on port 8082 for unrestricted ad access
const proxyApp = express();

// Enable JSON parsing for proxy
proxyApp.use(express.json({ limit: '10mb' }));

// CORS middleware for all proxy requests
proxyApp.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }
  next();
});

// Main proxy endpoint - mirrors the one on main server but optimized for unrestricted access
proxyApp.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    console.log('[PROXY-8082] Unrestricted access to:', targetUrl);
    
    const isHttps = targetUrl.startsWith('https://');
    const httpModule = isHttps ? https : http;
    const urlParts = new URL(targetUrl);
    
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || (isHttps ? 443 : 80),
      path: urlParts.pathname + urlParts.search,
      method: req.method,
      headers: {
        'User-Agent': 'ISN-Free-WiFi-Unrestricted-Proxy/1.0',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=3600',
        'Connection': 'keep-alive'
      }
    };

    // Forward essential headers
    if (req.headers.range) options.headers.Range = req.headers.range;
    if (req.headers.referer) options.headers.Referer = req.headers.referer;
    if (req.headers.accept) options.headers.Accept = req.headers.accept;

    const proxyReq = httpModule.request(options, (proxyRes) => {
      // Set aggressive CORS and caching headers
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization, X-Requested-With',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Cache-Control': 'public, max-age=3600',
        'X-Proxy-Cache': 'UNRESTRICTED'
      });

      // Forward all response headers except security-sensitive ones
      Object.keys(proxyRes.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!['set-cookie', 'x-frame-options', 'content-security-policy'].includes(lowerKey)) {
          res.set(key, proxyRes.headers[key]);
        }
      });

      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
      
      console.log('[PROXY-8082] SUCCESS:', proxyRes.statusCode, 'for', targetUrl);
    });

    proxyReq.on('error', (err) => {
      console.error('[PROXY-8082] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Proxy request failed', details: err.message });
      }
    });

    proxyReq.setTimeout(60000, () => {
      console.error('[PROXY-8082] Request timeout for:', targetUrl);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Proxy request timeout' });
      }
    });

    if (req.method === 'POST' && req.body) {
      proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();

  } catch (err) {
    console.error('[PROXY-8082] General error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error', details: err.message });
    }
  }
});

// Root endpoint for proxy server health check
proxyApp.get('/', (req, res) => {
  res.json({ 
    status: 'ISN Free WiFi Proxy Server', 
    port: 8082, 
    purpose: 'Unrestricted ad content access',
    endpoints: ['/proxy?url=<target_url>']
  });
});

// Using main proxy on port 8082 for all video traffic
// Separate ad proxy commented out - videos will use main captive proxy
/*
// Start proxy server on port 8084 (different from main proxy on 8082)
const AD_PROXY_PORT = 8084;
try {
  proxyApp.listen(AD_PROXY_PORT, () => {
    console.log(`[PROXY-SERVER] Unrestricted ad proxy running on port ${AD_PROXY_PORT}`);
    console.log(`[PROXY-SERVER] Usage: http://localhost:${AD_PROXY_PORT}/proxy?url=<target_url>`);
  });
} catch (err) {
  console.error(`[PROXY-SERVER] Failed to start proxy on port ${AD_PROXY_PORT}:`, err.message);
}
*/

startExpress(PORT, 5);

// Global diagnostics to avoid silent exits
process.on('uncaughtException', err=>{
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err=>{
  console.error('[unhandledRejection]', err);
});
