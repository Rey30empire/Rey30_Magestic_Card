$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4015 }
$base = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-agent-skills.db"
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
    $params["Body"] = ($BodyObj | ConvertTo-Json -Depth 30)
    $params["ContentType"] = "application/json"
  }

  $resp = Invoke-WebRequest @params
  $json = $null
  if ($resp.Content) {
    try {
      $json = $resp.Content | ConvertFrom-Json -Depth 35
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
  $username = "skills_user_$suffix"
  $adminName = "skills_admin_$suffix"
  $password = "SmokePass123!"

  $registerUser = Invoke-Api -Method "POST" -Uri "$base/api/auth/register" -Headers @{ "x-client-platform" = "web" } -BodyObj @{
    username = $username
    password = $password
  }
  $registerAdmin = Invoke-Api -Method "POST" -Uri "$base/api/auth/register" -Headers @{ "x-client-platform" = "web" } -BodyObj @{
    username = $adminName
    password = $password
  }

  $adminId = [string]$registerAdmin.Body.user.id
  $promoteScriptPath = Join-Path $repoRoot "scripts\promote-admin.cjs"
  $promoteOut = node $promoteScriptPath $adminId 2>&1
  if ($LASTEXITCODE -ne 0 -or -not ($promoteOut -match "PROMOTED_ADMIN")) {
    throw "admin promotion failed"
  }

  $loginUser = Invoke-Api -Method "POST" -Uri "$base/api/auth/login" -Headers @{ "x-client-platform" = "web" } -BodyObj @{
    username = $username
    password = $password
  }
  $loginAdmin = Invoke-Api -Method "POST" -Uri "$base/api/auth/login" -Headers @{ "x-client-platform" = "web" } -BodyObj @{
    username = $adminName
    password = $password
  }

  $userToken = [string]$loginUser.Body.token
  $adminToken = [string]$loginAdmin.Body.token
  $userAuth = @{
    Authorization = "Bearer $userToken"
    "x-client-platform" = "web"
  }
  $adminAuth = @{
    Authorization = "Bearer $adminToken"
    "x-client-platform" = "web"
  }

  $agent = Invoke-Api -Method "POST" -Uri "$base/api/agents" -Headers $userAuth -BodyObj @{
    name = "SkillAgent_$suffix"
    role = "assistant"
    detail = "skills smoke"
    memoryScope = "private"
  }
  $agentId = [string]$agent.Body.id

  $skill = Invoke-Api -Method "POST" -Uri "$base/api/skills" -Headers $adminAuth -BodyObj @{
    name = "skill_smoke_$suffix"
    version = "1.0.0"
    description = "smoke skill"
    inputSchema = @{
      type = "object"
      properties = @{
        prompt = @{ type = "string"; minLength = 1 }
      }
      required = @("prompt")
      additionalProperties = $false
    }
    outputSchema = @{
      type = "object"
      properties = @{
        answer = @{ type = "string"; minLength = 1 }
      }
      required = @("answer")
      additionalProperties = $false
    }
    requiredTools = @("agent.profileEcho")
    tests = @(
      @{
        name = "basic"
        input = @{ prompt = "hi" }
        expectedOutput = @{ answer = "ok" }
      }
    )
  }
  $skillId = [string]$skill.Body.id

  $assign = Invoke-Api -Method "POST" -Uri "$base/api/agents/$agentId/skills" -Headers $userAuth -BodyObj @{
    updates = @(
      @{
        skillId = $skillId
        enabled = $true
        config = @{ tone = "safe" }
      }
    )
  }

  $remove = Invoke-Api -Method "POST" -Uri "$base/api/agents/$agentId/skills" -Headers $userAuth -BodyObj @{
    updates = @(
      @{
        skillId = $skillId
        remove = $true
      }
    )
  }

  [pscustomobject]@{
    agentId = $agentId
    skillId = $skillId
    assignStatus = $assign.StatusCode
    removeStatus = $remove.StatusCode
    assignedSkillsCount = if ($assign.Body -and $assign.Body.skills) { @($assign.Body.skills).Count } else { 0 }
    remainingSkillsCount = if ($remove.Body -and $remove.Body.skills) { @($remove.Body.skills).Count } else { 0 }
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
