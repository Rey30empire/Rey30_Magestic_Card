# Plan de Implementacion - Lowcoding Aprobado - Fase 2

## Estado
- Fecha de inicio: 2026-03-01
- Estado: cerrada
- Dependencia: Fase 1 cerrada
- Objetivo operativo: ejecutar el lowcoding aprobado con entregables incrementales, sin romper funcionalidades ya estables.

## Alcance de esta fase
Fase 2 se enfoca en:
- convertir el lowcoding aprobado en paquetes tecnicos implementables,
- priorizar por impacto/riesgo,
- ejecutar por bloques con validacion continua.

No incluye:
- mezclar multiples lowcodings en paralelo,
- cambios sin criterio de salida o sin pruebas.

## Paquetes de implementacion (orden de ejecucion)

### Paquete 2.1 - Baseline y control de regresion
Objetivo:
- congelar baseline funcional antes de cambios grandes.

Tareas:
- [x] Ejecutar check/build/smoke base y guardar resultado.
- [x] Registrar endpoints y paneles criticos que no pueden romperse.
- [x] Definir lista minima de pruebas por cada merge de paquete.

Salida:
- baseline verificable para comparar regresiones.

### Paquete 2.2 - Matriz avanzada de permisos AI
Objetivo:
- dejar permisos por herramienta totalmente gobernados y trazables.

Tareas:
- [x] Agregar presets de permisos (Safe, Builder, Full-Manual).
- [x] Agregar contador y auditoria de herramientas bloqueadas por policy.
- [x] Exponer en UI estado de sincronizacion local/backend.
- [x] Hardening de validacion server-side para herramientas nuevas.

Salida:
- permisos operativos, auditables y faciles de gestionar.

### Paquete 2.3 - Expansión de herramientas AI (ReyCAD + API)
Objetivo:
- ampliar capacidades de AI sin romper arquitectura command-based.

Tareas:
- [x] Cerrar tools de materiales avanzados (create/update/assign por lote).
- [x] Cerrar tools de agentes/skills con validaciones de payload.
- [x] Agregar tools de export controlado (GLB/STL) bajo permiso explicito.
- [x] Mejorar fallback local cuando proveedor remoto falle.

Salida:
- toolset mas completo con guardrails activos.

### Paquete 2.4 - UX de operación lowcoding
Objetivo:
- que el flujo de uso sea claro para usuario no tecnico.

Tareas:
- [x] Estado visual de policy (rojo/verde) consistente en `/app` y `ReyCAD`.
- [x] Mensajeria clara cuando una accion no corre por permisos.
- [x] Historial de acciones AI por bloque y resumen de errores.
- [x] Atajos de perfil (modo modelado, modo agentes, modo seguro).

Salida:
- experiencia usable y comprensible para operar permisos/herramientas.

### Paquete 2.5 - QA y hardening
Objetivo:
- blindar estabilidad antes de pasar a la siguiente macrofase.

Tareas:
- [x] Unit tests de filtrado de tools por policy.
- [x] Integracion de endpoints `/api/me/ai-config*`.
- [x] Smoke de flujo: configurar AI -> plan -> ejecutar -> bloquear tool no permitida.
- [x] Prueba de no-regresion en `/app`, `/reycad`, `/api/cards`, `/api/agents`.

Salida:
- evidencia de calidad para cierre de fase.

## Checklist de seguimiento rapido
- [x] Inicio de Fase 2 confirmado por usuario.
- [x] Paquete 2.1 completado.
- [x] Paquete 2.2 completado.
- [x] Paquete 2.3 completado.
- [x] Paquete 2.4 completado.
- [x] Paquete 2.5 completado.
- [x] Cierre formal de Fase 2.

## Riesgos activos
1. Scope creep por intentar mezclar otros lowcodings antes de cerrar este.
2. Permisos solo visuales sin enforcement real en backend.
3. Regresiones en flujos existentes al añadir tools nuevas.
4. Complejidad de UX si no se mantiene una politica clara por perfiles.

## Reglas de ejecucion
1. Un solo lowcoding activo hasta cierre al 100%.
2. Ningun cambio pasa si rompe check/build/smoke.
3. Cada paquete cierra con evidencia (tests + endpoints/paneles verificados).
4. Si aparece riesgo de regresion, se corrige antes de avanzar de paquete.

## Proximo paso inmediato (arrancado)
- Fase 2 cerrada. Listo para iniciar la siguiente macrofase de lowcoding aprobada.

