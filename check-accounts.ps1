# ISN Free WiFi - Account & Password Checker
# This script checks all stored accounts and passwords in the system

Write-Host "🔍 ISN Free WiFi - Account & Password Checker" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""

# Function to check Excel file (logins.xlsx)
function Check-ExcelAccounts {
    Write-Host "📊 Checking Excel Database (logins.xlsx)..." -ForegroundColor Yellow
    
    $excelPath = ".\logins.xlsx"
    if (Test-Path $excelPath) {
        try {
            # Try to read Excel file using Import-Excel module
            if (Get-Module -ListAvailable -Name ImportExcel) {
                $users = Import-Excel -Path $excelPath -WorksheetName "Users"
                Write-Host "✅ Found $($users.Count) users in Excel database:" -ForegroundColor Green
                
                foreach ($user in $users) {
                    Write-Host "   📧 Email: $($user.email)" -ForegroundColor Cyan
                    Write-Host "   📱 Phone: $($user.phone)" -ForegroundColor Cyan
                    Write-Host "   👤 Name: $($user.firstName) $($user.surname)" -ForegroundColor Cyan
                    Write-Host "   🔐 Password: $($user.password)" -ForegroundColor Red
                    Write-Host "   📅 DOB: $($user.dob)" -ForegroundColor White
                    Write-Host "   ──────────────────────────" -ForegroundColor DarkGray
                }
            } else {
                Write-Host "⚠️  ImportExcel module not available. Install with: Install-Module ImportExcel" -ForegroundColor Yellow
                Write-Host "   Excel file exists but cannot be read without the module" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "❌ Error reading Excel file: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "❌ Excel file not found: $excelPath" -ForegroundColor Red
    }
    Write-Host ""
}

# Function to check SQLite database
function Check-SQLiteAccounts {
    Write-Host "🗄️  Checking SQLite Database (data.sqlite)..." -ForegroundColor Yellow
    
    $sqlitePath = ".\data.sqlite"
    if (Test-Path $sqlitePath) {
        try {
            # Check if sqlite3.exe is available
            $sqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
            if ($sqliteExe) {
                Write-Host "✅ SQLite database found. Querying users..." -ForegroundColor Green
                
                # Query users table
                $query = "SELECT email, phone, firstName, surname, password, dob FROM users;"
                $result = sqlite3 $sqlitePath $query
                
                if ($result) {
                    Write-Host "✅ Users found in SQLite:" -ForegroundColor Green
                    foreach ($line in $result) {
                        $fields = $line -split '\|'
                        if ($fields.Count -ge 6) {
                            Write-Host "   📧 Email: $($fields[0])" -ForegroundColor Cyan
                            Write-Host "   📱 Phone: $($fields[1])" -ForegroundColor Cyan
                            Write-Host "   👤 Name: $($fields[2]) $($fields[3])" -ForegroundColor Cyan
                            Write-Host "   🔐 Password: $($fields[4])" -ForegroundColor Red
                            Write-Host "   📅 DOB: $($fields[5])" -ForegroundColor White
                            Write-Host "   ──────────────────────────" -ForegroundColor DarkGray
                        }
                    }
                } else {
                    Write-Host "⚠️  No users found in SQLite database" -ForegroundColor Yellow
                }
            } else {
                Write-Host "⚠️  sqlite3 command not found. Install SQLite CLI tools" -ForegroundColor Yellow
                Write-Host "   Database exists but cannot be queried without sqlite3.exe" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "❌ Error reading SQLite database: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "❌ SQLite database not found: $sqlitePath" -ForegroundColor Red
    }
    Write-Host ""
}

# Function to check local storage (if browser data available)
function Check-LocalStorageAccounts {
    Write-Host "🌐 Checking Browser Local Storage..." -ForegroundColor Yellow
    Write-Host "⚠️  Browser local storage can only be checked from within the browser" -ForegroundColor Yellow
    Write-Host "   To check localStorage accounts:" -ForegroundColor White
    Write-Host "   1. Open browser Developer Tools (F12)" -ForegroundColor White
    Write-Host "   2. Go to Application > Local Storage" -ForegroundColor White
    Write-Host "   3. Look for 'isn_users' key" -ForegroundColor White
    Write-Host ""
}

# Function to check server logs for recent activity
function Check-ServerLogs {
    Write-Host "📋 Checking Server Logs for Account Activity..." -ForegroundColor Yellow
    
    $logFiles = @("server.log", "server_recent.log", "quick.log")
    
    foreach ($logFile in $logFiles) {
        if (Test-Path $logFile) {
            Write-Host "📄 Found log file: $logFile" -ForegroundColor Green
            
            # Search for login/registration patterns
            $loginPattern = Select-String -Path $logFile -Pattern "login|register|email|phone" -SimpleMatch | Select-Object -Last 10
            
            if ($loginPattern) {
                Write-Host "   Recent login/registration activity:" -ForegroundColor Cyan
                foreach ($match in $loginPattern) {
                    Write-Host "   $($match.Line)" -ForegroundColor White
                }
            } else {
                Write-Host "   No recent login/registration activity found" -ForegroundColor Gray
            }
        }
    }
    Write-Host ""
}

# Function to show database schema
function Show-DatabaseSchema {
    Write-Host "🏗️  Database Schema Information..." -ForegroundColor Yellow
    
    $sqlitePath = ".\data.sqlite"
    if (Test-Path $sqlitePath) {
        $sqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
        if ($sqliteExe) {
            Write-Host "📋 SQLite Tables:" -ForegroundColor Green
            $tables = sqlite3 $sqlitePath ".tables"
            Write-Host "   Tables: $tables" -ForegroundColor White
            
            Write-Host "📋 Users table schema:" -ForegroundColor Green
            $schema = sqlite3 $sqlitePath ".schema users"
            Write-Host "   $schema" -ForegroundColor White
        }
    }
    Write-Host ""
}

# Main execution
Write-Host "Starting account check..." -ForegroundColor White
Write-Host ""

# Change to the ISN Free WiFi directory
$targetPath = "C:\Users\Teacher\ISN Free WiFi"
if (Test-Path $targetPath) {
    Set-Location $targetPath
    Write-Host "📁 Working directory: $targetPath" -ForegroundColor Green
} else {
    Write-Host "❌ ISN Free WiFi directory not found at: $targetPath" -ForegroundColor Red
    Write-Host "   Using current directory: $(Get-Location)" -ForegroundColor Yellow
}
Write-Host ""

# Run all checks
Check-ExcelAccounts
Check-SQLiteAccounts
Check-LocalStorageAccounts
Check-ServerLogs
Show-DatabaseSchema

Write-Host "🔍 Account check completed!" -ForegroundColor Green
Write-Host ""
Write-Host "💡 Tips:" -ForegroundColor Yellow
Write-Host "   • To install ImportExcel module: Install-Module ImportExcel -Force" -ForegroundColor White
Write-Host "   • To install SQLite CLI: Download from https://sqlite.org/download.html" -ForegroundColor White
Write-Host "   • Check browser localStorage with F12 > Application > Local Storage" -ForegroundColor White
Write-Host ""
Write-Host "⚠️  Security Note: Passwords are stored in plain text for development" -ForegroundColor Red
Write-Host "   Consider implementing password hashing for production!" -ForegroundColor Red

# Pause to allow user to read results
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
