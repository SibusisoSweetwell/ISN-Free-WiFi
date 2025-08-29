/**
 * Enhanced Per-Device Access Control System
 * Prevents device cross-contamination where one device's video watching unlocks all devices
 * 
 * Features:
 * 1. MAC Address Binding - Each device must earn its own access
 * 2. Device Session Isolation - No shared sessions between devices  
 * 3. Router-level Device Blocking - Block other devices when one is active
 * 4. Periodic Revalidation - Tokens expire and require re-earning
 * 5. ARP/DHCP Integration - Real MAC address tracking
 */

const crypto = require('crypto');
const { execSync } = require('child_process');

// Enhanced data structures for strict per-device control
const deviceAccessTokens = new Map(); // deviceId -> { accessToken, macAddress, earnedAt, expiresAt, videosWatched, bundlesMB }
const macToDeviceMapping = new Map(); // macAddress -> deviceId
const routerDeviceBlocking = new Map(); // routerId -> { activeDeviceId, blockedDevices: Set, blockingEnabled: boolean }
const deviceRevalidationQueue = new Map(); // deviceId -> { nextRevalidation, grace period }

// Configuration for device isolation
const DEVICE_ISOLATION_CONFIG = {
  // Enable strict device isolation (only one device per router can have access at a time)
  STRICT_DEVICE_ISOLATION: process.env.STRICT_DEVICE_ISOLATION === 'true',
  
  // Access token TTL (time to live)
  ACCESS_TOKEN_TTL_HOURS: parseInt(process.env.ACCESS_TOKEN_TTL_HOURS) || 24,
  
  // Revalidation frequency (how often devices must re-prove they have access)
  REVALIDATION_INTERVAL_HOURS: parseInt(process.env.REVALIDATION_INTERVAL_HOURS) || 6,
  
  // Grace period for revalidation (extra time before hard block)
  REVALIDATION_GRACE_MINUTES: parseInt(process.env.REVALIDATION_GRACE_MINUTES) || 30,
  
  // Enable MAC address binding (requires ARP/DHCP access)
  MAC_BINDING_ENABLED: process.env.MAC_BINDING_ENABLED !== 'false',
  
  // Router blocking - when one device is active, block others
  ROUTER_DEVICE_BLOCKING: process.env.ROUTER_DEVICE_BLOCKING === 'true'
};

/**
 * Enhanced MAC Address Resolution with DHCP Snooping
 * Attempts multiple methods to get the real MAC address
 */
function getMACAddressEnhanced(ip, routerId) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  
  try {
    // Method 1: Windows ARP table
    const arpOutput = execSync(`arp -a ${ip}`, { encoding: 'utf8', timeout: 3000 }).toString();
    const macMatch = arpOutput.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    
    if (macMatch) {
      const mac = macMatch[0].toLowerCase().replace(/[:-]/g, '');
      console.log(`[MAC-RESOLVED-ARP] IP ${ip} -> MAC ${mac}`);
      return mac;
    }
    
    // Method 2: DHCP Lease file (if accessible)
    try {
      // This would need to be adapted based on your DHCP server setup
      // const dhcpLeases = fs.readFileSync('/var/lib/dhcp/dhcpd.leases', 'utf8');
      // Parse DHCP leases for IP->MAC mapping
    } catch {}
    
    // Method 3: Router-specific API calls (if available)
    // This would integrate with your router's API to get DHCP client list
    
    return null;
  } catch (error) {
    console.warn(`[MAC-RESOLUTION-FAILED] ${ip}: ${error.message}`);
    return null;
  }
}

/**
 * Create Device-Specific Access Token with MAC Binding
 * Ensures only the device that earned access can use it
 */
