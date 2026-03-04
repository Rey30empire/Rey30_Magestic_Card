# ReyCAD PIE - Cierre Bloques 4 y 5

Fecha: 2026-03-03

## Alcance cerrado
- Bloque 4: build/export minimo PIE + gate CI.
- Bloque 5: pruebas unitarias/integracion PIE + smoke de regresion + evidencia.

## Entregables implementados
- Script de empaquetado PIE:
  - `npm run reycad:build:play`
  - Genera:
    - `artifacts/reycad-play/play-session.manifest.json`
    - `artifacts/reycad-play/scene.project.json`
    - `artifacts/reycad-play/README.txt`
- Exportable de sesion PIE (manifest + metadata):
  - CLI: `scripts/build-reycad-play-package.ts`
  - UI: boton `Export Play Session` en `ExportPanel`.
  - Incluye metadata de `preset`, `materials`, `textures`, `physics`, conteos y bytes aproximados de texturas.
- Gate CI PIE:
  - `npm run reycad:ci:play-gate`
  - Ejecuta build PIE + integraciones PIE.
- Smoke PIE:
  - `npm run smoke:reycad:pie`
  - Ejecuta gate PIE y valida consistencia de manifest/proyecto.

## Pruebas agregadas
- Unitarias:
  - `tests/unit/reycad-play-session-export.test.ts`
  - `tests/unit/reycad-play-session-manager.test.ts`
  - `tests/unit/reycad-play-session-store.test.ts`
- Integracion PIE:
  - `tests/integration/reycad-play-package.integration.test.ts`
  - `tests/integration/reycad-play-session.integration.test.ts`

## Evidencia de ejecucion
- `npm run reycad:check` -> OK
- `npm run check` -> OK
- `npm run test:unit` -> OK (84/84)
- `npm run reycad:build:play` -> OK
  - salida: `preset=outdoor source=benchmark:outdoor nodes=147 materials=18 textures=0`
- `npm run reycad:ci:play-gate` -> OK
  - integraciones PIE: 3/3 pass
- `npm run smoke:reycad:pie` -> OK
  - checks:
    - `manifest_kind_ok=true`
    - `node_count_ok=true`
    - `material_count_ok=true`
    - `texture_count_ok=true`
- `npm run reycad:benchmark:ci` -> OK
  - benchmark gate `passed`

## Runbook corto de uso
1. Build + paquete PIE:
   - `npm run reycad:build:play`
2. Validar gate PIE:
   - `npm run reycad:ci:play-gate`
3. Smoke rapido PIE:
   - `npm run smoke:reycad:pie`
4. Export manual desde UI:
   - Abrir panel `Export` y usar `Export Play Session`.

## Fallback
- Si falla el gate PIE:
  1. Ejecutar `npm run reycad:build:play` y revisar que existan archivos en `artifacts/reycad-play`.
  2. Ejecutar `npm run test:integration:reycad:pie` para aislar si falla paquete o flujo edit/play/stop.
  3. Ejecutar `npm run smoke:reycad:pie` para validar consistencia final de manifest.
