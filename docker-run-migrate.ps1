# Helper script: build docker image and run migration & tests inside container
$img = "isn-free-wifi:test"
Write-Host "Building Docker image $img..."
docker build -t $img .
if($LASTEXITCODE -ne 0){ Write-Error "Docker build failed"; exit 1 }

Write-Host "Running container to execute migration and tests..."
# Run migration then test script; copy logins.xlsx into container via mount
docker run --rm -v ${PWD}:/app -w /app $img pwsh -Command "node migrate-users-to-sqlite.js; node test-sqlite-normalization.js"
