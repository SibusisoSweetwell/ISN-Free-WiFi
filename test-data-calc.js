const XLSX = require('xlsx');
const crypto = require('crypto');
const fs = require('fs');

const DATA_FILE = './logins.xlsx';

function testDataCalculation() {
  try {
    const wb = XLSX.readFile(DATA_FILE);
    
    // Check AdEvents for sbusisosweetwell15@gmail.com
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets.AdEvents);
    const userVideos = videoViews.filter(v => 
      v.identifier === 'sbusisosweetwell15@gmail.com' && 
      v.completedAt
    );
    
    console.log('All videos for user:', userVideos.length);
    console.log('Video earned MB (50MB each):', userVideos.length * 50);
    
    // Check Purchases
    const purchases = XLSX.utils.sheet_to_json(wb.Sheets.Purchases);
    const userPurchases = purchases.filter(p => 
      p.identifier === 'sbusisosweetwell15@gmail.com'
    );
    
    let totalPurchased = 0, totalUsed = 0;
    userPurchases.forEach(p => {
      totalPurchased += Number(p.bundleMB) || 0;
      totalUsed += Number(p.usedMB) || 0;
    });
    
    console.log('Purchased MB:', totalPurchased);
    console.log('Used MB:', totalUsed);
    
    const videoEarned = userVideos.length * 50;
    const totalAvailable = totalPurchased + videoEarned;
    const remaining = totalAvailable - totalUsed;
    
    console.log('\n=== FINAL CALCULATION ===');
    console.log('Videos watched:', userVideos.length);
    console.log('Video earned:', videoEarned, 'MB');
    console.log('Purchased:', totalPurchased, 'MB');  
    console.log('Total available:', totalAvailable, 'MB');
    console.log('Total used:', totalUsed, 'MB');
    console.log('Remaining:', remaining, 'MB');
    
    return {
      videosWatched: userVideos.length,
      videoEarnedMB: videoEarned,
      totalBundleMB: totalAvailable,
      totalUsedMB: totalUsed,
      remainingMB: remaining,
      exhausted: remaining <= 0
    };
    
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

const result = testDataCalculation();
console.log('\nAPI should return:', JSON.stringify(result, null, 2));
