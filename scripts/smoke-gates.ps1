$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4012 }
$baseUrl = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-gates.db"
$serverOut = Join-Path $repoRoot ".smoke-gates-server.out.log"
$serverErr = Join-Path $repoRoot ".smoke-gates-server.err.log"

if (Test-Path $serverOut) {
  Remove-Item $serverOut -Force
}
if (Test-Path $serverErr) {
  Remove-Item $serverErr -Force
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
    $params["Body"] = ($BodyObj | ConvertTo-Json -Depth 25)
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
  $creatorName = "gates_creator_$suffix"
  $adminName = "gates_admin_$suffix"
  $password = "SmokePass123!"

  $webHeaders = @{ "x-client-platform" = "web" }
  $desktopHeaders = @{ "x-client-platform" = "desktop" }

  $regCreator = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $creatorName
    password = $password
  }
  $regAdmin = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $adminName
    password = $password
  }

  if ($regCreator.StatusCode -ne 201 -or $regAdmin.StatusCode -ne 201) {
    throw "Register failed. creator=$($regCreator.StatusCode) admin=$($regAdmin.StatusCode)"
  }

  $adminId = [string]$regAdmin.Body.user.id
  $creatorId = [string]$regCreator.Body.user.id

  $promoteScript = @'
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(process.env.DB_PATH || "data/rey30.db");
const adminUserId = process.argv[2];
const now = new Date().toISOString();

