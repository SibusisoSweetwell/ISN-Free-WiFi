#!/usr/bin/env pwsh
# Cleanup script: untrack temporary diagnostic and sqlite artifacts and update git index
$patterns = @('.tmp_*','*.sqlite-wal','*.sqlite-shm','*.db-wal','*.db-shm')

foreach ($p in $patterns) {
    # Use -- to ensure patterns are treated as pathspecs, and capture output safely
    $files = & git ls-files -- $p 2>$null
    if ($files) {
        $files | ForEach-Object { & git rm --cached --ignore-unmatch -- $_ }
    }
}

# Stage .gitignore and this script (if present)
& git add -- .gitignore login.html scripts/cleanup_repo.ps1 2>$null

# Commit if there are staged changes
$commitOutput = & git commit -m "Cleanup: untrack temp and sqlite artifacts; add cleanup script" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Output 'Nothing to commit or commit failed:'
    Write-Output $commitOutput
} else {
    Write-Output 'Committed cleanup'
    $pushOutput = & git push 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'Push may have failed:'
        Write-Output $pushOutput
    } else {
        Write-Output 'Pushed cleanup'
    }
}

Write-Output 'Cleanup script finished.'
