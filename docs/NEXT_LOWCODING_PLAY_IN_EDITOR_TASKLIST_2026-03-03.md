# Siguiente Lowcoding Recomendado: Play-In-Editor + Build + Export

Fecha: 2026-03-03

## Decision
- Lowcoding seleccionado: `LOWCODING PARA CODEX — “PLAY-IN-EDITOR + BUILD + EXPORT.txt`.
- Motivo: despues de cerrar `job system + frame budget + observabilidad runtime`, el siguiente mayor salto de valor es pasar de editor a flujo jugable reproducible (`Play/Stop`) sin salir de ReyCAD.

## Objetivo de fase
- Habilitar `Play-In-Editor` estable con rollback seguro al estado de edicion.
- Dejar pipeline minimo de build/export para pruebas internas.
- Mantener cobertura y gates de rendimiento ya cerrados.

## Lista de tareas (orden de implementacion)

### Bloque 1 - Core PIE (MVP)
- [x] Crear `PlaySessionManager` (start/stop, snapshot inicial, restore final).
- [x] Separar `EditorWorld` y `PlayWorld` en runtime (sin mutaciones directas al proyecto base durante play).
- [x] Congelar comandos de edicion destructivos mientras `play=true` (delete/boolean/group/ungroup).
- [x] Exponer estado PIE en store global (`isPlaying`, `sessionId`, `startedAt`, `lastStopReason`).

### Bloque 2 - Runtime Control + Seguridad
- [x] Integrar `play tick` con `FrameBudgetScheduler` y `RuntimeJobSystemLite`.
- [x] Agregar guardrails de seguridad (`max session time`, `panic stop`, `hard reset scene`).
- [x] Registro de eventos de sesion (`play_start`, `play_stop`, `play_panic`) en logs del editor.

### Bloque 3 - UI y DX
- [x] Toolbar PIE: botones `Play`, `Pause` (opcional), `Stop`, estado visual activo.
- [x] Panel de sesion con metricas basicas (`elapsed`, `fps`, `cpu pressure`, `gpu pressure`).
- [x] Mensajes de bloqueo de acciones no permitidas durante play (UX clara).

### Bloque 4 - Build/Export Minimo
- [x] Script `reycad:build:play` para empaquetar escena + runtime play.
- [x] Exportable de sesion (json manifest + metadata de preset/materiales/texturas).
- [x] Gate CI para validar que el paquete PIE se genera sin error.

### Bloque 5 - Calidad y cierre
- [x] Tests unitarios: `PlaySessionManager` (start/stop/restore/guardrails).
- [x] Tests integracion: flujo completo `edit -> play -> stop -> restore`.
- [x] Smoke script corto de regresion PIE.
- [x] Documento de cierre con evidencia (`check`, `test:unit`, `benchmark gate`, smoke PIE).

## Criterios de salida
- `Play` no altera permanentemente la escena de edicion al hacer `Stop`.
- El usuario puede iniciar/detener sesion sin romper seleccion, materiales ni fisica base.
- CI pasa con gates actuales + gate PIE.
- Queda documentado runbook corto de uso y fallback.
