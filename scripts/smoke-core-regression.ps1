$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4028 }
$baseUrl = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$dbPath = Join-Path $repoRoot "data\smoke-core-regression.db"
$serverOut = Join-Path $repoRoot ".smoke-core-regression.out.log"
$serverErr = Join-Path $repoRoot ".smoke-core-regression.err.log"

if (Test-Path $serverOut) { Remove-Item $serverOut -Force }
if (Test-Path $serverErr) { Remove-Item $serverErr -Force }
if (Test-Path $dbPath) { Remove-Item $dbPath -Force }

$server = $null

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers,
    $BodyObj
  )

  $params = @{
    Method = $Method
    Uri = $Uri
    Headers = $Headers
    SkipHttpErrorCheck = $true
  }

  if ($null -ne $BodyObj) {
    $params["Body"] = ($BodyObj | ConvertTo-Json -Depth 20)
    $params["ContentType"] = "application/json"
  }

  $resp = Invoke-WebRequest @params
  $json = $null
  if ($resp.Content) {
    try { $json = $resp.Content | ConvertFrom-Json -Depth 20 } catch { $json = $null }
  }

  [pscustomobject]@{
    StatusCode = [int]$resp.StatusCode
    Body = $json
    Raw = $resp.Content
  }
}

try {
  $env:PORT = "$smokePort"
  $env:DB_PATH = $dbPath
  $server = Start-Process -FilePath node -ArgumentList "dist/index.js" -WorkingDirectory $repoRoot -PassThru -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 300
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method GET -TimeoutSec 2
      if ($health.ok -eq $true) {
        $healthy = $true
        break
      }
    } catch {
      # retry
    }
  }

  if (-not $healthy) {
    throw "Server health failed"
  }

  $app = Invoke-Api -Method "GET" -Uri "$baseUrl/app" -Headers @{} -BodyObj $null
  $reycad = Invoke-Api -Method "GET" -Uri "$baseUrl/reycad" -Headers @{} -BodyObj $null
  $cardsPublic = Invoke-Api -Method "GET" -Uri "$baseUrl/api/cards" -Headers @{ "x-client-platform" = "web" } -BodyObj $null

  $suffix = Get-Random -Minimum 10000 -Maximum 99999
  $username = "core_reg_user_$suffix"
  $password = "SmokePass123!"
  $webHeaders = @{ "x-client-platform" = "web" }
  $register = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $username
    password = $password
  }

  if ($register.StatusCode -ne 201) {
    throw "Register failed: $($register.StatusCode)"
  }

  $token = [string]$register.Body.token
  $authHeaders = @{
    Authorization = "Bearer $token"
    "x-client-platform" = "web"
  }

  $agentsAuth = Invoke-Api -Method "GET" -Uri "$baseUrl/api/agents" -Headers $authHeaders -BodyObj $null
  $cardsAuth = Invoke-Api -Method "GET" -Uri "$baseUrl/api/cards" -Headers $authHeaders -BodyObj $null

  [pscustomobject]@{
    checks = [pscustomobject]@{
      app_ok = ($app.StatusCode -eq 200)
      reycad_ok = ($reycad.StatusCode -eq 200)
      cards_public_ok = ($cardsPublic.StatusCode -eq 200)
      agents_auth_ok = ($agentsAuth.StatusCode -eq 200)
      cards_auth_ok = ($cardsAuth.StatusCode -eq 200)
    }
    http = [pscustomobject]@{
      app = $app.StatusCode
      reycad = $reycad.StatusCode
      cardsPublic = $cardsPublic.StatusCode
      agentsAuth = $agentsAuth.StatusCode
      cardsAuth = $cardsAuth.StatusCode
    }
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