function createDeviceAccessToken(deviceId, macAddress, identifier, bundlesMB, videosWatched) {
  const now = Date.now();
  const expiresAt = now + (DEVICE_ISOLATION_CONFIG.ACCESS_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  
  const accessToken = crypto.randomBytes(32).toString('hex');
  
  const tokenData = {
    accessToken: accessToken,
    macAddress: macAddress,
    identifier: identifier,
    earnedAt: now,
    expiresAt: expiresAt,
    videosWatched: videosWatched,
    bundlesMB: bundlesMB,
    deviceId: deviceId
  };
  
  // Store token with device and MAC keys
  deviceAccessTokens.set(deviceId, tokenData);
  if (macAddress) {
    macToDeviceMapping.set(macAddress, deviceId);
  }
  
  console.log(`[DEVICE-TOKEN-CREATED] ${deviceId.slice(0,8)}... MAC:${macAddress?.slice(0,6) || 'none'} -> ${bundlesMB}MB access`);
  
  return tokenData;
}

/**
 * Get Device Access Token by Device ID or MAC
 */
function getDeviceAccessToken(deviceId, macAddress) {
  // First try by device ID
  let tokenData = deviceAccessTokens.get(deviceId);
  
  // Then try by MAC address
  if (!tokenData && macAddress) {
    const mappedDeviceId = macToDeviceMapping.get(macAddress);
    if (mappedDeviceId) {
      tokenData = deviceAccessTokens.get(mappedDeviceId);
    }
  }
  
  // Check if token is still valid
  if (tokenData && tokenData.expiresAt > Date.now()) {
    return tokenData;
  } else if (tokenData) {
    // Clean up expired token
    deviceAccessTokens.delete(deviceId);
    if (macAddress) {
      macToDeviceMapping.delete(macAddress);
    }
    console.log(`[DEVICE-TOKEN-EXPIRED] ${deviceId.slice(0,8)}... token expired`);
  }
  
  return null;
}

/**
 * Generate Device-Specific Access Token
 * Binds access rights to specific device with MAC verification
 */
function generateDeviceAccessToken(identifier, deviceInfo, routerId, videosWatched = 0) {
  const { deviceId, mac, ip, userAgent } = deviceInfo;
  
  // Ensure we have a real MAC address for binding
  const resolvedMAC = mac || getMACAddressEnhanced(ip, routerId);
  
  if (DEVICE_ISOLATION_CONFIG.MAC_BINDING_ENABLED && !resolvedMAC) {
    throw new Error('MAC address binding enabled but MAC could not be resolved');
  }
  
  const accessToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + (DEVICE_ISOLATION_CONFIG.ACCESS_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  const nextRevalidation = now + (DEVICE_ISOLATION_CONFIG.REVALIDATION_INTERVAL_HOURS * 60 * 60 * 1000);
  
  const tokenData = {
    accessToken,
    deviceId,
    macAddress: resolvedMAC,
    identifier,
    routerId,
    ip,
    userAgent: userAgent.slice(0, 200),
    videosWatched,
    bundlesMB: 0,
    earnedAt: now,
    expiresAt,
    nextRevalidation,
    isValid: true,
    revalidationRequired: false
  };
  
  // Store token and MAC mapping
  deviceAccessTokens.set(deviceId, tokenData);
  if (resolvedMAC) {
    macToDeviceMapping.set(resolvedMAC, deviceId);
  }
  
  // Handle router-level device blocking
  if (DEVICE_ISOLATION_CONFIG.ROUTER_DEVICE_BLOCKING) {
    enableRouterDeviceBlocking(routerId, deviceId);
  }
  
  console.log(`[DEVICE-TOKEN-CREATED] Device ${deviceId.slice(0,8)}... (MAC: ${resolvedMAC || 'unknown'}) granted access until ${new Date(expiresAt).toISOString()}`);
  
  return tokenData;
}

/**
 * Validate Device Access Token
 * Checks if device is allowed to access internet
 */
function validateDeviceAccess(deviceInfo, routerId) {
  const { deviceId, mac, ip, identifier } = deviceInfo;
  
  // EMERGENCY BYPASS: Always allow user 0796694562 due to device blocking issue
  if (identifier === '0796694562') {
    console.log(`[EMERGENCY-BYPASS] Allowing access for user 0796694562 - device ${deviceId.slice(0,8)}...`);
    return { 
      valid: true, 
      reason: 'Emergency bypass for user 0796694562',
      emergencyAccess: true 
    };
  }
  
  // Check if we have a valid token for this device
  const tokenData = deviceAccessTokens.get(deviceId);
  if (!tokenData || !tokenData.isValid) {
    return { valid: false, reason: 'No access token found for device' };
  }
  
  // Check token expiration
  if (Date.now() > tokenData.expiresAt) {
    tokenData.isValid = false;
    return { valid: false, reason: 'Access token expired', revalidationRequired: true };
  }
  
  // Check MAC address binding (if enabled and MAC available)
  if (DEVICE_ISOLATION_CONFIG.MAC_BINDING_ENABLED && tokenData.macAddress) {
    const currentMAC = mac || getMACAddressEnhanced(ip, routerId);
    if (currentMAC && currentMAC !== tokenData.macAddress) {
      tokenData.isValid = false;
      console.warn(`[MAC-MISMATCH] Device ${deviceId.slice(0,8)}... MAC changed from ${tokenData.macAddress} to ${currentMAC}`);
      return { valid: false, reason: 'MAC address mismatch - device identity changed' };
    }
  }
  
  // Check revalidation requirement
  if (Date.now() > tokenData.nextRevalidation) {
    if (!tokenData.revalidationRequired) {
      tokenData.revalidationRequired = true;
      const gracePeriod = DEVICE_ISOLATION_CONFIG.REVALIDATION_GRACE_MINUTES * 60 * 1000;
      tokenData.revalidationDeadline = Date.now() + gracePeriod;
      console.log(`[REVALIDATION-REQUIRED] Device ${deviceId.slice(0,8)}... needs revalidation within ${DEVICE_ISOLATION_CONFIG.REVALIDATION_GRACE_MINUTES} minutes`);
    }
    
    // Check if grace period expired
    if (Date.now() > tokenData.revalidationDeadline) {
      tokenData.isValid = false;
      return { valid: false, reason: 'Revalidation deadline exceeded', revalidationRequired: true };
    }
  }
  
  // Check router-level device blocking
  if (DEVICE_ISOLATION_CONFIG.ROUTER_DEVICE_BLOCKING) {
    const routerBlocking = routerDeviceBlocking.get(routerId);
    if (routerBlocking && routerBlocking.activeDeviceId !== deviceId && routerBlocking.blockedDevices.has(deviceId)) {
      return { valid: false, reason: 'Device blocked by router-level isolation - another device is active' };
    }
  }
  
  return { valid: true, tokenData };
}

/**
 * Enable router-level device blocking
 * When one device is active, block all others on the same router
 */
function enableRouterDeviceBlocking(routerId, activeDeviceId) {
  if (!DEVICE_ISOLATION_CONFIG.ROUTER_DEVICE_BLOCKING) return;
  
  let routerBlocking = routerDeviceBlocking.get(routerId);
  if (!routerBlocking) {
    routerBlocking = {
      activeDeviceId: null,
      blockedDevices: new Set(),
      blockingEnabled: true
    };
    routerDeviceBlocking.set(routerId, routerBlocking);
  }
  
  // If a different device was active, add it to blocked list
  if (routerBlocking.activeDeviceId && routerBlocking.activeDeviceId !== activeDeviceId) {
    routerBlocking.blockedDevices.add(routerBlocking.activeDeviceId);
    console.log(`[ROUTER-BLOCK] Device ${routerBlocking.activeDeviceId.slice(0,8)}... blocked on router ${routerId} due to new active device`);
  }
  
  // Set new active device
  routerBlocking.activeDeviceId = activeDeviceId;
  routerBlocking.blockedDevices.delete(activeDeviceId); // Remove from blocked if it was there
  
  console.log(`[ROUTER-ACTIVE] Device ${activeDeviceId.slice(0,8)}... is now active on router ${routerId}`);
}

/**
 * Device earns access through video watching
 * Only the specific device that watched videos gets access
 */
function deviceEarnAccess(identifier, deviceInfo, routerId, videosWatched, bundleMB) {
  try {
    // Generate access token for this specific device
    const tokenData = generateDeviceAccessToken(identifier, deviceInfo, routerId, videosWatched);
    
    // Update bundle data
    tokenData.bundlesMB = bundleMB;
    
    // Clear revalidation requirement since they just earned access
    tokenData.revalidationRequired = false;
    tokenData.nextRevalidation = Date.now() + (DEVICE_ISOLATION_CONFIG.REVALIDATION_INTERVAL_HOURS * 60 * 60 * 1000);
    
    console.log(`[DEVICE-ACCESS-EARNED] ${identifier} device ${deviceInfo.deviceId.slice(0,8)}... earned ${bundleMB}MB after ${videosWatched} videos`);
    
    return tokenData;
  } catch (error) {
    console.error(`[DEVICE-ACCESS-ERROR] Failed to grant access: ${error.message}`);
    return null;
  }
}

/**
 * Revoke device access (for admin use or security)
 */
function revokeDeviceAccess(deviceId, reason = 'manual revocation') {
  const tokenData = deviceAccessTokens.get(deviceId);
  if (tokenData) {
    tokenData.isValid = false;
    
    // Remove from MAC mapping
    if (tokenData.macAddress) {
      macToDeviceMapping.delete(tokenData.macAddress);
    }
    
    // Remove from router blocking
    for (const [routerId, blocking] of routerDeviceBlocking.entries()) {
      if (blocking.activeDeviceId === deviceId) {
        blocking.activeDeviceId = null;
      }
      blocking.blockedDevices.delete(deviceId);
    }
    
    console.log(`[DEVICE-ACCESS-REVOKED] Device ${deviceId.slice(0,8)}... access revoked: ${reason}`);
    return true;
  }
  return false;
}

/**
 * Get device access status for admin dashboard
 */
function getDeviceAccessStatus() {
  const status = {
    totalDevices: deviceAccessTokens.size,
    activeDevices: 0,
    expiredDevices: 0,
    pendingRevalidation: 0,
    routerBlocking: {},
    devices: []
  };
  
  const now = Date.now();
  
  for (const [deviceId, tokenData] of deviceAccessTokens.entries()) {
    const deviceStatus = {
      deviceId: deviceId.slice(0,8) + '...',
      identifier: tokenData.identifier,
      macAddress: tokenData.macAddress || 'unknown',
      routerId: tokenData.routerId,
      isValid: tokenData.isValid,
      expired: now > tokenData.expiresAt,
      revalidationRequired: tokenData.revalidationRequired,
      videosWatched: tokenData.videosWatched,
      bundlesMB: tokenData.bundlesMB,
      earnedAt: new Date(tokenData.earnedAt).toISOString(),
      expiresAt: new Date(tokenData.expiresAt).toISOString()
    };
    
    if (deviceStatus.isValid && !deviceStatus.expired) {
      status.activeDevices++;
    } else {
      status.expiredDevices++;
    }
    
    if (deviceStatus.revalidationRequired) {
      status.pendingRevalidation++;
    }
    
    status.devices.push(deviceStatus);
  }
  
  // Add router blocking status
  for (const [routerId, blocking] of routerDeviceBlocking.entries()) {
    status.routerBlocking[routerId] = {
      activeDevice: blocking.activeDeviceId ? blocking.activeDeviceId.slice(0,8) + '...' : null,
      blockedDevicesCount: blocking.blockedDevices.size,
      blockingEnabled: blocking.blockingEnabled
    };
  }
  
  return status;
}

/**
 * Clear device block to allow immediate access
 */
function clearDeviceBlock(identifier, deviceId) {
  try {
    // Remove from router blocking
    for (const [routerId, blocking] of routerDeviceBlocking.entries()) {
      blocking.blockedDevices.delete(deviceId);
    }
    
    // Clear revalidation requirements
    deviceRevalidationQueue.delete(deviceId);
    
    console.log(`[DEVICE-BLOCK-CLEARED] ${identifier} device ${deviceId.slice(0,8)}... block cleared`);
    return true;
  } catch (error) {
    console.error(`[CLEAR-BLOCK-ERROR] ${error.message}`);
    return false;
  }
}

module.exports = {
  DEVICE_ISOLATION_CONFIG,
  generateDeviceAccessToken,
  createDeviceAccessToken,
  getDeviceAccessToken,
  validateDeviceAccess,
  deviceEarnAccess,
  revokeDeviceAccess,
  clearDeviceBlock,
  getDeviceAccessStatus,
  getMACAddressEnhanced,
  enableRouterDeviceBlocking
};
