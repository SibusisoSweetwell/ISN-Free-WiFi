# Cleanup script: untrack temporary diagnostic and sqlite artifacts and update git index
$patterns = @('.tmp_*','*.sqlite-wal','*.sqlite-shm','*.db-wal','*.db-shm')
foreach($p in $patterns){
	$files = git ls-files $p
	if ($files) {
		$files | ForEach-Object { git rm --cached --ignore-unmatch $_ }
	}
}

# Stage .gitignore and any intentional changes
git add .gitignore login.html scripts/cleanup_repo.ps1
$commit = git commit -m "Cleanup: untrack temp and sqlite artifacts; add cleanup script"
if ($LASTEXITCODE -ne 0) { Write-Output 'Nothing to commit' } else { Write-Output 'Committed cleanup' }
$push = git push
if ($LASTEXITCODE -ne 0) { Write-Output 'Push may have failed' } else { Write-Output 'Pushed cleanup' }
Write-Output 'Cleanup script finished.'
