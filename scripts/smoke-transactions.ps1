$ErrorActionPreference = "Stop"

$smokePort = if ($env:SMOKE_PORT) { [int]$env:SMOKE_PORT } else { 4010 }
$base = if ($env:SMOKE_BASE_URL) { $env:SMOKE_BASE_URL } else { "http://localhost:$smokePort" }
$repoRoot = (Resolve-Path "$PSScriptRoot\\..").Path
$dbPath = Join-Path $repoRoot "data\\smoke-transactions.db"
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
    } catch {}
  }
  if (-not $healthy) {
    throw "Health failed"
  }

  $suffix = Get-Random -Minimum 10000 -Maximum 99999
  $sellerName = "txn_seller_$suffix"
  $buyerName = "txn_buyer_$suffix"
  $adminName = "txn_admin_$suffix"
  $password = "SmokePass123!"

  $regSeller = Invoke-Api -Method "POST" -Uri "$base/api/auth/register" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $sellerName; password = $password }
  $regBuyer = Invoke-Api -Method "POST" -Uri "$base/api/auth/register" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $buyerName; password = $password }
  $regAdmin = Invoke-Api -Method "POST" -Uri "$base/api/auth/register" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $adminName; password = $password }

  $adminId = [string]$regAdmin.Body.user.id
  $promoteScript = @'
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(process.env.DB_PATH || "data/rey30.db");
const id = process.argv[2];
const now = new Date().toISOString();
db.serialize(() => {
  db.get("SELECT id FROM roles WHERE key='admin'", (e, role) => {
    if (e || !role) { console.error(e ? e.message : "missing role"); process.exit(1); }
    db.run("UPDATE users SET role='admin' WHERE id=?", [id], (e2) => {
      if (e2) { console.error(e2.message); process.exit(1); }
      db.run(
        "INSERT OR IGNORE INTO user_roles (id,user_id,role_id,assigned_by,created_at) VALUES (lower(hex(randomblob(16))),?,?,NULL,?)",
        [id, role.id, now],
        (e3) => { if (e3) { console.error(e3.message); process.exit(1); } console.log("OK"); db.close(); }
      );
    });
  });
});
'@
  $promote = $promoteScript | node - $adminId
  if (-not ($promote -match "OK")) { throw "promote failed" }

  $sellerLogin = Invoke-Api -Method "POST" -Uri "$base/api/auth/login" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $sellerName; password = $password }
  $buyerLogin = Invoke-Api -Method "POST" -Uri "$base/api/auth/login" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $buyerName; password = $password }
  $adminLogin = Invoke-Api -Method "POST" -Uri "$base/api/auth/login" -Headers @{ "x-client-platform" = "web" } -BodyObj @{ username = $adminName; password = $password }

  $sellerAuth = @{ Authorization = "Bearer $($sellerLogin.Body.token)"; "x-client-platform" = "web" }
  $buyerAuth = @{ Authorization = "Bearer $($buyerLogin.Body.token)"; "x-client-platform" = "web" }
  $adminAuth = @{ Authorization = "Bearer $($adminLogin.Body.token)"; "x-client-platform" = "web" }

  $sellerCard = Invoke-Api -Method "POST" -Uri "$base/api/cards" -Headers $sellerAuth -BodyObj @{
    name = "TxnCard$suffix"
    rarity = "common"
    cardClass = "warrior"
    abilities = @("strike")
    summonCost = 1
    energy = 3
    baseStats = @{ attack = 4; defense = 4; speed = 4 }
    isOriginal = $true
  }
  $sellerCards = Invoke-Api -Method "GET" -Uri "$base/api/cards?ownerUserId=$($sellerLogin.Body.user.id)" -Headers @{ "x-client-platform" = "web" } -BodyObj $null
  $cardId = [string]$sellerCards.Body.items[0].id

  $listing = Invoke-Api -Method "POST" -Uri "$base/api/marketplace/listings" -Headers $sellerAuth -BodyObj @{
    cardId = $cardId
    priceCredits = 1
  }
  $listingId = [string]$listing.Body.listingId

  $buyFirst = Invoke-Api -Method "POST" -Uri "$base/api/marketplace/listings/$listingId/buy" -Headers $buyerAuth -BodyObj @{}
  $buySecond = Invoke-Api -Method "POST" -Uri "$base/api/marketplace/listings/$listingId/buy" -Headers $buyerAuth -BodyObj @{}

  $applyBuyer = Invoke-Api -Method "POST" -Uri "$base/api/creators/apply" -Headers $buyerAuth -BodyObj @{
    message = "transaction smoke creator app"
  }
  $invite = Invoke-Api -Method "POST" -Uri "$base/api/admin/invites" -Headers $adminAuth -BodyObj @{
    role = "approvedCreator"
    maxUses = 1
    permissionGrants = @()
  }
  $inviteCode = [string]$invite.Body.code
  $redeemFirst = Invoke-Api -Method "POST" -Uri "$base/api/creators/redeem-invite" -Headers $buyerAuth -BodyObj @{ code = $inviteCode }
  $redeemSecond = Invoke-Api -Method "POST" -Uri "$base/api/creators/redeem-invite" -Headers $buyerAuth -BodyObj @{ code = $inviteCode }

  [pscustomobject]@{
    buyFirst = $buyFirst.StatusCode
    buySecond = $buySecond.StatusCode
    redeemFirst = $redeemFirst.StatusCode
    redeemSecond = $redeemSecond.StatusCode
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