function fail(err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

db.serialize(() => {
  db.get("SELECT id FROM roles WHERE key = 'admin'", (err, roleRow) => {
    if (err) return fail(err);
    if (!roleRow) return fail(new Error("admin role not found"));

    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [adminUserId], (err2) => {
      if (err2) return fail(err2);

      db.run(
        "INSERT OR IGNORE INTO user_roles (id, user_id, role_id, assigned_by, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, NULL, ?)",
        [adminUserId, roleRow.id, now],
        (err3) => {
          if (err3) return fail(err3);
          console.log("PROMOTED_ADMIN");
          db.close();
        }
      );
    });
  });
});
'@

  $promoteOut = $promoteScript | node - $adminId
  if (-not ($promoteOut -match "PROMOTED_ADMIN")) {
    throw "Admin promotion failed: $promoteOut"
  }

  $loginCreator = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/login" -Headers $webHeaders -BodyObj @{
    username = $creatorName
    password = $password
  }
  $loginAdmin = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/login" -Headers $webHeaders -BodyObj @{
    username = $adminName
    password = $password
  }

  if ($loginCreator.StatusCode -ne 200 -or $loginAdmin.StatusCode -ne 200) {
    throw "Login failed. creator=$($loginCreator.StatusCode) admin=$($loginAdmin.StatusCode)"
  }

  $creatorToken = [string]$loginCreator.Body.token
  $adminToken = [string]$loginAdmin.Body.token

  $creatorWebAuth = @{
    Authorization = "Bearer $creatorToken"
    "x-client-platform" = "web"
  }
  $creatorDesktopAuth = @{
    Authorization = "Bearer $creatorToken"
    "x-client-platform" = "desktop"
  }
  $adminWebAuth = @{
    Authorization = "Bearer $adminToken"
    "x-client-platform" = "web"
  }

  $applyCreator = Invoke-Api -Method "POST" -Uri "$baseUrl/api/creators/apply" -Headers $creatorWebAuth -BodyObj @{
    message = "Gate smoke creator application."
  }
  if ($applyCreator.StatusCode -notin @(200, 201)) {
    throw "Creator apply failed: $($applyCreator.StatusCode)"
  }

  $invite = Invoke-Api -Method "POST" -Uri "$baseUrl/api/admin/invites" -Headers $adminWebAuth -BodyObj @{
    role = "approvedCreator"
    maxUses = 1
    permissionGrants = @("publish.agent_template", "dev_tools.access", "agents.tools.assign")
  }
  if ($invite.StatusCode -ne 201) {
    throw "Invite creation failed: $($invite.StatusCode)"
  }

  $inviteCode = [string]$invite.Body.code
  $redeem = Invoke-Api -Method "POST" -Uri "$baseUrl/api/creators/redeem-invite" -Headers $creatorWebAuth -BodyObj @{
    code = $inviteCode
  }
  if ($redeem.StatusCode -ne 200) {
    throw "Invite redeem failed: $($redeem.StatusCode)"
  }

  $createAgent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents" -Headers $creatorWebAuth -BodyObj @{
    name = "GateAgent_$suffix"
    role = "strategist"
    detail = "Gate checks"
    personality = "strict"
    lore = "gates smoke"
    memoryScope = "private"
  }
  if ($createAgent.StatusCode -ne 201) {
    throw "Agent create failed: $($createAgent.StatusCode)"
  }

  $agentId = [string]$createAgent.Body.id

  $assignTools = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents/$agentId/tools" -Headers $creatorWebAuth -BodyObj @{
    updates = @(
      @{
        toolKey = "agent.profileEcho"
        allowed = $true
        config = @{}
      }
    )
  }
  if ($assignTools.StatusCode -ne 200) {
    throw "Tool assignment failed: $($assignTools.StatusCode)"
  }

  # Must fail because sandbox has not run yet.
  $devToolBeforeSandbox = Invoke-Api -Method "POST" -Uri "$baseUrl/api/dev-tools/agent.profileEcho/run" -Headers $creatorWebAuth -BodyObj @{
    agentId = $agentId
    input = @{
      includeStatus = $true
    }
  }

  $publishBeforeSandbox = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agent-marketplace/templates" -Headers $creatorWebAuth -BodyObj @{
    agentId = $agentId
    name = "Template Before Sandbox $suffix"
    description = "Should fail due to sandbox gate"
    tags = @("gate", "before")
  }

  $sandbox = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents/$agentId/sandbox-test" -Headers $creatorWebAuth -BodyObj @{
    dryRunInput = @{
      prompt = "validate gates"
    }
  }
  if ($sandbox.StatusCode -ne 200) {
    throw "Sandbox test failed: $($sandbox.StatusCode)"
  }

  # Must pass after sandbox.
  $devToolAfterSandbox = Invoke-Api -Method "POST" -Uri "$baseUrl/api/dev-tools/agent.profileEcho/run" -Headers $creatorWebAuth -BodyObj @{
    agentId = $agentId
    input = @{
      includeStatus = $true
    }
  }

  $publishAfterSandbox = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agent-marketplace/templates" -Headers $creatorWebAuth -BodyObj @{
    agentId = $agentId
    name = "Template After Sandbox $suffix"
    description = "Should pass after sandbox"
    tags = @("gate", "after")
  }

  $result = [pscustomobject]@{
    users = [pscustomobject]@{
      creator = $creatorName
      admin = $adminName
      creatorId = $creatorId
      adminId = $adminId
    }
    checks = [pscustomobject]@{
      devtools_blocked_before_sandbox = ($devToolBeforeSandbox.StatusCode -eq 409)
      publish_blocked_before_sandbox = ($publishBeforeSandbox.StatusCode -eq 409)
      sandbox_test_ok = ($sandbox.StatusCode -eq 200 -and [string]$sandbox.Body.status -in @("passed", "failed"))
      devtools_allowed_after_sandbox = ($devToolAfterSandbox.StatusCode -eq 200)
      publish_allowed_after_sandbox = ($publishAfterSandbox.StatusCode -eq 201)
    }
    http = [pscustomobject]@{
      devToolBeforeSandbox = $devToolBeforeSandbox.StatusCode
      publishBeforeSandbox = $publishBeforeSandbox.StatusCode
      sandbox = $sandbox.StatusCode
      devToolAfterSandbox = $devToolAfterSandbox.StatusCode
      publishAfterSandbox = $publishAfterSandbox.StatusCode
    }
    details = [pscustomobject]@{
      agentId = $agentId
      sandboxStatus = if ($sandbox.Body) { [string]$sandbox.Body.status } else { $null }
      devToolBeforeReason = if ($devToolBeforeSandbox.Body) { [string]$devToolBeforeSandbox.Body.reason } else { $null }
      publishBeforeReason = if ($publishBeforeSandbox.Body) { [string]$publishBeforeSandbox.Body.reason } else { $null }
      publishedTemplateId = if ($publishAfterSandbox.Body) { [string]$publishAfterSandbox.Body.id } else { $null }
    }
  }

  $result | ConvertTo-Json -Depth 30
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  if (Test-Path $dbPath) {
    Start-Sleep -Milliseconds 300
    Remove-Item $dbPath -Force -ErrorAction SilentlyContinue
  }
}
