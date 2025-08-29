const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const sqlite = require('./sqlite-db');

function normalizePhone(p){
  if(!p) return '';
  const s = String(p).replace(/[^0-9]/g,'');
  if(s.length===10 && s.startsWith('0')) return s; // local
  if(s.length===11 && s.startsWith('27')) return s; // SA with country code
  return s;
}

async function run(){
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'data.sqlite');
  if(!sqlite.init(dbPath)){
    console.error('Failed to initialize sqlite DB at', dbPath);
    process.exit(1);
  }

  const file = path.join(__dirname, 'logins.xlsx');
  if(!fs.existsSync(file)){
    console.error('logins.xlsx not found in repo root. Nothing to migrate.');
    process.exit(0);
  }

  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets['Users'] || wb.Sheets['users'] || wb.Sheets['USERs'];
  if(!sheet){
    console.error('No Users sheet found in logins.xlsx. Expected sheet named "Users"');
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(sheet);
  console.log(`Found ${rows.length} rows in Users sheet`);

  let imported = 0, skipped = 0, errors = 0;

  for(const r of rows){
    try{
      const email = (r.email||r.Email||r.E || r.E_mail || '').toString().trim();
      const phoneRaw = (r.phone||r.phoneNumber||r.Phone||r.P||'').toString().trim();
      const phone = normalizePhone(phoneRaw);
      const password = (r.password||r.Password||'').toString();
      const firstName = (r.firstName||r.first_name||r.FirstName||'').toString();
      const surname = (r.surname||r.Surname||r.lastName||'').toString();
      const dob = (r.dob||r.DOB||'').toString();

      const identifier = email ? email.toLowerCase() : phone;
      if(!identifier){ skipped++; continue; }

      // Check existing
      const existing = sqlite.findUser(identifier);
      if(existing){ skipped++; continue; }

      const userObj = { email: email||null, phone: phone||null, password: password||null, firstName: firstName||null, surname: surname||null, dob: dob||null };
      const res = sqlite.createUser(userObj);
      if(res && res.ok){ imported++; }
      else { errors++; console.warn('Create user failed for', identifier, res); }
    } catch(err){ errors++; console.error('Row import error', err && err.message); }
  }

  console.log(`Migration done. imported=${imported} skipped=${skipped} errors=${errors}`);
  process.exit(0);
}

run();
