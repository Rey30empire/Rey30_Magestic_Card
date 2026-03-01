# Plan de Implementacion - Lowcoding Aprobado - Fase 7

## Estado
- Fecha de inicio: 2026-03-01
- Estado: en progreso
- Dependencia: Fase 6 cerrada
- Objetivo operativo: llevar ACS a UX integrada de cliente sin romper contratos backend existentes.

## Alcance de esta fase
Incluye:
- ACS Home funcional en cliente con resolución por rol/permiso/plataforma.
- manejo consistente de `x-client-platform` desde frontend.
- endurecimiento UX de errores de permisos/plataforma/validación.

No incluye:
- migración completa a Unity runtime final.
- migración de datos a infraestructura productiva (PostgreSQL/Redis) fuera de feature flags actuales.

## Paquetes de implementacion (orden)

### Paquete 7.1 - ACS Home backend + bridge frontend (completado)
Objetivo:
- exponer un snapshot ACS consumible por clientes web/desktop/mobile.

Tareas:
- [x] endpoint `GET /api/me/acs-home` con roles/permisos/plataforma.
- [x] módulos habilitados con razones (`available/reason`).
- [x] reglas de training por plataforma y counts operativos opcionales.
- [x] auditoría `me.acs-home.read`.

### Paquete 7.2 - Consola ACS Home + platform switch (completado)
Objetivo:
- habilitar validación funcional de UX ACS sin esperar Unity final.

Tareas:
- [x] panel `ACS Home` en `/console`.
- [x] selector de plataforma (`web/mobile/desktop`) persistente.
- [x] render de módulos, counts y modos de training.

### Paquete 7.3 - Robustez UX de errores y contratos (completado)
Objetivo:
- reducir ambiguedad en errores de permisos/plataforma/validación.

Tareas:
- [x] parseo enriquecido en frontend shared (`Missing permission`, `requiredPlatform`, detalles de validación).
- [x] envío dinámico consistente de `x-client-platform` en todas las requests `apiFetch` y `health`.

### Paquete 7.4 - Cobertura de integración + cierre de documentación (completado)
Objetivo:
- blindar contrato ACS Home y cerrar evidencia de inicio de fase.

Tareas:
- [x] test integración `GET /api/me/acs-home`.
- [x] actualización `docs/ENDPOINTS_ACS.md`.
- [x] actualización `docs/BACKLOG_FASES_COMPLETO.md` y `docs/ROADMAP_FASES.md`.
- [x] actualización `README.md`.

### Paquete 7.5 - ACS Workspace modular en consola (completado)
Objetivo:
- habilitar pantallas operativas por módulo ACS dentro de `/console` para validar flujo end-to-end mientras se avanza Unity UI final.

Tareas:
- [x] tabs y paneles `Agent Editor`, `Connection`, `Rules`, `Skills`, `Tools`, `Memory`, `Sandbox`, `Marketplace`.
- [x] carga real por API en cada módulo con manejo de error por rol/permiso/plataforma.
- [x] acciones mínimas funcionales: crear/agentes, connect/disconnect, reglas de proyecto, run skill tests, asignación de tools, create/delete memory, sandbox test, import template.
- [x] actualización de smoke de frontend (`frontend-shell.integration`) con markers de workspace.

### Paquete 7.6 - Hardening seguridad/estabilidad (completado)
Objetivo:
- reducir superficie de ataque en integración LLM y evitar bloqueos UI en rutas pesadas del editor.

Tareas:
- [x] validación de endpoint LLM con host allowlist y bloqueo de destinos locales/privados.
- [x] timeouts + retry controlado en llamadas a providers LLM.
- [x] limpieza de cache de transforms por evaluación en scenegraph.
- [x] fallback CSG no bloqueante (chunked/skip pesado con warning).
- [x] optimización de build ReyCAD con `manualChunks`.

## Criterios de salida de Fase 7
- `npm run check` y `npm run build` en verde.
- smoke/integration mínimos de ACS Home en verde.
- consola `/console` mostrando ACS Home + platform switch sin romper auth/projects/training.
