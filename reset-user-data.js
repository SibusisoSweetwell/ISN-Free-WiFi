const XLSX = require('xlsx');
const fs = require('fs');

console.log('=== RESETTING USER 0796694562 DATA TO 0MB ===\n');

const phoneNumber = '0796694562';

try {
  // Load the Excel workbook
  const workbook = XLSX.readFile('logins.xlsx');
  console.log('📊 Loaded logins.xlsx successfully');
  
  // Get all sheet names
  const sheetNames = workbook.SheetNames;
  console.log('📋 Available sheets:', sheetNames.join(', '));
  
  let totalReset = 0;
  
  // Reset data in Purchases sheet
  if (sheetNames.includes('Purchases')) {
    const purchasesSheet = workbook.Sheets['Purchases'];
    const purchases = XLSX.utils.sheet_to_json(purchasesSheet);
    
    console.log('\n🛒 PURCHASES SHEET:');
    console.log(`Found ${purchases.length} total purchase records`);
    
    // Find and reset purchases for this phone number
    let userPurchases = purchases.filter(p => 
      p.identifier === phoneNumber || 
      (typeof p.identifier === 'string' && p.identifier.trim() === phoneNumber)
    );
    
    console.log(`Found ${userPurchases.length} purchases for ${phoneNumber}:`);
    userPurchases.forEach((p, index) => {
      console.log(`  ${index + 1}. ${p.bundleMB}MB bundle - ${p.usedMB}MB used - Device: ${(p.deviceId || 'unknown').slice(0,8)}...`);
    });
    
    // Reset all purchases to 0MB remaining (set usedMB = bundleMB)
    purchases.forEach(p => {
      if (p.identifier === phoneNumber || (typeof p.identifier === 'string' && p.identifier.trim() === phoneNumber)) {
        if (p.bundleMB && p.bundleMB > 0) {
          const originalUsed = p.usedMB || 0;
          p.usedMB = p.bundleMB; // Set used = bundle amount (0MB remaining)
          totalReset += (p.bundleMB - originalUsed);
          console.log(`  ✅ Reset bundle: ${p.bundleMB}MB → 0MB remaining`);
        }
      }
    });
    
    // Update the sheet
    const newPurchasesSheet = XLSX.utils.json_to_sheet(purchases);
    workbook.Sheets['Purchases'] = newPurchasesSheet;
  }
  
  // Reset video events (optional - to force re-watching)
  if (sheetNames.includes('AdEvents')) {
    const adEventsSheet = workbook.Sheets['AdEvents'];
    const adEvents = XLSX.utils.sheet_to_json(adEventsSheet);
    
    console.log('\n🎬 VIDEO EVENTS SHEET:');
    console.log(`Found ${adEvents.length} total video events`);
    
    // Find video events for this user
    let userEvents = adEvents.filter(e => 
      e.identifier === phoneNumber || 
      (typeof e.identifier === 'string' && e.identifier.trim() === phoneNumber)
    );
    
    console.log(`Found ${userEvents.length} video events for ${phoneNumber}`);
    
    // Option 1: Keep video events but reset their data earning (recommended)
    // Option 2: Delete all video events (uncomment below to delete all videos)
    /*
    const filteredEvents = adEvents.filter(e => 
      e.identifier !== phoneNumber && 
      !(typeof e.identifier === 'string' && e.identifier.trim() === phoneNumber)
    );
    
    console.log(`Removing ${userEvents.length} video events for testing...`);
    const newAdEventsSheet = XLSX.utils.json_to_sheet(filteredEvents);
    workbook.Sheets['AdEvents'] = newAdEventsSheet;
    */
  }
  
  // Reset real-time usage data (if exists)
  if (sheetNames.includes('RealtimeUsage')) {
    const realtimeSheet = workbook.Sheets['RealtimeUsage'];
    const realtimeData = XLSX.utils.sheet_to_json(realtimeSheet);
    
    const filteredRealtime = realtimeData.filter(r => 
      r.identifier !== phoneNumber && 
      !(typeof r.identifier === 'string' && r.identifier.trim() === phoneNumber)
    );
    
    if (filteredRealtime.length < realtimeData.length) {
      console.log(`\n📡 Cleared ${realtimeData.length - filteredRealtime.length} realtime usage records`);
      const newRealtimeSheet = XLSX.utils.json_to_sheet(filteredRealtime);
      workbook.Sheets['RealtimeUsage'] = newRealtimeSheet;
    }
  }
  
  // Create backup before saving
  const backupName = `logins_backup_${Date.now()}.xlsx`;
  fs.copyFileSync('logins.xlsx', backupName);
  console.log(`\n💾 Created backup: ${backupName}`);
  
  // Save the modified workbook
  XLSX.writeFile(workbook, 'logins.xlsx');
  console.log('✅ Saved changes to logins.xlsx');
  
  console.log(`\n🎯 RESET SUMMARY:`);
  console.log(`User: ${phoneNumber}`);
  console.log(`Total data reset: ${totalReset}MB`);
  console.log(`New remaining data: 0MB`);
  console.log(`Status: User will need to watch videos again to earn data`);
  
  console.log(`\n🧪 TESTING SETUP COMPLETE!`);
  console.log(`The user ${phoneNumber} now has 0MB data and must re-earn access through video watching.`);
  
} catch (error) {
  console.error('❌ Error resetting user data:', error.message);
  console.error('Stack:', error.stack);
}
