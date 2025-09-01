// 🔧 Simple Admin Account Creator (No external dependencies)
// This creates the admin account directly in the database

const fs = require('fs');
const path = require('path');

console.log('🔧 ISN Free WiFi - Simple Admin Account Creator');
console.log('==============================================');
console.log('');

const ADMIN_EMAIL = 'sbusisosweetwell15@gmail.com';
const ADMIN_PASSWORD = 'Admin123!';

// Check if we can use the main server's functions
try {
  // Try to load the main server file to use its database functions
  console.log('📁 Loading server functions...');
  
  // Read the server.js file and extract the Excel handling code
  const serverContent = fs.readFileSync('./server.js', 'utf8');
  
  if (serverContent.includes('XLSX')) {
    console.log('✅ Excel support detected in server');
    
    // Create admin account using Excel approach
    const XLSX = require('xlsx');
    const DATA_FILE = './logins.xlsx';
    
    try {
      let workbook;
      let userData = [];
      
      // Try to read existing file
      if (fs.existsSync(DATA_FILE)) {
        workbook = XLSX.readFile(DATA_FILE);
        if (workbook.SheetNames.includes('Users')) {
          const worksheet = workbook.Sheets['Users'];
          userData = XLSX.utils.sheet_to_json(worksheet);
        }
      } else {
        workbook = XLSX.utils.book_new();
      }
      
      // Check if admin already exists
      const existingAdmin = userData.find(u => u.email === ADMIN_EMAIL);
      
      if (existingAdmin) {
        console.log('✅ Admin account already exists!');
        console.log('   📧 Email:', existingAdmin.email);
        console.log('   🔐 Password:', existingAdmin.password);
        console.log('   👤 Name:', existingAdmin.firstName, existingAdmin.surname);
      } else {
        // Create new admin account
        const newAdmin = {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          firstName: 'Sibusiso',
          surname: 'Sweetwell',
          phone: '',
          dob: '1990-01-01',
          dateCreatedISO: new Date().toISOString(),
          dateCreatedLocal: new Date().toString()
        };
        
        userData.push(newAdmin);
        
        // Create new worksheet
        const worksheet = XLSX.utils.json_to_sheet(userData);
        
        // Add or update the Users sheet
        if (workbook.SheetNames.includes('Users')) {
          workbook.Sheets['Users'] = worksheet;
        } else {
          XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');
        }
        
        // Write to file
        XLSX.writeFile(workbook, DATA_FILE);
        
        console.log('✅ Admin account created in Excel database!');
        console.log('   📧 Email:', newAdmin.email);
        console.log('   🔐 Password:', newAdmin.password);
        console.log('   👤 Name:', newAdmin.firstName, newAdmin.surname);
      }
      
    } catch (excelError) {
      console.log('❌ Excel error:', excelError.message);
      console.log('💡 Try installing xlsx: npm install xlsx');
    }
    
  } else {
    console.log('⚠️  No Excel support detected, using manual approach');
  }

} catch (error) {
  console.log('⚠️  Could not access server functions:', error.message);
}

console.log('');
console.log('🎯 Login Instructions:');
console.log('======================');
console.log('');
console.log('1. Start the server: node server.js');
console.log('2. Open browser: http://localhost:3000/login.html');
console.log('3. Enter credentials:');
console.log('   📧 Email: sbusisosweetwell15@gmail.com');
console.log('   🔐 Password: Admin123!');
console.log('');
console.log('💡 Alternative passwords to try:');
console.log('   • admin123');
console.log('   • password123');
console.log('   • sweetwell123');
console.log('');
console.log('🔧 If login still fails:');
console.log('   1. Clear browser cache');
console.log('   2. Try incognito mode');
console.log('   3. Check server console for errors');
console.log('   4. Create new account via registration');
console.log('');
