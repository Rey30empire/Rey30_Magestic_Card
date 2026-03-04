$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$manifestPath = Join-Path $repoRoot "artifacts\reycad-play\play-session.manifest.json"
$projectPath = Join-Path $repoRoot "artifacts\reycad-play\scene.project.json"

function Get-PropCount {
  param($Obj)
  if ($null -eq $Obj) {
    return 0
  }
  return @($Obj.PSObject.Properties).Count
}

Push-Location $repoRoot
try {
  npm run reycad:ci:play-gate
  if ($LASTEXITCODE -ne 0) {
    throw "PIE gate failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-Path $manifestPath)) {
    throw "Missing manifest file: $manifestPath"
  }
  if (-not (Test-Path $projectPath)) {
    throw "Missing project file: $projectPath"
  }

  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json -Depth 60
  $project = Get-Content $projectPath -Raw | ConvertFrom-Json -Depth 60

  $nodeCount = Get-PropCount $project.nodes
  $materialCount = Get-PropCount $project.materials
  $textureCount = Get-PropCount $project.textures

  $checks = [pscustomobject]@{
    manifest_kind_ok = ([string]$manifest.kind -eq "reycad_play_session_manifest_v1")
    node_count_ok = ([int]$manifest.summary.nodeCount -eq $nodeCount)
    material_count_ok = ([int]$manifest.summary.materialCount -eq $materialCount)
    texture_count_ok = ([int]$manifest.summary.textureCount -eq $textureCount)
  }

  $result = [pscustomobject]@{
    generatedAt = [string]$manifest.generatedAt
    preset = [string]$manifest.preset
    source = [string]$manifest.source
    counts = [pscustomobject]@{
      nodes = $nodeCount
      materials = $materialCount
      textures = $textureCount
    }
    checks = $checks
  }

  $result | ConvertTo-Json -Depth 20

  if (-not ($checks.manifest_kind_ok -and $checks.node_count_ok -and $checks.material_count_ok -and $checks.texture_count_ok)) {
    throw "PIE smoke checks failed"
  }
} finally {
  Pop-Location
}
