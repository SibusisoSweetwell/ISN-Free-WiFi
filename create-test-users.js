// Quick fix to add a test user to the database
const XLSX = require('xlsx');

console.log('Adding test user to database...');

try {
    let wb;
    
    // Try to load existing workbook, or create new one
    try {
        wb = XLSX.readFile('logins.xlsx');
    } catch (e) {
        wb = XLSX.utils.book_new();
    }
    
    // Ensure Users sheet exists
    if (!wb.Sheets['Users']) {
        wb.Sheets['Users'] = XLSX.utils.aoa_to_sheet([
            ['email', 'password', 'phone', 'firstName', 'surname', 'dateCreated']
        ]);
        wb.SheetNames.push('Users');
    }
    
    // Get existing data
    const data = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
    
    // Check if test user exists
    const testExists = data.some(u => u.email === 'test@test.com');
    const adminExists = data.some(u => u.email === 'admin@isn.co.za');
    
    let newUsers = [];
    
    if (!testExists) {
        newUsers.push({
            email: 'test@test.com',
            password: 'test123',
            phone: '0123456789',
            firstName: 'Test',
            surname: 'User',
            dateCreated: new Date().toISOString()
        });
    }
    
    if (!adminExists) {
        newUsers.push({
            email: 'admin@isn.co.za',
            password: 'admin123',
            phone: '0123456000',
            firstName: 'Admin',
            surname: 'User',
            dateCreated: new Date().toISOString()
        });
    }
    
    if (newUsers.length > 0) {
        // Add new users to existing data
        const allData = [...data, ...newUsers];
        
        // Write back to Excel
        wb.Sheets['Users'] = XLSX.utils.json_to_sheet(allData);
        XLSX.writeFile(wb, 'logins.xlsx');
        
        console.log(`✅ Added ${newUsers.length} new user(s)`);
        newUsers.forEach(user => {
            const mask = p => { if(!p) return '<none>'; if(p.length<=4) return p[0]+'***'; return p[0]+'***'+p.slice(-1); };
            console.log(`   📧 ${user.email} / 🔑 ${mask(user.password)}`);
        });
    } else {
        console.log('✅ Test users already exist');
    }
    
    console.log('\n📋 Current users in database:');
    const currentData = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
    currentData.forEach((user, i) => {
        console.log(`${i+1}. ${user.email} (${user.firstName} ${user.surname})`);
    });
    
} catch (error) {
    console.error('❌ Error:', error.message);
}

console.log('\n🌐 Try logging in at: http://10.5.48.94:3151/login.html');
console.log('📧 Email: test@test.com');
console.log('🔑 Password: test***');
