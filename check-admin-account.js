// 🔧 Admin Account Checker & Creator
// This script checks if the admin account exists and creates it if needed

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const ADMIN_EMAIL = 'sbusisosweetwell15@gmail.com';
const ADMIN_PASSWORD = 'Admin123!'; // Default password
const DB_PATH = './data.sqlite';

console.log('🔧 ISN Free WiFi - Admin Account Checker');
console.log('=======================================');
console.log('');

// Initialize database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.log('❌ Error connecting to database:', err.message);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite database');
});

// Function to check if admin exists
function checkAdminAccount() {
  return new Promise((resolve, reject) => {
    db.get('SELECT email, password, firstName, surname FROM users WHERE email = ?', [ADMIN_EMAIL], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

// Function to create admin account
function createAdminAccount() {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const userData = {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      firstName: 'Sibusiso',
      surname: 'Sweetwell',
      dob: '1990-01-01',
      dateCreatedISO: now,
      dateCreatedLocal: new Date().toString()
    };

    db.run(`INSERT OR REPLACE INTO users (email, password, firstName, surname, dob, dateCreatedISO, dateCreatedLocal) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`, 
           [userData.email, userData.password, userData.firstName, userData.surname, userData.dob, userData.dateCreatedISO, userData.dateCreatedLocal], 
           function(err) {
             if (err) {
               reject(err);
             } else {
               resolve(userData);
             }
           });
  });
}

// Function to list all users (for debugging)
function listAllUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT email, phone, firstName, surname, password FROM users LIMIT 10', (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Main execution
async function main() {
  try {
    console.log('🔍 Checking if admin account exists...');
    
    const adminAccount = await checkAdminAccount();
    
    if (adminAccount) {
      console.log('✅ Admin account found!');
      console.log('   📧 Email:', adminAccount.email);
      console.log('   👤 Name:', adminAccount.firstName, adminAccount.surname);
      console.log('   🔐 Password:', adminAccount.password);
    } else {
      console.log('❌ Admin account not found. Creating it...');
      
      const newAdmin = await createAdminAccount();
      console.log('✅ Admin account created successfully!');
      console.log('   📧 Email:', newAdmin.email);
      console.log('   👤 Name:', newAdmin.firstName, newAdmin.surname);
      console.log('   🔐 Password:', newAdmin.password);
    }

    console.log('');
    console.log('📋 All users in database:');
    const allUsers = await listAllUsers();
    
    if (allUsers.length === 0) {
      console.log('   (No users found)');
    } else {
      allUsers.forEach((user, i) => {
        console.log(`   ${i+1}. 📧 ${user.email || 'No email'} | 📱 ${user.phone || 'No phone'} | 👤 ${user.firstName} ${user.surname} | 🔐 ${user.password}`);
      });
    }

    console.log('');
    console.log('🎯 Login Instructions:');
    console.log('======================');
    console.log('');
    console.log('1. Open browser: http://localhost:3000/login.html');
    console.log('2. Enter credentials:');
    console.log('   📧 Email: sbusisosweetwell15@gmail.com');
    console.log('   🔐 Password: Admin123!');
    console.log('');
    console.log('💡 If login fails, try these passwords:');
    console.log('   • admin123');
    console.log('   • password123');
    console.log('   • sweetwell123');
    console.log('');

  } catch (error) {
    console.log('❌ Error:', error.message);
  } finally {
    db.close();
  }
}

main();
