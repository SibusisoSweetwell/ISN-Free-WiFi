// Test login functionality directly
const express = require('express');
const XLSX = require('xlsx');

const DATA_FILE = 'logins.xlsx';

function loadWorkbook(){
  const wb = XLSX.readFile(DATA_FILE);
  if(!wb.Sheets['Users']){
    wb.Sheets['Users'] = XLSX.utils.aoa_to_sheet([['email','password','phone','firstName','surname','dateCreated']]);
    wb.SheetNames.push('Users');
    XLSX.writeFile(wb, DATA_FILE);
  }
  return wb;
}

function normalizePhone(raw){
  if(!raw) return '';
  let s = (''+raw).trim().replace(/\s+/g,'');
  if(s.startsWith('+27')) s = s.slice(3);
  s = s.replace(/\D/g,'');
  if(s.length === 9 && !s.startsWith('0')) s = '0' + s;
  if(s.startsWith('27') && s.length>10) s = '0' + s.slice(2);
  if(/^00/.test(s)) s = s.slice(1);
  if(s.length>10) s = s.slice(0,10);
  if(!/^0\d{9}$/.test(s)) return '';
  return s;
}

function validateLogin(identifier, password){
  const wb = loadWorkbook();
  const ws = wb.Sheets['Users'];
  const data = XLSX.utils.sheet_to_json(ws);
  let user;
  if(identifier.includes('@')){
    user = data.find(u=>u.email===identifier && u.password===password);
  } else {
    const norm = normalizePhone(identifier);
    user = data.find(u=>u.phone===norm && u.password===password);
  }
  return !!user;
}

console.log('=== Testing Login System ===\n');

// 1. Check if file exists and create test users
try {
  let wb = loadWorkbook();
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
  
  console.log(`📁 Database file: ${DATA_FILE}`);
  console.log(`👥 Current users: ${data.length}`);
  
  // Add test user if needed
  const testUser = data.find(u => u.email === 'test@test.com');
  if (!testUser) {
    data.push({
      email: 'test@test.com',
      password: 'test123',
      phone: '0123456789',
      firstName: 'Test',
      surname: 'User',
      dateCreated: new Date().toISOString()
    });
    
    wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
    XLSX.writeFile(wb, DATA_FILE);
    console.log('✅ Created test user: test@test.com / test123');
  } else {
    console.log('✅ Test user exists: test@test.com / test123');
  }
  
  // List all users
  const currentData = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
  console.log('\n👤 All users in database:');
  currentData.forEach((user, i) => {
    console.log(`   ${i+1}. ${user.email} | ${user.password} | ${user.phone || 'no phone'}`);
  });
  
  // 2. Test login function
  console.log('\n🔐 Testing login validation:');
  
  const testCases = [
    { email: 'test@test.com', password: 'test123', expected: true },
    { email: 'test@test.com', password: 'wrong', expected: false },
    { email: 'nonexistent@test.com', password: 'test123', expected: false }
  ];
  
  testCases.forEach(test => {
    const result = validateLogin(test.email, test.password);
    const status = result === test.expected ? '✅' : '❌';
    console.log(`   ${status} ${test.email} / ${test.password} -> ${result} (expected: ${test.expected})`);
  });
  
} catch (error) {
  console.error('❌ Error:', error.message);
}

console.log('\n🌐 Now test in browser:');
console.log('   URL: http://10.5.48.94:3151/login.html');
console.log('   Email: test@test.com');
console.log('   Password: test123');

// Quick test of the actual API endpoint
console.log('\n🧪 Testing API endpoint...');
const testPort = 3151;
const http = require('http');

const postData = JSON.stringify({
  email: 'test@test.com',
  password: 'test123'
});

const options = {
  hostname: '10.5.48.94',
  port: testPort,
  path: '/api/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log(`   API Response (${res.statusCode}): ${data}`);
    if (res.statusCode === 200) {
      console.log('   ✅ API login test SUCCESSFUL');
    } else {
      console.log('   ❌ API login test FAILED');
    }
  });
});

req.on('error', (e) => {
  console.log(`   ❌ API test error: ${e.message}`);
});

req.write(postData);
req.end();
