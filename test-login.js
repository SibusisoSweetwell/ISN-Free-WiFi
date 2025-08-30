const XLSX = require('xlsx');
const crypto = require('crypto');

// Check existing users
console.log('=== Checking User Database ===');
try {
    const wb = XLSX.readFile('logins.xlsx');
    
    if (wb.Sheets['Users']) {
        const data = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
        console.log(`Users found: ${data.length}`);
        
        if (data.length > 0) {
            console.log('\nExisting users:');
            data.forEach((user, i) => {
                console.log(`${i+1}. Email: ${user.email || 'N/A'}, Phone: ${user.phone || 'N/A'}`);
            });
        } else {
            console.log('No users found in database');
        }
    } else {
        console.log('No Users sheet found - database may be empty');
    }
} catch (err) {
    console.log('Error reading user database:', err.message);
}

// Create a test user if none exist
console.log('\n=== Creating Test User ===');
try {
    const wb = XLSX.readFile('logins.xlsx');
    
    // Ensure Users sheet exists
    if (!wb.Sheets['Users']) {
        wb.Sheets['Users'] = XLSX.utils.aoa_to_sheet([]);
    }
    
    const data = XLSX.utils.sheet_to_json(wb.Sheets['Users']);
    
    // Check if test user already exists
    const testUser = data.find(u => u.email === 'test@test.com');
    
    if (!testUser) {
        // Add test user
        data.push({
            email: 'test@test.com',
            password: 'test123',
            phone: '0123456789',
            firstName: 'Test',
            surname: 'User',
            dateCreated: new Date().toISOString()
        });
        
        // Write back to Excel
        wb.Sheets['Users'] = XLSX.utils.json_to_sheet(data);
        XLSX.writeFile(wb, 'logins.xlsx');
        
    console.log('✅ Test user created:');
    console.log('   Email: test@test.com');
    console.log('   Password: test***');
    } else {
    console.log('✅ Test user already exists:');
    console.log('   Email: test@test.com');
    console.log('   Password: test***');
    }
} catch (err) {
    console.log('❌ Error creating test user:', err.message);
}

console.log('\n=== Test Complete ===');
console.log('You can now try logging in with:');
console.log('Email: test@test.com');
console.log('Password: test***');
console.log('URL: http://10.5.48.94:3151/login.html (note port 3151, not 3150)');
