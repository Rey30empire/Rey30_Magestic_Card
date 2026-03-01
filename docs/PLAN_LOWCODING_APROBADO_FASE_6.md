# Plan de Implementacion - Lowcoding Aprobado - Fase 6

## Estado
- Fecha de inicio: 2026-03-01
- Estado: completada
- Dependencia: Fase 5 cerrada
- Objetivo operativo: cerrar alcance ACS funcional avanzado sin romper contratos actuales.

## Alcance de esta fase
Incluye:
- versionado y rollback de configuración de agentes,
- historial y trazabilidad funcional por agente,
- bases para promoción y gobernanza ACS.

No incluye:
- UI Unity de Fase 7,
- migración de almacenamiento de datos a infraestructura externa.

## Paquetes de implementación (orden)

### Paquete 6.1 - Versionado/rollback de configuración de agentes (completado)
Objetivo:
- permitir revertir configuración completa de agentes de forma segura.

Tareas:
- [x] tabla `agent_config_versions` con snapshots versionados por agente.
- [x] snapshot automático al mutar configuración (`create`, `update`, `connect`, `disconnect`, `suspend`, `rules/tools/skills`, `duplicate`).
- [x] endpoint `GET /api/agents/:id/versions`.
- [x] endpoint `POST /api/agents/:id/rollback`.
- [x] cobertura integración de rollback end-to-end.

### Paquete 6.2 - Historial de ejecuciones de tools por agente (completado)
Objetivo:
- trazabilidad operativa de uso de dev-tools por agente.

Tareas:
- [x] persistir `tool_key`, input/output resumido, estado, latencia, actor.
- [x] endpoint de consulta paginada por agente.
- [x] filtros por rango temporal y estado.

### Paquete 6.3 - Promoción de skills draft/staging/prod (completado)
Objetivo:
- gobernanza de versiones de skills por ambiente.

Tareas:
- [x] ambientes y transiciones válidas.
- [x] endpoint de promoción con auditoría.
- [x] validaciones previas de compatibilidad.

### Paquete 6.4 - Gobernanza de templates y quality gates (completado)
Objetivo:
- control de publicación con deprecación/compatibilidad.

Tareas:
- [x] versionado de templates.
- [x] estado (`active/deprecated/incompatible`) y reglas de import.
- [x] quality gates de publicación.

## Evidencia ejecutada
- `npm run check` -> OK
- `npm run build` -> OK
- `npm run test:unit` -> OK
- `npm run test:integration` -> OK (`22 pass`, `0 fail`, `1 skip` redis opcional)
- `npm run smoke:core-regression` -> OK

## Archivos principales impactados
- `src/db/sqlite.ts`
- `src/services/agent-config-versions.ts`
- `src/services/agent-tool-runs.ts`
- `src/routes/agents.routes.ts`
- `src/routes/dev-tools.routes.ts`
- `src/routes/skills.routes.ts`
- `src/routes/agent-marketplace.routes.ts`
- `src/schemas/acs.schemas.ts`
- `src/config/env.ts`
- `.env.example`
- `tests/integration/agents-config-versioning.integration.test.ts`
- `tests/integration/agent-tool-runs-history.integration.test.ts`
- `tests/integration/skills-promotion-template-governance.integration.test.ts`
- `package.json`
- `docs/ENDPOINTS_ACS.md`
- `docs/BACKLOG_FASES_COMPLETO.md`
- `docs/ROADMAP_FASES.md`
- `README.md`

## Próximo paso inmediato
- Pasar a Fase 7 (ACS UI Unity) manteniendo cobertura de regresión actual.
