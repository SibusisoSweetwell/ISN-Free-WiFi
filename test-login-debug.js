// Test login functionality directly (debug helper)
const XLSX = require('xlsx');
const http = require('http');

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

console.log('=== Testing Login System (debug) ===\n');

try {
  const wb = loadWorkbook();
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
  console.log('DB file:', DATA_FILE);
  console.log('Current users:', data.length);

  // Ensure test user exists
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
    console.log('✅ Test user created: test@test.com');
  } else {
    console.log('✅ Test user exists: test@test.com');
  }

  // List users (mask passwords)
  console.log('\nAll users:');
  data.forEach((u,i)=>{
    const mask = p => (!p)?'<none>':(p.length>4? p[0]+'***'+p.slice(-1): p[0]+'***');
    console.log(`${i+1}. ${u.email} | ${mask(u.password)} | ${u.phone||'no phone'}`);
  });

  // Test login validation cases
  console.log('\nTesting login validation:');
  const tests = [
    { email: 'test@test.com', password: 'test123', expected: true },
    { email: 'test@test.com', password: 'wrong', expected: false }
  ];
  tests.forEach(t=>{
    const ok = validateLogin(t.email, t.password);
    console.log(`  ${t.email} / ${t.password.length>0? t.password[0]+'***':'<none>'} -> ${ok} (expected ${t.expected})`);
  });

} catch (err) {
  console.error('Error during debug tests:', err.message||err);
}

// Quick API test (non-interactive)
console.log('\nAPI endpoint test (non-interactive):');
const postData = JSON.stringify({ email: 'test@test.com', password: 'test123' });
const options = { hostname: '10.5.48.94', port: 3151, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } };
const req = http.request(options, res=>{
  let data='';
  res.on('data', c=> data+=c);
  res.on('end', ()=>{
    console.log(` API Response (${res.statusCode}): ${data}`);
  });
});
req.on('error', e=> console.error('API test error:', e.message));
req.write(postData);
req.end();
