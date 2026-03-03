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

### Paquete 7.7 - MaterialLab Pro (completado)
Objetivo:
- cerrar la brecha de edición de materiales en ReyCAD con flujo completo de creación, edición avanzada y aplicación masiva sin romper undo/redo.

Tareas:
- [x] extensión de modelo `MaterialDef.pbr` con canales avanzados (emissive/transmission/ior y map ids).
- [x] soporte de render `MeshPhysicalMaterial` para nuevos parámetros PBR.
- [x] comando batch `setMaterialBatchCommand` + API canónica `setNodeMaterialBatch`.
- [x] panel dockable `MaterialLab` (crear, editar, aplicar a selección, import/export JSON, preview).
- [x] actualización `AssetsPanel` para suscribirse a `project.materials` y usar aplicación batch.
- [x] actualización de layout a `reycad.layout.v4` para exponer panel nuevo por defecto.
- [x] cobertura unitaria para batch command.

### Paquete 7.8 - Training Workspace Module (completado)
Objetivo:
- cerrar el faltante de pantalla `Training` dentro del `ACS Workspace` para alinear la consola web con el contrato de módulos de ACS Home.

Tareas:
- [x] tab `Training` en `ACS Workspace` enlazada al módulo `training`.
- [x] formulario de creación y lista de jobs movidos al panel de módulo (sin duplicar IDs ni lógica).
- [x] validación `requireTab(\"training\")` al crear jobs desde consola.
- [x] regresión frontend ajustada con marker del nuevo tab (`console-module-tab-training`).

### Paquete 7.9 - Training Ops Admin Workspace (completado)
Objetivo:
- exponer operación de cola de training (metrics + DLQ + requeue) dentro de `ACS Workspace` para rol admin sin salir de la consola.

Tareas:
- [x] nuevo módulo ACS `trainingOps` en `/api/me/acs-home` con gating por `admin.training.manage`.
- [x] tab `Training Ops` en workspace con panel de métricas y alertas de cola.
- [x] listado DLQ con acciones `requeue` individual y `requeue-batch`.
- [x] refresh de métricas/DLQ integrado y sincronización con lista de training jobs.
- [x] test frontend actualizado con markers del módulo.

## Criterios de salida de Fase 7
- `npm run check` y `npm run build` en verde.
- smoke/integration mínimos de ACS Home en verde.
- consola `/console` mostrando ACS Home + platform switch sin romper auth/projects/training.
