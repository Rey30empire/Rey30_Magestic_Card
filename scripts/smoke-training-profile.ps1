$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4014 }
$base = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-training-profile.db"
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
  $username = "profile_user_$suffix"
  $password = "SmokePass123!"

  $register = Invoke-RestMethod -Uri "$base/api/auth/register" -Method POST -Headers @{ "x-client-platform" = "web" } -ContentType "application/json" -Body (@{
    username = $username
    password = $password
  } | ConvertTo-Json)

  $token = [string]$register.token
  $mobileAuth = @{
    Authorization = "Bearer $token"
    "x-client-platform" = "mobile"
  }

  $profileMode = Invoke-WebRequest -Uri "$base/api/training/jobs" -Method POST -Headers $mobileAuth -ContentType "application/json" -Body (@{
    mode = "profile-tuning"
    config = @{
      style = "safe"
    }
  } | ConvertTo-Json) -SkipHttpErrorCheck

  $heavyMode = Invoke-WebRequest -Uri "$base/api/training/jobs" -Method POST -Headers $mobileAuth -ContentType "application/json" -Body (@{
    mode = "fine-tuning"
    config = @{
      epochs = 1
    }
  } | ConvertTo-Json) -SkipHttpErrorCheck

  [pscustomobject]@{
    profileTuningStatus = [int]$profileMode.StatusCode
    heavyModeStatus = [int]$heavyMode.StatusCode
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
