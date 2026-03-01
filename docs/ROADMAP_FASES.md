# Roadmap por Fases (estado actual)

## Fase 1 - ACS Core + RBAC (Completada)
Entregado:
- Modelo ACS, RBAC, roles/permisos, agentes/rules/skills/tools/memory/training.
- Endpoints base ACS y `/api/me`.
- Validación plataforma por `x-client-platform`.

## Fase 2 - Approved Creators Program (Completada)
Entregado:
- Flujo apply/status/redeem invite.
- Admin panel API: approve/reject/suspend/invites/permisos/auditoría.
- Roles `creator` y `approvedCreator` operativos.

## Fase 3 - Gates sensibles + seguridad funcional (Completada)
Entregado:
- Sandbox gate antes de `dev-tools` y `publish templates`.
- Training gate por modo (desktop-only para `fine-tuning/lora/adapter`).
- Auditoría de acciones críticas.
- Compras/redeem con consistencia transaccional.

## Fase 4 - Hardening operativo MVP (Completada)
Entregado:
- Ownership estricto por proyecto (rules/memory/agent-rules).
- Runner de training en proceso con:
  - cola interna,
  - reintentos simulados,
  - recuperación al reinicio,
  - cancelación robusta.
- Soporte operativo para worker separado:
  - `TRAINING_RUNNER_MODE=external` en API.
  - proceso `npm run worker` para polling/ejecución.
  - backend de cola `redis` opcional (BullMQ) para API/worker.
  - DLQ + retry/backoff en backend Redis de training.
  - endpoints admin para inspección/requeue de DLQ.
  - endpoint admin de métricas/alertas de cola (`/api/admin/training/queue-metrics`).
  - requeue batch para DLQ (`/api/admin/training/dlq/requeue-batch`).
  - límites de backpressure en creación de jobs (`429` per-user/global).
  - integración CI con Redis real para validar flujo queue + DLQ.
- Nuevas pruebas de integración para aislamiento de proyecto y lifecycle de training jobs.

## Fase 5 - Seguridad avanzada (Completada)
Entregado:
- Vault versionado con rotación (`v1 -> v2`) y endpoints admin.
- Rate-limit sensible por usuario/token.
- Auditoría verificable/exportable por cadena hash.
- Hardening websocket (auth + límites por evento).
- Detección de abuso/fraude con score, bloqueos temporales e incidentes admin.

## Fase 6 - ACS producto completo (Completada)
Entregado:
- Versionado y rollback de configuración de agentes.
- Historial de ejecuciones dev-tools por agente con filtros.
- Promoción de skills por ambientes (`draft/staging/prod`) con gates.
- Gobernanza de templates: versionado, deprecación, compatibilidad y moderación.

## Fase 7 - Escalado productivo + Unity ACS UI (En progreso)
Avance:
- Bridge inicial de UI con `GET /api/me/acs-home`.
- Consola `/console` con ACS Home y selección de plataforma cliente.
- Consola `/console` con `ACS Workspace` modular operativo (Agent Editor, Connection, Rules, Skills, Tools, Memory, Sandbox, Marketplace).
- Hardening inicial aplicado:
  - validación de endpoint LLM con allowlist/bloqueo local-privado.
  - timeouts y retry controlado en llamadas LLM.
  - mejoras de estabilidad ReyCAD en evaluator/CSG fallback.
  - chunking manual de build ReyCAD.

Pendiente:
- Worker/cola distribuida durable para training.
- Migración SQLite -> PostgreSQL + Redis.
- Observabilidad avanzada (métricas/trazas/alertas) operada en producción.
- Integración Unity completa de flujos ACS.

## Backlog exhaustivo
Detalle completo fase a fase en:
- `docs/BACKLOG_FASES_COMPLETO.md`
