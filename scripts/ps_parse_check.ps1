$path = 'C:\Users\Teacher\ISN Free WiFi\scripts\cleanup_repo.ps1'
try {
    [void][System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$null,[ref]$null)
    Write-Output 'PARSE_OK'
} catch {
    Write-Output 'PARSE_FAILED'
    Write-Output $_.Exception.Message
    exit 1
}
