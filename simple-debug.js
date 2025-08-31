const XLSX = require('xlsx');

console.log('=== BONGILINDIWE DATA DEBUG ===');

try {
  const df = process.env.DATA_FILE || path.join(__dirname, 'logins.xlsx');
  const wb = XLSX.readFile(df);
  
  // Check purchases
  if (wb.Sheets['Purchases']) {
    const purchases = XLSX.utils.sheet_to_json(wb.Sheets['Purchases']);
    const userPurchases = purchases.filter(p => (p.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
    console.log('PURCHASES:', userPurchases.length);
    userPurchases.forEach(p => console.log('  ', p));
  }
  
  // Check videos 
  if (wb.Sheets['AdEvents']) {
    const events = XLSX.utils.sheet_to_json(wb.Sheets['AdEvents']);
    const userEvents = events.filter(e => (e.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
    console.log('VIDEO EVENTS:', userEvents.length);
    userEvents.forEach(e => console.log('  ', e));
  }
  
  // Check data usage
  if (wb.Sheets['DataUsage']) {
    const usage = XLSX.utils.sheet_to_json(wb.Sheets['DataUsage']);
    const userUsage = usage.filter(u => (u.identifier || '').toLowerCase() === 'bongilindiwe844@gmail.com');
    console.log('DATA USAGE:', userUsage.length);
    let totalUsed = 0;
    userUsage.forEach(u => {
      totalUsed += Number(u.usedMB) || 0;
      console.log('  ', u);
    });
    console.log('TOTAL USED:', totalUsed, 'MB');
  }
  
} catch (error) {
  console.error('ERROR:', error.message);
}

console.log('=== DEBUG COMPLETE ===');
