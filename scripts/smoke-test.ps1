$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4011 }
$baseUrl = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-test.db"
$serverOut = Join-Path $repoRoot ".smoke-server.out.log"
$serverErr = Join-Path $repoRoot ".smoke-server.err.log"

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
  $userName = "smoke_user_$suffix"
  $adminName = "smoke_admin_$suffix"
  $password = "SmokePass123!"

  $webHeaders = @{ "x-client-platform" = "web" }

  $registerUser = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $userName
    password = $password
  }
  $registerAdmin = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/register" -Headers $webHeaders -BodyObj @{
    username = $adminName
    password = $password
  }

  if ($registerUser.StatusCode -ne 201 -or $registerAdmin.StatusCode -ne 201) {
    throw "Register failed. user=$($registerUser.StatusCode) admin=$($registerAdmin.StatusCode)"
  }

  $adminUserId = [string]$registerAdmin.Body.user.id

  $promoteScript = @'
const sqlite3 = require("sqlite3").verbose();
const userId = process.argv[2];
const db = new sqlite3.Database(process.env.DB_PATH || "data/rey30.db");
const now = new Date().toISOString();

function fail(err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

db.serialize(() => {
  db.get("SELECT id FROM roles WHERE key = 'admin'", (err, roleRow) => {
    if (err) return fail(err);
    if (!roleRow) return fail(new Error("admin role not found"));

    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userId], (err2) => {
      if (err2) return fail(err2);

      db.run(
        "INSERT OR IGNORE INTO user_roles (id, user_id, role_id, assigned_by, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, NULL, ?)",
        [userId, roleRow.id, now],
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

  $promoteOut = $promoteScript | node - $adminUserId
  if (-not ($promoteOut -match "PROMOTED_ADMIN")) {
    throw "Admin promotion failed: $promoteOut"
  }

  $loginUser = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/login" -Headers $webHeaders -BodyObj @{
    username = $userName
    password = $password
  }
  $loginAdmin = Invoke-Api -Method "POST" -Uri "$baseUrl/api/auth/login" -Headers $webHeaders -BodyObj @{
    username = $adminName
    password = $password
  }
  if ($loginUser.StatusCode -ne 200 -or $loginAdmin.StatusCode -ne 200) {
    throw "Login failed. user=$($loginUser.StatusCode) admin=$($loginAdmin.StatusCode)"
  }

  $userToken = [string]$loginUser.Body.token
  $adminToken = [string]$loginAdmin.Body.token

  $userWebAuth = @{
    Authorization = "Bearer $userToken"
    "x-client-platform" = "web"
  }
  $userDesktopAuth = @{
    Authorization = "Bearer $userToken"
    "x-client-platform" = "desktop"
  }
  $userMobileAuth = @{
    Authorization = "Bearer $userToken"
    "x-client-platform" = "mobile"
  }
  $adminWebAuth = @{
    Authorization = "Bearer $adminToken"
    "x-client-platform" = "web"
  }

  $createAgent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents" -Headers $userWebAuth -BodyObj @{
    name = "Astra_$suffix"
    role = "strategist"
    detail = "Smoke test agent"
    personality = "calm"
    lore = "created by smoke test"
    memoryScope = "private"
  }
  $agentId = [string]$createAgent.Body.id

  $connectAgent = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents/$agentId/connect" -Headers $userDesktopAuth -BodyObj @{
    provider = "api"
    model = "dummy-local"
    apiKey = "dummy_secret_12345"
    params = @{
      temperature = 0.2
    }
  }

  $sandboxTest = Invoke-Api -Method "POST" -Uri "$baseUrl/api/agents/$agentId/sandbox-test" -Headers $userWebAuth -BodyObj @{
    dryRunInput = @{
      prompt = "run smoke sandbox"
    }
  }

  $creatorApply = Invoke-Api -Method "POST" -Uri "$baseUrl/api/creators/apply" -Headers $userWebAuth -BodyObj @{
    message = "I want to join approved creators for smoke validation flow."
  }

  $createInvite = Invoke-Api -Method "POST" -Uri "$baseUrl/api/admin/invites" -Headers $adminWebAuth -BodyObj @{
    role = "approvedCreator"
    maxUses = 1
    permissionGrants = @("publish.agent_template", "dev_tools.access")
  }
  $inviteCode = if ($createInvite.Body) { [string]$createInvite.Body.code } else { "" }

  $redeemInvite = Invoke-Api -Method "POST" -Uri "$baseUrl/api/creators/redeem-invite" -Headers $userWebAuth -BodyObj @{
    code = $inviteCode
  }
  $creatorStatus = Invoke-Api -Method "GET" -Uri "$baseUrl/api/creators/status" -Headers $userWebAuth -BodyObj $null
  $meStatus = Invoke-Api -Method "GET" -Uri "$baseUrl/api/me" -Headers $userWebAuth -BodyObj $null

  $trainingMobile = Invoke-Api -Method "POST" -Uri "$baseUrl/api/training/jobs" -Headers $userMobileAuth -BodyObj @{
    mode = "fine-tuning"
    config = @{
      epochs = 1
    }
  }

  $trainingDesktop = Invoke-Api -Method "POST" -Uri "$baseUrl/api/training/jobs" -Headers $userDesktopAuth -BodyObj @{
    mode = "fine-tuning"
    config = @{
      epochs = 1
    }
  }

  $trainingList = Invoke-Api -Method "GET" -Uri "$baseUrl/api/training/jobs" -Headers $userDesktopAuth -BodyObj $null

  $roles = @()
  if ($creatorStatus.Body -and $creatorStatus.Body.roles) {
    $roles = @($creatorStatus.Body.roles)
  }

  $result = [pscustomobject]@{
    users = [pscustomobject]@{
      user = $userName
      admin = $adminName
    }
    checks = [pscustomobject]@{
      register_login = ($registerUser.StatusCode -eq 201 -and $registerAdmin.StatusCode -eq 201 -and $loginUser.StatusCode -eq 200 -and $loginAdmin.StatusCode -eq 200)
      create_agent_disconnected = ($createAgent.StatusCode -eq 201 -and [string]$createAgent.Body.status -eq "disconnected")
      connect_agent_dummy = ($connectAgent.StatusCode -eq 200 -and [string]$connectAgent.Body.status -eq "connected")
      sandbox_test_ok = ($sandboxTest.StatusCode -eq 200 -and [string]$sandboxTest.Body.status -in @("passed", "failed"))
      creator_apply = ($creatorApply.StatusCode -in @(200, 201) -and [string]$creatorApply.Body.status -eq "pending")
      admin_generate_invite = ($createInvite.StatusCode -eq 201 -and -not [string]::IsNullOrWhiteSpace($inviteCode))
      redeem_invite = ($redeemInvite.StatusCode -eq 200 -and ($roles -contains "approvedCreator"))
      training_mobile_blocked = ($trainingMobile.StatusCode -eq 403)
      training_desktop_allowed = ($trainingDesktop.StatusCode -eq 201)
    }
    http = [pscustomobject]@{
      registerUser = $registerUser.StatusCode
      registerAdmin = $registerAdmin.StatusCode
      loginUser = $loginUser.StatusCode
      loginAdmin = $loginAdmin.StatusCode
      createAgent = $createAgent.StatusCode
      connectAgent = $connectAgent.StatusCode
      sandboxTest = $sandboxTest.StatusCode
      creatorApply = $creatorApply.StatusCode
      createInvite = $createInvite.StatusCode
      redeemInvite = $redeemInvite.StatusCode
      creatorsStatus = $creatorStatus.StatusCode
      me = $meStatus.StatusCode
      trainingMobile = $trainingMobile.StatusCode
      trainingDesktop = $trainingDesktop.StatusCode
      trainingList = $trainingList.StatusCode
    }
    details = [pscustomobject]@{
      agentId = $agentId
      sandboxStatus = if ($sandboxTest.Body) { [string]$sandboxTest.Body.status } else { $null }
      inviteCode = $inviteCode
      creatorRoles = $roles
      meRole = if ($meStatus.Body) { [string]$meStatus.Body.role } else { $null }
      mePlatform = if ($meStatus.Body) { [string]$meStatus.Body.platform } else { $null }
      mobileTrainingError = if ($trainingMobile.Body) { $trainingMobile.Body.error } else { $null }
      desktopTrainingJobId = if ($trainingDesktop.Body) { [string]$trainingDesktop.Body.id } else { $null }
      desktopTrainingStatus = if ($trainingDesktop.Body) { [string]$trainingDesktop.Body.status } else { $null }
      trainingJobsCount = if ($trainingList.Body -and $trainingList.Body.items) { @($trainingList.Body.items).Count } else { 0 }
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
