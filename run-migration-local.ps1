# run-migration-local.ps1
# Non-interactive migration run: disable scheduled task, stop node, install deps, run migration and tests
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$log = Join-Path $PSScriptRoot 'migration_run.txt'
if(Test-Path $log) { Remove-Item $log -Force }

"=== migration run started: $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

"-- scheduled task: check/disable --" | Out-File $log -Append
try {
    schtasks /Query /TN "ISN-Free-WiFi-Server" 2>&1 | Out-File tasks_check.txt -Encoding utf8
    schtasks /End /TN "ISN-Free-WiFi-Server" /F 2>>tasks_check.txt
    schtasks /Change /TN "ISN-Free-WiFi-Server" /Disable 2>>tasks_check.txt
    Get-Content tasks_check.txt -ErrorAction SilentlyContinue | Out-File $log -Append -Encoding utf8
} catch {
    "No scheduled task found or error: $_" | Out-File $log -Append
}

"-- kill node processes --" | Out-File $log -Append
try { Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.ProcessId } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } catch {}
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | Out-String | Out-File $log -Append

"-- netstat (listening for 3150/8082) --" | Out-File $log -Append
try { netstat -ano | Select-String ":3150" | Out-File -Append $log -Encoding utf8 } catch {}
try { netstat -ano | Select-String ":8082" | Out-File -Append $log -Encoding utf8 } catch {}

"-- npm ci --" | Out-File $log -Append
try {
    npm ci --no-audit --no-fund 2>&1 | Out-File -Append $log -Encoding utf8
} catch {
    "npm ci failed: $_" | Out-File -Append $log
}

"-- run migration --" | Out-File $log -Append
try {
    node migrate-users-to-sqlite.js 2>&1 | Out-File -Append $log -Encoding utf8
} catch {
    "migration script failed: $_" | Out-File -Append $log
}

"-- run sqlite normalization test --" | Out-File $log -Append
try {
    node test-sqlite-normalization.js 2>&1 | Out-File -Append $log -Encoding utf8
} catch {
    "test script failed: $_" | Out-File -Append $log
}

"=== migration run finished: $(Get-Date -Format o) ===" | Out-File -Append $log

# Print last 200 lines for quick inspection
Get-Content $log -Tail 200 | ForEach-Object { Write-Output $_ }

# Exit cleanly
exit 0