## Evidencia ejecutada (Paquete 2.1)
- Fecha: 2026-03-01
- Resultado tecnico:
  - `npm run check` -> OK
  - `npm run build` -> OK
  - `npm run reycad:build` -> OK
  - Smoke rutas criticas -> OK (`/health`, `/app`, `/reycad`, `/api/cards`, `/api/marketplace/listings`)
- Endpoints/paneles criticos congelados:
  - Shell principal: `/app`
  - Editor ReyCAD: `/reycad`
  - Salud backend: `/health`
  - Flujo cartas: `/api/cards`
  - Flujo marketplace: `/api/marketplace/listings`
- Prueba minima por merge definida:
  1. `npm run check`
  2. `npm run build`
  3. `npm run reycad:build`
  4. Smoke de rutas criticas

## Evidencia ejecutada (Paquete 2.2)
- Fecha: 2026-03-01
- Resultado tecnico:
  - `npm run check` -> OK
  - `npm run build` -> OK
  - `npm run reycad:build` -> OK
  - `npm run smoke:policy-events` -> OK
- Implementado:
  - Presets `Safe`, `Builder`, `Full` en UI de permisos (`/app` y panel AI de ReyCAD).
  - Estado de sincronizacion local/backend visible (`synced`, `local-only`, `error`).
  - Contador local de bloqueos por policy + top de tools bloqueadas + reset de contador.
  - Auditoria backend de eventos policy (`POST /api/me/ai-config/policy-events`).
  - Hardening server-side de args para tools nuevas (`create_material`, `update_material`, `create_agent`, `assign_agent_tools`, `assign_agent_skills`).
- Evidencia smoke endpoint policy:
  - Payload valido -> `200`
  - Payload invalido -> `400` con error `Invalid payload`

## Evidencia ejecutada (Paquete 2.3)
- Fecha: 2026-03-01
- Resultado tecnico:
  - `npm run check` -> OK
  - `npm run build` -> OK
  - `npm run reycad:build` -> OK
  - `npm run smoke:policy-events` -> OK
- Implementado:
  - Nuevas tools AI de materiales por lote: `create_material_batch`, `update_material_batch`, `assign_material_batch`.
  - Nuevas tools AI de export: `export_stl`, `export_glb` (protegidas por permiso `export`).
  - Hardening server-side en `/api/me/ai-config/tool-plan` para validar args de tools nuevas.
  - Guardrails de cliente para limites de lote en materiales/agentes.
  - Fallback local mejorado con trazabilidad de origen del plan (`remote`, `local`, `local-fallback`) y razon.

## Evidencia ejecutada (Paquete 2.4)
- Fecha: 2026-03-01
- Resultado tecnico:
  - `npm run check` -> OK
  - `npm run build` -> OK
  - `npm run reycad:build` -> OK
- Implementado:
  - `/app`: estado visual de policy con indicador rojo/verde/custom y estado de sync (`synced`, `local-only`, `error`).
  - `/app`: perfiles rapidos agregados (`Modo Seguro`, `Modo Modelado`, `Modo Agentes`, `Full Manual`) con hint contextual.
  - ReyCAD AI Panel: mensajes explicitos cuando policy bloquea acciones, incluyendo permisos requeridos.
  - ReyCAD AI Panel: historial local de bloques AI con resumen `ok/failed/blocked` y primer error.
  - ReyCAD AI Panel: atajos de perfil alineados (`Seguro`, `Modelado`, `Agentes`, `Full`).

## Evidencia ejecutada (Paquete 2.5)
- Fecha: 2026-03-01
- Resultado tecnico:
  - `npm run check` -> OK
  - `npm run build` -> OK
  - `npm run test:unit` -> OK
  - `npx tsx --test tests/integration/me-ai-config.integration.test.ts` -> OK
  - `npm run smoke:policy-events` -> OK
  - `npm run smoke:ai-policy-flow` -> OK
  - `npm run smoke:core-regression` -> OK
  - `npm run reycad:build` -> OK
  - `npm run test:frontend` -> OK
- Implementado:
  - Unit test de policy filtering: `tests/unit/ai-policy-filtering.test.ts`.
  - Integration test endpoints `/api/me/ai-config*`: `tests/integration/me-ai-config.integration.test.ts`.
  - Smoke flujo AI policy (configurar -> plan local -> bloqueo -> auditoria): `scripts/smoke-ai-policy-flow.ps1`.
  - Smoke no-regresion core (`/app`, `/reycad`, `/api/cards`, `/api/agents`): `scripts/smoke-core-regression.ps1`.
  - Scripts npm actualizados para incluir nuevas pruebas/smokes.
