$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4026 }
$baseUrl = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$dbPath = Join-Path $repoRoot "data\smoke-policy-events.db"
$serverOut = Join-Path $repoRoot ".smoke-policy-events.out.log"
$serverErr = Join-Path $repoRoot ".smoke-policy-events.err.log"

if (Test-Path $serverOut) {
  Remove-Item $serverOut -Force
}
if (Test-Path $serverErr) {
  Remove-Item $serverErr -Force
}
if (Test-Path $dbPath) {
  Remove-Item $dbPath -Force
}

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
    try {
      $json = $resp.Content | ConvertFrom-Json -Depth 30
    } catch {
      $json = $null
    }
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
    $errLog = if (Test-Path $serverErr) { Get-Content $serverErr -Raw } else { "" }
    $outLog = if (Test-Path $serverOut) { Get-Content $serverOut -Raw } else { "" }
    throw "Server health failed. stdout=$outLog stderr=$errLog"
  }

  $suffix = Get-Random -Minimum 10000 -Maximum 99999
  $username = "policy_user_$suffix"
  $password = "SmokePass123!"
  $webHeaders = @{ "x-client-platform" = "web" }

  $register = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $username
    password = $password
  }
  $login = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/login" -Headers $webHeaders -BodyObj @{
    username = $username
    password = $password
  }

  if ($register.StatusCode -ne 201 -or $login.StatusCode -ne 200) {
    throw "Auth failed. register=$($register.StatusCode) login=$($login.StatusCode)"
  }

  $token = [string]$login.Body.token
  $authHeaders = @{
    Authorization = "Bearer $token"
    "x-client-platform" = "web"
  }

  $validEvent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/me/ai-config/policy-events" -Headers $authHeaders -BodyObj @{
    event = "blocked_tool"
    tool = "create_material"
    reason = "permission materials disabled"
    source = "editor"
  }

  $invalidEvent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/me/ai-config/policy-events" -Headers $authHeaders -BodyObj @{
    event = "blocked_tool"
    tool = "x"
    reason = "x"
    source = "invalid-source"
  }

  [pscustomobject]@{
    checks = [pscustomobject]@{
      auth_ok = ($register.StatusCode -eq 201 -and $login.StatusCode -eq 200)
      policy_event_valid = ($validEvent.StatusCode -eq 200)
      policy_event_invalid_payload_rejected = ($invalidEvent.StatusCode -eq 400)
    }
    http = [pscustomobject]@{
      register = $register.StatusCode
      login = $login.StatusCode
      validPolicyEvent = $validEvent.StatusCode
      invalidPolicyEvent = $invalidEvent.StatusCode
    }
    details = [pscustomobject]@{
      invalidError = if ($invalidEvent.Body) { [string]$invalidEvent.Body.error } else { $null }
    }
  } | ConvertTo-Json -Depth 20
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  if (Test-Path $dbPath) {
    Start-Sleep -Milliseconds 300
    Remove-Item $dbPath -Force -ErrorAction SilentlyContinue
  }
}
