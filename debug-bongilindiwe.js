const XLSX = require('xlsx');
const crypto = require('crypto');

// Check current state of bongilindiwe844@gmail.com data usage and limits
function debugBongilindiweData() {
  console.log('=== DEBUGGING BONGILINDIWE844@GMAIL.COM DATA USAGE ===');
  
  try {
    const wb = XLSX.readFile('logins.xlsx');
    
    // Check user in login sheet
    if (wb.Sheets['Logins']) {
      const users = XLSX.utils.sheet_to_json(wb.Sheets['Logins']);
      const user = users.find(u => (u.email || '').toLowerCase() === 'bongilindiwe844@gmail.com');
      console.log('1. USER DATA:', user || 'NOT FOUND');
    }
    
    // Check purchases/bundles
    if (wb.Sheets['Purchases']) {
      const purchases = XLSX.utils.sheet_to_json(wb.Sheets['Purchases']);
      const userPurchases = purchases.filter(p => (p.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
      console.log('2. PURCHASES/BUNDLES:', userPurchases.length, 'found');
      userPurchases.forEach((p, i) => {
        console.log(`   Bundle ${i+1}:`, {
          bundleMB: p.bundleMB,
          usedMB: p.usedMB,
          grantedAt: p.grantedAtISO,
          deviceId: p.deviceId
        });
      });
    }
    
    // Check video events
    if (wb.Sheets['AdEvents']) {
      const events = XLSX.utils.sheet_to_json(wb.Sheets['AdEvents']);
      const userEvents = events.filter(e => (e.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
      console.log('3. VIDEO EVENTS:', userEvents.length, 'found');
      userEvents.forEach((e, i) => {
        console.log(`   Video ${i+1}:`, {
          earnedMB: e.earnedMB,
          completedAt: e.completedAtISO,
          deviceId: e.deviceId
        });
      });
    }
    
    // Check data usage entries
    if (wb.Sheets['DataUsage']) {
      const usage = XLSX.utils.sheet_to_json(wb.Sheets['DataUsage']);
      const userUsage = usage.filter(u => (u.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
      console.log('4. DATA USAGE ENTRIES:', userUsage.length, 'found');
      let totalUsed = 0;
      userUsage.forEach((u, i) => {
        totalUsed += Number(u.usedMB) || 0;
        console.log(`   Usage ${i+1}:`, {
          usedMB: u.usedMB,
          timestamp: u.timestamp,
          description: u.description
        });
      });
      console.log('   TOTAL USED:', totalUsed.toFixed(2), 'MB');
    }
    
  } catch (error) {
    console.error('ERROR:', error.message);
  }
  
  console.log('=== DEBUG COMPLETE ===\n');
}

// Test quota calculation
function testQuotaCalculation() {
  console.log('=== TESTING QUOTA CALCULATION ===');
  
  // Simulate the computeRemaining function logic
  const identifier = 'bongilindiwe844@gmail.com';
  
  try {
    const wb = XLSX.readFile('logins.xlsx');
    
    // Get purchases
    const purchases = XLSX.utils.sheet_to_json(wb.Sheets['Purchases'] || {});
    const userPurchases = purchases.filter(p => (p.identifier || '').toLowerCase() === identifier);
    
    let totalPurchased = 0;
    let totalUsed = 0;
    userPurchases.forEach(p => {
      totalPurchased += Number(p.bundleMB) || 0;
      totalUsed += Number(p.usedMB) || 0;
    });
    
    // Get video earnings
    const events = XLSX.utils.sheet_to_json(wb.Sheets['AdEvents'] || {});
    const userEvents = events.filter(e => (e.identifier || '').toLowerCase() === identifier);
    const videoEarned = userEvents.length * 20; // 20MB per video
    
    const totalAvailable = totalPurchased + videoEarned;
    const remaining = Math.max(0, totalAvailable - totalUsed);
    
    console.log('QUOTA CALCULATION:');
    console.log('  Purchased:', totalPurchased, 'MB');
    console.log('  Video Earned:', videoEarned, 'MB');
    console.log('  Total Available:', totalAvailable, 'MB');
    console.log('  Total Used:', totalUsed, 'MB');
    console.log('  Remaining:', remaining, 'MB');
    console.log('  Should Block:', remaining <= 0);
    
  } catch (error) {
    console.error('QUOTA CALC ERROR:', error.message);
  }
  
  console.log('=== QUOTA TEST COMPLETE ===\n');
}

// Run debug
debugBongilindiweData();
testQuotaCalculation();
const path = require('path');

const DATA_FILE = 'logins.xlsx';
const SHEET_LOGINS = 'Sheet1';
const SHEET_PURCHASES = 'Purchases';
const SHEET_ADEVENTS = 'AdEvents';

function debugBongilindiwe() {
    console.log('=== DEBUGGING BONGILINDIWE844@GMAIL.COM ===');
    
    try {
        const wb = XLSX.readFile(DATA_FILE);
        console.log('Available sheets:', wb.SheetNames);
        
        // Check logins
        if (wb.Sheets[SHEET_LOGINS]) {
            const logins = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_LOGINS]);
            const userLogin = logins.find(u => (u.email || '').toLowerCase() === 'bongilindiwe844@gmail.com');
            console.log('\n--- LOGIN DATA ---');
            console.log('User found in logins:', userLogin ? 'YES' : 'NO');
            if (userLogin) {
                console.log('Login data:', JSON.stringify(userLogin, null, 2));
            }
        }
        
        // Check purchases
        if (wb.Sheets[SHEET_PURCHASES]) {
            const purchases = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PURCHASES]);
            const userPurchases = purchases.filter(p => (p.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
            console.log('\n--- PURCHASE DATA ---');
            console.log(`Found ${userPurchases.length} purchases for bongilindiwe844@gmail.com`);
            userPurchases.forEach((purchase, i) => {
                console.log(`Purchase ${i + 1}:`, JSON.stringify(purchase, null, 2));
            });
        }
        
        // Check video events
        if (wb.Sheets[SHEET_ADEVENTS]) {
            const adEvents = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
            const userEvents = adEvents.filter(e => (e.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
            console.log('\n--- VIDEO EVENTS DATA ---');
            console.log(`Found ${userEvents.length} video events for bongilindiwe844@gmail.com`);
            userEvents.forEach((event, i) => {
                console.log(`Event ${i + 1}:`, JSON.stringify(event, null, 2));
            });
        }
        
    } catch (error) {
        console.error('Error reading Excel file:', error.message);
    }
}

debugBongilindiwe();
