// Real-Time Data Usage Monitoring & Quota Enforcement
// Tracks actual data usage through proxy and enforces video-earned limits

const fs = require('fs').promises;
const path = require('path');

class DataUsageTracker {
  constructor() {
    this.usageFile = path.join(__dirname, 'data-usage-tracking.json');
    this.deviceUsage = new Map(); // In-memory tracking
    this.quotaEnforcement = new Map(); // Active quota limits
    
    // Load existing usage data
    this.loadUsageData();
    
    // Auto-save every 30 seconds
    setInterval(() => this.saveUsageData(), 30000);
  }
  
  async loadUsageData() {
    try {
      const data = await fs.readFile(this.usageFile, 'utf8');
      const parsed = JSON.parse(data);
      
      // Restore device usage data
      Object.entries(parsed.deviceUsage || {}).forEach(([deviceId, usage]) => {
        this.deviceUsage.set(deviceId, usage);
      });
      
      // Restore quota enforcement data
      Object.entries(parsed.quotaEnforcement || {}).forEach(([deviceId, quota]) => {
        this.quotaEnforcement.set(deviceId, quota);
      });
      
      console.log('[DATA-TRACKER] Loaded usage data for', this.deviceUsage.size, 'devices');
    } catch (error) {
      console.log('[DATA-TRACKER] Starting with fresh usage data');
      await this.saveUsageData();
    }
  }
  
  async saveUsageData() {
    try {
      const data = {
        deviceUsage: Object.fromEntries(this.deviceUsage),
        quotaEnforcement: Object.fromEntries(this.quotaEnforcement),
        lastUpdated: new Date().toISOString()
      };
      
      await fs.writeFile(this.usageFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[DATA-TRACKER] Failed to save usage data:', error.message);
    }
  }
  
  // Initialize or update device quota based on videos watched
  setDeviceQuota(deviceId, earnedBundle) {
    const quota = {
      totalMB: earnedBundle.bundleMB,
      usedMB: this.getDeviceUsage(deviceId).totalMB,
      remainingMB: Math.max(0, earnedBundle.bundleMB - this.getDeviceUsage(deviceId).totalMB),
      tier: earnedBundle.tier,
      videosWatched: earnedBundle.videosWatched,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString() // 24 hours
    };
    
    this.quotaEnforcement.set(deviceId, quota);
    
    console.log('[DATA-TRACKER] Set quota for device:', {
      deviceId: deviceId.slice(0, 8) + '...',
      totalMB: quota.totalMB,
      remainingMB: quota.remainingMB,
      tier: quota.tier
    });
    
    return quota;
  }
  
  // Get current device usage
  getDeviceUsage(deviceId) {
    return this.deviceUsage.get(deviceId) || {
      totalMB: 0,
      sessionsCount: 0,
      firstAccess: null,
      lastAccess: null,
      dailyUsage: {}
    };
  }
  
  // Get device quota information
  getDeviceQuota(deviceId) {
    return this.quotaEnforcement.get(deviceId) || null;
  }
  
  // Record data usage for a device
  recordDataUsage(deviceId, bytesUsed, requestInfo = {}) {
    const mbUsed = bytesUsed / (1024 * 1024);
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Update device usage
    const usage = this.getDeviceUsage(deviceId);
    usage.totalMB += mbUsed;
    usage.sessionsCount += 1;
    usage.lastAccess = now.toISOString();
    
    if (!usage.firstAccess) {
      usage.firstAccess = now.toISOString();
    }
    
    // Track daily usage
    if (!usage.dailyUsage[today]) {
      usage.dailyUsage[today] = 0;
    }
    usage.dailyUsage[today] += mbUsed;
    
    this.deviceUsage.set(deviceId, usage);
    
    // Update quota remaining
    const quota = this.getDeviceQuota(deviceId);
    if (quota) {
      quota.usedMB = usage.totalMB;
      quota.remainingMB = Math.max(0, quota.totalMB - usage.totalMB);
      this.quotaEnforcement.set(deviceId, quota);
    }
    
    console.log('[DATA-TRACKER] Recorded usage:', {
      deviceId: deviceId.slice(0, 8) + '...',
      mbUsed: mbUsed.toFixed(3),
      totalMB: usage.totalMB.toFixed(1),
      remainingMB: quota ? quota.remainingMB.toFixed(1) : 'No quota',
      host: requestInfo.host || 'unknown'
    });
    
    return {
      usage,
      quota,
      exceededQuota: quota && usage.totalMB > quota.totalMB
    };
  }
  
  // Check if device has exceeded quota
  hasExceededQuota(deviceId) {
    const usage = this.getDeviceUsage(deviceId);
    const quota = this.getDeviceQuota(deviceId);
    
    if (!quota) {
      return { exceeded: true, reason: 'No quota assigned' };
    }
    
    // Check expiration
    if (new Date() > new Date(quota.expiresAt)) {
      return { exceeded: true, reason: 'Quota expired' };
    }
    
    // Check usage limit
    if (usage.totalMB > quota.totalMB) {
      return { 
        exceeded: true, 
        reason: 'Data limit exceeded',
        usedMB: usage.totalMB,
        limitMB: quota.totalMB,
        overageMB: usage.totalMB - quota.totalMB
      };
    }
    
    return { exceeded: false, quota, usage };
  }
  
  // Get quota status for display
  getQuotaStatus(deviceId) {
    const usage = this.getDeviceUsage(deviceId);
    const quota = this.getDeviceQuota(deviceId);
    const exceeded = this.hasExceededQuota(deviceId);
    
    return {
      deviceId,
      usage: {
        totalMB: Math.round(usage.totalMB * 100) / 100,
        sessionsCount: usage.sessionsCount,
        lastAccess: usage.lastAccess
      },
      quota: quota ? {
        totalMB: quota.totalMB,
        remainingMB: Math.round(quota.remainingMB * 100) / 100,
        tier: quota.tier,
        videosWatched: quota.videosWatched,
        expiresAt: quota.expiresAt
      } : null,
      status: {
        hasQuota: !!quota,
        exceeded: exceeded.exceeded,
        reason: exceeded.reason,
        percentUsed: quota ? Math.round((usage.totalMB / quota.totalMB) * 100) : 0
      }
    };
  }
  
  // Clean up expired quotas
  cleanupExpiredQuotas() {
    const now = new Date();
    let cleaned = 0;
    
    for (const [deviceId, quota] of this.quotaEnforcement.entries()) {
      if (new Date(quota.expiresAt) < now) {
        this.quotaEnforcement.delete(deviceId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log('[DATA-TRACKER] Cleaned up', cleaned, 'expired quotas');
    }
    
    return cleaned;
  }
  
  // Get summary statistics
  getSummaryStats() {
    const totalDevices = this.deviceUsage.size;
    const activeQuotas = this.quotaEnforcement.size;
    
    let totalDataUsed = 0;
    let totalSessions = 0;
    
    for (const usage of this.deviceUsage.values()) {
      totalDataUsed += usage.totalMB;
      totalSessions += usage.sessionsCount;
    }
    
    return {
      totalDevices,
      activeQuotas,
      totalDataUsedMB: Math.round(totalDataUsed * 100) / 100,
      totalSessions,
      averageUsagePerDevice: totalDevices > 0 ? Math.round((totalDataUsed / totalDevices) * 100) / 100 : 0
    };
  }
}

// Export singleton instance
const dataTracker = new DataUsageTracker();

// Clean up expired quotas every hour
setInterval(() => {
  dataTracker.cleanupExpiredQuotas();
}, 60 * 60 * 1000);

module.exports = dataTracker;
