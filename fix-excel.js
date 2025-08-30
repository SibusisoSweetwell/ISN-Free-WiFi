const XLSX = require('xlsx');

// Create a fresh Excel file with proper structure
const wb = XLSX.utils.book_new();

// Create Users sheet with sample structure
const usersData = [
  {
    email: 'admin@isn.local',
    phone: '',
    identifier: 'admin@isn.local',
    password: 'Admin123!',
    firstName: 'Admin',
    surname: 'User',
    dob: '1990-01-01',
    dateCreatedISO: new Date().toISOString(),
    dateCreatedLocal: new Date().toLocaleString(),
    status: 'admin'
  }
];

const usersSheet = XLSX.utils.json_to_sheet(usersData);
XLSX.utils.book_append_sheet(wb, usersSheet, 'Users');

// Create Login History sheet
const loginHistoryData = [
  {
    email: 'admin@isn.local',
    loginTime: new Date().toISOString(),
    ip: '127.0.0.1',
    userAgent: 'Admin Login',
    success: true
  }
];

const loginSheet = XLSX.utils.json_to_sheet(loginHistoryData);
XLSX.utils.book_append_sheet(wb, loginSheet, 'LoginHistory');

// Write the new clean file
try {
  XLSX.writeFile(wb, 'logins.xlsx');
  console.log('✅ Created fresh logins.xlsx file with proper structure');
  console.log('✅ Added admin user: admin@isn.local');
  console.log('✅ Excel file is now clean and ready for use');
  console.log('✅ Added admin user: admin@isn.local (password hidden)');
  console.log('✅ Excel file is now clean and ready for use');
} catch (error) {
  console.error('❌ Error creating Excel file:', error.message);
}
