param(
  [string]$Message = "checkpoint",
  [switch]$Tag
)

$ErrorActionPreference = "Stop"

function Ensure-GitRepo {
  if (-not (Test-Path ".git")) {
    git init | Out-Null
    git branch -M main
  }
}

function Ensure-GitIdentity {
  $name = git config user.name
  if ([string]::IsNullOrWhiteSpace($name)) {
    git config user.name "ReyCAD Local"
  }

  $email = git config user.email
  if ([string]::IsNullOrWhiteSpace($email)) {
    git config user.email "local@reycad.dev"
  }
}

Ensure-GitRepo
Ensure-GitIdentity

git add -A
$staged = git diff --cached --name-only
if ([string]::IsNullOrWhiteSpace($staged)) {
  Write-Host "No hay cambios para commit."
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$commitMessage = "$Message [$stamp]"
git commit -m $commitMessage | Out-Host

if ($Tag.IsPresent) {
  $tagName = "checkpoint-$stamp"
  git tag $tagName
  Write-Host "Tag creado: $tagName"
}

Write-Host "Checkpoint completado."
