$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4013 }
$base = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-projects.db"
$server = $null

try {
  $env:PORT = "$smokePort"
  $env:DB_PATH = $dbPath
  $server = Start-Process -FilePath node -ArgumentList "dist/index.js" -WorkingDirectory $repoRoot -PassThru

  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    try {
      $health = Invoke-RestMethod -Uri "$base/health" -Method GET -TimeoutSec 2
      if ($health.ok -eq $true) {
        $healthy = $true
        break
      }
    } catch {
      # retry
    }
  }

  if (-not $healthy) {
    throw "Health check failed"
  }

  $suffix = Get-Random -Minimum 10000 -Maximum 99999
  $username = "proj_user_$suffix"
  $password = "SmokePass123!"

  $register = Invoke-RestMethod -Uri "$base/api/auth/register" -Method POST -Headers @{ "x-client-platform" = "web" } -ContentType "application/json" -Body (@{
    username = $username
    password = $password
  } | ConvertTo-Json)

  $token = [string]$register.token
  $auth = @{
    Authorization = "Bearer $token"
    "x-client-platform" = "web"
  }

  $created = Invoke-RestMethod -Uri "$base/api/projects" -Method POST -Headers $auth -ContentType "application/json" -Body (@{
    name = "Project $suffix"
    description = "project smoke"
  } | ConvertTo-Json)

  $projectId = [string]$created.id
  $listed = Invoke-RestMethod -Uri "$base/api/projects?limit=20&offset=0" -Method GET -Headers $auth
  $loaded = Invoke-RestMethod -Uri "$base/api/projects/$projectId" -Method GET -Headers $auth
  $updated = Invoke-RestMethod -Uri "$base/api/projects/$projectId" -Method PATCH -Headers $auth -ContentType "application/json" -Body (@{
    status = "archived"
    description = "archived by smoke"
  } | ConvertTo-Json)
  $archived = Invoke-RestMethod -Uri "$base/api/projects/$projectId" -Method DELETE -Headers $auth

  [pscustomobject]@{
    projectId = $projectId
    listCount = @($listed.items).Count
    getStatus = $loaded.status
    patchStatus = $updated.status
    deleteStatus = $archived.status
  } | ConvertTo-Json -Depth 10
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  if (Test-Path $dbPath) {
    Start-Sleep -Milliseconds 300
    Remove-Item $dbPath -Force -ErrorAction SilentlyContinue
  }
}
