// Quick manual verification of phone user data
const XLSX = require('xlsx');
const crypto = require('crypto');

console.log('📊 MANUAL DATA VERIFICATION FOR PHONE USER 0796694562');
console.log('='.repeat(60));

try {
  // Load purchases
  const purchasesWorkbook = XLSX.readFile('purchases.xlsx');
  const purchasesData = XLSX.utils.sheet_to_json(purchasesWorkbook.Sheets['Sheet1']);
  
  console.log(`\n📦 Total purchases in database: ${purchasesData.length}`);
  
  // Filter purchases for phone user
  const phoneUserPurchases = purchasesData.filter(p => 
    p.identifier === '0796694562' || p.phoneNumber === '0796694562'
  );
  
  console.log(`\n📱 Purchases for phone user 0796694562: ${phoneUserPurchases.length}`);
  
  if (phoneUserPurchases.length > 0) {
    let totalMB = 0;
    let totalUsed = 0;
    
    phoneUserPurchases.forEach((purchase, i) => {
      const bundleMB = parseInt(purchase.bundleMB) || 0;
      const usedMB = parseInt(purchase.usedMB) || 0;
      const remaining = bundleMB - usedMB;
      
      totalMB += bundleMB;
      totalUsed += usedMB;
      
      console.log(`  ${i+1}. ${bundleMB}MB bundle (used: ${usedMB}MB, remaining: ${remaining}MB)`);
      console.log(`     Device: ${purchase.deviceId}, Granted: ${purchase.grantedAtISO}`);
    });
    
    console.log(`\n📊 TOTALS:`);
    console.log(`   Total purchased: ${totalMB}MB`);
    console.log(`   Total used: ${totalUsed}MB`);
    console.log(`   Total remaining: ${totalMB - totalUsed}MB`);
  } else {
    console.log('❌ NO PURCHASES FOUND for phone user!');
  }
  
  // Load video events
  const videosWorkbook = XLSX.readFile('videos.xlsx');
  const videosData = XLSX.utils.sheet_to_json(videosWorkbook.Sheets['Sheet1']);
  
  const phoneUserVideos = videosData.filter(v => 
    v.identifier === '0796694562' || v.phoneNumber === '0796694562'
  );
  
  console.log(`\n📹 Video events for phone user: ${phoneUserVideos.length}`);
  console.log(`   Videos completed today: ${phoneUserVideos.filter(v => 
    v.completedAt && new Date(v.completedAt).toDateString() === new Date().toDateString()
  ).length}`);
  
} catch (error) {
  console.log('❌ Error reading data:', error.message);
}
