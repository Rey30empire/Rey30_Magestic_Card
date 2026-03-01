# Control de Versiones (Git) - Rey30_Magestic_Card

## Objetivo
- Tener rollback seguro de cambios por fase.
- Mantener checkpoints reproducibles antes de cada paquete lowcoding.

## Flujo recomendado
1. Inicializar repositorio local:
   - `git init`
   - `git branch -M main`
2. Definir identidad local:
   - `git config user.name "ReyCAD Local"`
   - `git config user.email "local@reycad.dev"`
3. Crear checkpoint de fase:
   - `pwsh -NoProfile -File scripts/git-version-control.ps1 -Message "fase-7.6 hardening"`
4. Crear checkpoint con tag:
   - `pwsh -NoProfile -File scripts/git-version-control.ps1 -Message "pre-fase-8" -Tag`
5. Ver historial:
   - `git log --oneline --decorate -n 30`
6. Rollback por commit:
   - `git revert <commit>`
7. Rollback por tag:
   - `git checkout <tag>`

## Convención de commits
- `fase-<n>.<m>: <descripcion>`
- `fix: <descripcion>`
- `security: <descripcion>`
- `perf: <descripcion>`
- `docs: <descripcion>`

## Convención de tags
- `checkpoint-YYYYMMDD-HHMMSS`
- `release-vX.Y.Z`

## Nota de seguridad
- No guardar tokens, claves SSH o secretos en commits.
- Si una credencial se expone, rotarla inmediatamente.
