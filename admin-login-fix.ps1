# 🔧 Admin Account Checker & Creator
# This script helps create/check the admin account for sbusisosweetwell15@gmail.com

Write-Host "🔧 ISN Free WiFi - Admin Account Checker" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green

# Set working directory
Set-Location 'C:\Users\Teacher\ISN Free WiFi'

Write-Host "📁 Working directory: $(Get-Location)" -ForegroundColor Cyan
Write-Host ""

# Function to check if admin account exists
function Check-AdminAccount {
    Write-Host "🔍 Checking if admin account exists..." -ForegroundColor Yellow
    
    try {
        # Check SQLite database
        $result = node -e "
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data.sqlite');
        
        db.get('SELECT email, password, firstName, surname FROM users WHERE email = ?', ['sbusisosweetwell15@gmail.com'], (err, row) => {
            if (err) {
                console.log('ERROR:', err.message);
            } else if (row) {
                console.log('FOUND:', JSON.stringify(row));
            } else {
                console.log('NOT_FOUND');
            }
            db.close();
        });
        "
        
        if ($result -like "*FOUND:*") {
            $userData = $result -replace "FOUND:", "" | ConvertFrom-Json
            Write-Host "✅ Admin account found!" -ForegroundColor Green
            Write-Host "   📧 Email: $($userData.email)" -ForegroundColor Cyan
            Write-Host "   👤 Name: $($userData.firstName) $($userData.surname)" -ForegroundColor Cyan
            Write-Host "   🔐 Password: $($userData.password)" -ForegroundColor Red
            return $true
        } else {
            Write-Host "❌ Admin account not found in database" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "❌ Error checking database: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Function to create admin account
function Create-AdminAccount {
    Write-Host ""
    Write-Host "🔨 Creating admin account..." -ForegroundColor Yellow
    
    # Default admin credentials
    $adminEmail = "sbusisosweetwell15@gmail.com"
    $adminPassword = "Admin123!"
    $adminFirstName = "Sibusiso"
    $adminSurname = "Sweetwell"
    $adminDOB = "1990-01-01"
    
    Write-Host "📝 Using default credentials:" -ForegroundColor Cyan
    Write-Host "   📧 Email: $adminEmail" -ForegroundColor White
    Write-Host "   🔐 Password: $adminPassword" -ForegroundColor White
    Write-Host "   👤 Name: $adminFirstName $adminSurname" -ForegroundColor White
    
    try {
        # Insert into SQLite database
        $result = node -e "
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data.sqlite');
        
        const email = 'sbusisosweetwell15@gmail.com';
        const password = 'Admin123!';
        const firstName = 'Sibusiso';
        const surname = 'Sweetwell';
        const dob = '1990-01-01';
        const now = new Date().toISOString();
        
        db.run('INSERT OR REPLACE INTO users (email, password, firstName, surname, dob, dateCreatedISO, dateCreatedLocal) VALUES (?, ?, ?, ?, ?, ?, ?)', 
               [email, password, firstName, surname, dob, now, new Date().toString()], 
               function(err) {
                   if (err) {
                       console.log('ERROR:', err.message);
                   } else {
                       console.log('SUCCESS: Admin account created/updated');
                   }
                   db.close();
               });
        "
        
        if ($result -like "*SUCCESS*") {
            Write-Host "✅ Admin account created successfully!" -ForegroundColor Green
            return $true
        } else {
            Write-Host "❌ Failed to create admin account: $result" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "❌ Error creating admin account: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Function to show login instructions
function Show-LoginInstructions {
    Write-Host ""
    Write-Host "🎯 Login Instructions:" -ForegroundColor Green
    Write-Host "======================" -ForegroundColor Green
    Write-Host ""
    Write-Host "1. Open your browser and go to: http://localhost:3000/login.html" -ForegroundColor White
    Write-Host "2. Use these credentials:" -ForegroundColor White
    Write-Host "   📧 Email: sbusisosweetwell15@gmail.com" -ForegroundColor Cyan
    Write-Host "   🔐 Password: Admin123!" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "If that doesn't work, try these alternatives:" -ForegroundColor Yellow
    Write-Host "   🔐 Password: admin123" -ForegroundColor White
    Write-Host "   🔐 Password: password123" -ForegroundColor White
    Write-Host "   🔐 Password: sweetwell123" -ForegroundColor White
    Write-Host ""
    Write-Host "💡 If you still can't login:" -ForegroundColor Yellow
    Write-Host "   1. Check that the server is running (node server.js)" -ForegroundColor White
    Write-Host "   2. Make sure you're using http://localhost:3000 not 5500" -ForegroundColor White
    Write-Host "   3. Try clearing browser cache and cookies" -ForegroundColor White
}

# Main execution
Write-Host "Starting admin account check..." -ForegroundColor White
Write-Host ""

# Check if account exists
$accountExists = Check-AdminAccount

if (-not $accountExists) {
    Write-Host ""
    Write-Host "🔨 Admin account not found. Creating it now..." -ForegroundColor Yellow
    $created = Create-AdminAccount
    
    if ($created) {
        Write-Host ""
        Write-Host "✅ Admin account created! Checking again..." -ForegroundColor Green
        Check-AdminAccount
    }
}

Show-LoginInstructions

Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
