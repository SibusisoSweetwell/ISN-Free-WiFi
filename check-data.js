const XLSX = require('xlsx');
const fs = require('fs');

const DATA_FILE = './logins.xlsx';

function checkCurrentData() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('Data file does not exist');
    return;
  }
  
  const wb = XLSX.readFile(DATA_FILE);
  
  // Check Users sheet
  if (wb.Sheets.Users) {
    const users = XLSX.utils.sheet_to_json(wb.Sheets.Users);
    console.log('Users:');
    users.forEach(user => {
      if (user.email && user.email.includes('sbusisosweetwell15')) {
        console.log('  ', user);
      }
    });
  }
  
  // Check Sessions sheet
  if (wb.Sheets.Sessions) {
    const sessions = XLSX.utils.sheet_to_json(wb.Sheets.Sessions);
    console.log('\nSessions for sbusisosweetwell15:');
    sessions.forEach(session => {
      if (session.identifier && session.identifier.includes('sbusisosweetwell15')) {
        console.log('  Device:', session.deviceId, 'Router:', session.routerId);
      }
    });
  }
  
  // Check Purchases sheet
  if (wb.Sheets.Purchases) {
    const purchases = XLSX.utils.sheet_to_json(wb.Sheets.Purchases);
    console.log('\nPurchases for sbusisosweetwell15:');
    purchases.forEach(purchase => {
      if (purchase.identifier && purchase.identifier.includes('sbusisosweetwell15')) {
        console.log('  Device:', purchase.deviceId, 'Bundle:', purchase.bundleMB, 'Used:', purchase.usedMB);
      }
    });
  }
  
  // Check AdEvents sheet
  if (wb.Sheets.AdEvents) {
    const events = XLSX.utils.sheet_to_json(wb.Sheets.AdEvents);
    console.log('\nAdEvents for sbusisosweetwell15:');
    events.forEach(event => {
      if (event.identifier && event.identifier.includes('sbusisosweetwell15')) {
        console.log('  Device:', event.deviceId, 'Video:', event.videoUrl);
      }
    });
  }
}

checkCurrentData();
