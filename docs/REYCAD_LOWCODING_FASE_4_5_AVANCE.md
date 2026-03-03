# ReyCAD Lowcoding - Avance Fase 4 y 5 (de 6)

## Estado
- Fecha: 2026-03-02
- Estado: completado (ver cierre global en `docs/REYCAD_LOWCODING_CIERRE_FINAL.md`).

## Fase 4 - Mannequin + Texture Upload
- `loadMannequin(kind)` implementado para:
  - `humanoid`
  - `creature`
  - `pet`
  - `floatingCard`
- Upload de texturas al proyecto (`project.textures`) con comandos undo/redo.
- Aplicación de textura a selección:
  - asigna `baseColorMapId` en materiales PBR.
  - si el nodo no tiene PBR, crea uno y lo asigna.
- Herramientas base de skin:
  - `recolorSelection(hex)`
  - `applyPatternToSelection(pattern)`
  - `saveSelectionVariant(name)` (checkpoint versionado).

## Fase 5 - Arena Generator
- `generateArena()` implementado:
  - terreno base,
  - plataforma central,
  - anillo de arena con boolean subtract,
  - pilares perimetrales.
- Ajuste de runtime de física a modo estático para escena de render:
  - `physics.enabled = true`
  - `physics.simulate = false`
  - `physics.runtimeMode = "static"`

## Cobertura de pruebas
- Nuevas pruebas unitarias:
  - `engineApi loadMannequin creates grouped mannequin nodes`
  - `engineApi generateArena creates arena scaffold and static runtime mode`
  - `engineApi applyTextureToSelection assigns uploaded texture map to selected node`
