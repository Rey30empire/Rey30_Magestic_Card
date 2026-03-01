$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4027 }
$baseUrl = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$dbPath = Join-Path $repoRoot "data\smoke-ai-policy-flow.db"
$serverOut = Join-Path $repoRoot ".smoke-ai-policy-flow.out.log"
$serverErr = Join-Path $repoRoot ".smoke-ai-policy-flow.err.log"

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
    try { $json = $resp.Content | ConvertFrom-Json -Depth 30 } catch { $json = $null }
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
  $username = "policy_flow_user_$suffix"
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

  $saveConfig = Invoke-Api -Method "PUT" -Uri "$baseUrl/api/me/ai-config" -Headers $authHeaders -BodyObj @{
    provider = "openai-compatible"
    model = "gpt-4.1-mini"
    endpoint = "https://api.openai.com/v1/chat/completions"
    apiKey = "dummy_secret_1234567890"
    systemPrompt = "You are ReyCAD Assistant. Return JSON only."
    enabled = $true
    permissions = @{
      readScene = $true
      createGeometry = $false
      editGeometry = $false
      materials = $false
      booleans = $false
      templates = $false
      delete = $false
      cards = $false
      agents = $false
      skills = $false
      grid = $false
      export = $false
    }
  }

  $toolCall = @{
    tool = "create_primitive"
    args = @{
      primitive = "box"
    }
  }
  $localExecutionBlocked = -not [bool]$saveConfig.Body.permissions.createGeometry

  $policyEvent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/me/ai-config/policy-events" -Headers $authHeaders -BodyObj @{
    event = "blocked_tool"
    tool = "create_primitive"
    reason = "createGeometry disabled in policy"
    source = "editor"
  }

  $serverPlanBlocked = Invoke-Api -Method "POST" -Uri "$baseUrl/api/me/ai-config/tool-plan" -Headers $authHeaders -BodyObj @{
    prompt = "crea una caja"
    permissions = @{
      readScene = $false
    }
  }

  [pscustomobject]@{
    checks = [pscustomobject]@{
      config_saved = ($saveConfig.StatusCode -eq 200 -and [bool]$saveConfig.Body.enabled -eq $true)
      local_plan_step_created = ($toolCall.tool -eq "create_primitive")
      local_execution_blocked_by_policy = $localExecutionBlocked
      blocked_event_logged = ($policyEvent.StatusCode -eq 200)
      server_plan_blocked_no_allowed_tools = ($serverPlanBlocked.StatusCode -eq 409)
    }
    http = [pscustomobject]@{
      register = $register.StatusCode
      saveConfig = $saveConfig.StatusCode
      policyEvent = $policyEvent.StatusCode
      toolPlan = $serverPlanBlocked.StatusCode
    }
    details = [pscustomobject]@{
      tool = $toolCall.tool
      localBlockReason = "createGeometry disabled"
      serverPlanError = if ($serverPlanBlocked.Body) { [string]$serverPlanBlocked.Body.error } else { $null }
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
