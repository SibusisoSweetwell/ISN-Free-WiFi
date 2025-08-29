const sqlite = require('./sqlite-db');
const fs = require('fs');
const dbPath = './test-data.sqlite';
try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch(e){}
console.log('init:', sqlite.init(dbPath));
const r = sqlite.createUser({ email:'User@Example.COM', password:'P@ssw0rd!', phone:'0791234567', firstName:'Test', surname:'User' });
console.log('created id', r.id);
console.log('findUser with lower email:', !!sqlite.findUser('user@example.com'));
console.log('findUser with upper email:', !!sqlite.findUser('USER@EXAMPLE.COM'));
console.log('validateLogin with mixed case email:', sqlite.validateLogin('User@Example.COM','P@ssw0rd!'));
console.log('validateLogin with lower email:', sqlite.validateLogin('user@example.com','P@ssw0rd!'));
console.log('validateLogin with wrong pass:', sqlite.validateLogin('user@example.com','wrong'));
