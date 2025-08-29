/**
 * DATA TRACKING ENHANCEMENT MODULE
 * Provides accurate real-time data usage tracking and prevents duplicate bundles
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Real-time usage cache to prevent frequent file reads
const usageCache = new Map();
const cacheExpiry = 5000; // 5 seconds cache

class DataTracker {
    constructor() {
        this.dataFile = path.join(__dirname, 'logins.xlsx');
        this.lastCacheUpdate = new Map();
        this.sessionUsage = new Map(); // Track usage per session
    }

    /**
     * Get fresh usage data with proper error handling
     */
    getFreshUsageData(phoneNumber) {
        try {
            const cacheKey = phoneNumber;
            const now = Date.now();
            
            // Check cache first
            if (usageCache.has(cacheKey)) {
                const cached = usageCache.get(cacheKey);
                const lastUpdate = this.lastCacheUpdate.get(cacheKey) || 0;
                
                if (now - lastUpdate < cacheExpiry) {
                    return cached;
                }
            }

            // Read fresh data from file
            if (!fs.existsSync(this.dataFile)) {
                console.warn('[DATA-TRACKER] File not found:', this.dataFile);
                return { totalUsedMB: 0, totalBundleMB: 0, remainingMB: 0 };
            }

            const workbook = XLSX.readFile(this.dataFile);
            
            // Get purchases data
            let totalBundleMB = 0;
            if (workbook.SheetNames.includes('Purchases')) {
                const purchasesSheet = workbook.Sheets['Purchases'];
                const purchases = XLSX.utils.sheet_to_json(purchasesSheet);
                
                totalBundleMB = purchases
                    .filter(p => p.phone_number === phoneNumber)
                    .reduce((sum, p) => sum + (parseFloat(p.data_amount) || 0), 0);
            }

            // Get usage data
            let totalUsedMB = 0;
            if (workbook.SheetNames.includes('Usage')) {
                const usageSheet = workbook.Sheets['Usage'];
                const usageData = XLSX.utils.sheet_to_json(usageSheet);
                
                totalUsedMB = usageData
                    .filter(u => u.phone_number === phoneNumber)
                    .reduce((sum, u) => sum + (parseFloat(u.data_used) || 0), 0);
            }

            const remainingMB = Math.max(0, totalBundleMB - totalUsedMB);
            
            const result = {
                totalUsedMB: Math.round(totalUsedMB * 100) / 100,
                totalBundleMB: Math.round(totalBundleMB * 100) / 100,
                remainingMB: Math.round(remainingMB * 100) / 100,
                exhausted: remainingMB <= 0
            };

            // Update cache
            usageCache.set(cacheKey, result);
            this.lastCacheUpdate.set(cacheKey, now);

            return result;

        } catch (error) {
            console.error('[DATA-TRACKER] Error getting usage data:', error);
            return { totalUsedMB: 0, totalBundleMB: 0, remainingMB: 0, exhausted: true };
        }
    }

    /**
     * Add data usage with proper error handling
     */
    addDataUsage(phoneNumber, dataMB, description = 'Internet browsing') {
        try {
            if (!fs.existsSync(this.dataFile)) {
                console.error('[DATA-TRACKER] Cannot add usage - file not found');
                return false;
            }

            const workbook = XLSX.readFile(this.dataFile);
            
            // Get or create Usage sheet
            let usageSheet;
            let usageData = [];
            
            if (workbook.SheetNames.includes('Usage')) {
                usageSheet = workbook.Sheets['Usage'];
                usageData = XLSX.utils.sheet_to_json(usageSheet);
            }

            // Add new usage record
            const newUsage = {
                phone_number: phoneNumber,
                data_used: Math.round(dataMB * 100) / 100,
                description: description,
                timestamp: new Date().toISOString(),
                session_id: this.getSessionId(phoneNumber)
            };

            usageData.push(newUsage);

            // Write back to file
            const newUsageSheet = XLSX.utils.json_to_sheet(usageData);
            workbook.Sheets['Usage'] = newUsageSheet;
            if (!workbook.SheetNames.includes('Usage')) {
                workbook.SheetNames.push('Usage');
            }

            XLSX.writeFile(workbook, this.dataFile);

            // Clear cache for this user
            usageCache.delete(phoneNumber);
            
            console.log(`[DATA-TRACKER] Added ${dataMB}MB usage for ${phoneNumber}`);
            return true;

        } catch (error) {
            console.error('[DATA-TRACKER] Error adding usage:', error);
            return false;
        }
    }

    /**
     * Prevent duplicate bundle creation
     */
    createBundleIfNotExists(phoneNumber, videoCount, bundleMB, bundleType) {
        try {
            if (!fs.existsSync(this.dataFile)) {
                console.error('[DATA-TRACKER] Cannot create bundle - file not found');
                return false;
            }

            const workbook = XLSX.readFile(this.dataFile);
            
            // Get existing purchases
            let purchases = [];
            if (workbook.SheetNames.includes('Purchases')) {
                const purchasesSheet = workbook.Sheets['Purchases'];
                purchases = XLSX.utils.sheet_to_json(purchasesSheet);
            }

            // Check if bundle already exists for this milestone
            const existingBundle = purchases.find(p => 
                p.phone_number === phoneNumber && 
                p.bundle_type === bundleType &&
                p.video_count === videoCount
            );

            if (existingBundle) {
                console.log(`[DATA-TRACKER] Bundle already exists for ${phoneNumber} at ${videoCount} videos`);
                return false;
            }

            // Create new bundle
            const newBundle = {
                phone_number: phoneNumber,
                data_amount: bundleMB,
                bundle_type: bundleType,
                video_count: videoCount,
                timestamp: new Date().toISOString(),
                purchase_type: 'video_reward'
            };

            purchases.push(newBundle);

            // Write back to file
            const newPurchasesSheet = XLSX.utils.json_to_sheet(purchases);
            workbook.Sheets['Purchases'] = newPurchasesSheet;
            if (!workbook.SheetNames.includes('Purchases')) {
                workbook.SheetNames.push('Purchases');
            }

            XLSX.writeFile(workbook, this.dataFile);

            // Clear cache
            usageCache.delete(phoneNumber);

            console.log(`[DATA-TRACKER] Created ${bundleMB}MB bundle for ${phoneNumber} (${videoCount} videos)`);
            return true;

        } catch (error) {
            console.error('[DATA-TRACKER] Error creating bundle:', error);
            return false;
        }
    }

    /**
     * Get or create session ID for tracking
     */
    getSessionId(phoneNumber) {
        if (!this.sessionUsage.has(phoneNumber)) {
            this.sessionUsage.set(phoneNumber, {
                sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                startTime: Date.now(),
                usageThisSession: 0
            });
        }
        return this.sessionUsage.get(phoneNumber).sessionId;
    }

    /**
     * Track session usage for real-time monitoring
     */
    addSessionUsage(phoneNumber, dataMB) {
        if (!this.sessionUsage.has(phoneNumber)) {
            this.getSessionId(phoneNumber); // Initialize session
        }
        
        const session = this.sessionUsage.get(phoneNumber);
        session.usageThisSession += dataMB;
        
        return session;
    }

    /**
     * Get all active users with current usage
     */
    getAllActiveUsers() {
        try {
            if (!fs.existsSync(this.dataFile)) {
                return [];
            }

            const workbook = XLSX.readFile(this.dataFile);
            const users = [];

            // Get all unique phone numbers from purchases
            if (workbook.SheetNames.includes('Purchases')) {
                const purchasesSheet = workbook.Sheets['Purchases'];
                const purchases = XLSX.utils.sheet_to_json(purchasesSheet);
                
                const phoneNumbers = [...new Set(purchases.map(p => p.phone_number))];
                
                for (const phoneNumber of phoneNumbers) {
                    const usageData = this.getFreshUsageData(phoneNumber);
                    const session = this.sessionUsage.get(phoneNumber);
                    
                    users.push({
                        phoneNumber,
                        ...usageData,
                        sessionUsage: session ? session.usageThisSession : 0,
                        lastActive: session ? session.startTime : null
                    });
                }
            }

            return users;

        } catch (error) {
            console.error('[DATA-TRACKER] Error getting active users:', error);
            return [];
        }
    }

    /**
     * Clear cache for specific user or all users
     */
    clearCache(phoneNumber = null) {
        if (phoneNumber) {
            usageCache.delete(phoneNumber);
            this.lastCacheUpdate.delete(phoneNumber);
        } else {
            usageCache.clear();
            this.lastCacheUpdate.clear();
        }
    }
}

module.exports = new DataTracker();
