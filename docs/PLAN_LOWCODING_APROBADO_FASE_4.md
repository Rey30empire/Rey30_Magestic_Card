# Plan de Implementacion - Lowcoding Aprobado - Fase 4

## Estado
- Fecha de inicio: 2026-03-01
- Estado: cerrada
- Dependencia: Fase 3 cerrada
- Objetivo operativo: observabilidad y operación con métricas persistidas, alertas accionables y trazabilidad de requests.

## Alcance de esta fase
Incluye:
- persistencia de métricas operativas por minuto,
- endpoint histórico para auditoría/diagnóstico,
- snapshot de salud de training (queue depth, success/failure rate, duración),
- correlación por `x-request-id`,
- runbook de alertas.

No incluye (queda para siguientes paquetes):
- trazas distribuidas completas,
- export a Prometheus/OTel,
- dashboard visual dedicado.

## Paquetes de implementación (orden)

### Paquete 4.1 - Persistencia de métricas OPS (completado)
Objetivo:
- no perder señal operativa al reinicio del proceso.

Tareas:
- [x] agregar tabla SQLite para métricas por minuto.
- [x] persistencia periódica de métricas en background.
- [x] endpoint admin de historial (`/api/admin/ops/metrics/history`).
- [x] flush en apagado del proceso.

Salida:
- métricas HTTP persistidas en `ops_http_minute_metrics` y consultables por ventana temporal.

### Paquete 4.2 - Señales de training y alertas (completado)
Objetivo:
- elevar visibilidad de salud del pipeline de training.

Tareas:
- [x] snapshot training en `/api/admin/ops/metrics`.
- [x] alertas por `training queue depth`.
- [x] alertas por `training failure rate`.
- [x] umbrales configurables en env.

Salida:
- endpoint de ops integra HTTP + training en una sola respuesta de operación.

### Paquete 4.3 - Correlación y runbook (completado)
Objetivo:
- acelerar diagnóstico y respuesta operativa.

Tareas:
- [x] middleware `x-request-id` (entrada/salida).
- [x] logging de requests con `reqId`.
- [x] runbook de alertas y respuesta rápida.
- [x] cobertura de integración para historial y request-id.

Salida:
- trazabilidad básica por request y guía de operación documentada.

### Paquete 4.4 - Trazas y export estructurado (completado)
Objetivo:
- habilitar trazas operativas mínimas con correlación request->db/queue y export para dashboards externos.

Tareas:
- [x] trazas `request` + `db` + `queue` + `service` con contexto async.
- [x] endpoint admin de consulta de trazas.
- [x] endpoint admin de export (`json` y `ndjson`).
- [x] propagar `traceId` en cola Redis de training.
- [x] cobertura de integración para trazas y export.

Salida:
- observabilidad de spans operativos con contrato de export utilizable por sistemas externos.

## Evidencia ejecutada
- `npm run check` -> OK
- `npm run build` -> OK
- `npm run test:unit` -> OK
- `npx tsx --test tests/integration/admin-ops-metrics.integration.test.ts` -> OK
- `npx tsx --test tests/integration/admin-ops-traces.integration.test.ts` -> OK
- `npm run test:integration` -> OK
  - resultado: 16 pass, 0 fail, 1 skip (`training-worker-redis.integration.test.ts` sin `REDIS_URL`)
- `npm run smoke:core-regression` -> OK
- `npm run reycad:build` -> OK

## Archivos principales impactados
- `src/db/sqlite.ts`
- `src/services/ops-metrics.ts`
- `src/services/ops-tracing.ts`
- `src/services/training-jobs.ts`
- `src/services/training-queue.ts`
- `src/routes/admin.routes.ts`
- `src/middleware/request-context.ts`
- `src/middleware/ops-tracing.ts`
- `src/types/express.d.ts`
- `src/index.ts`
- `tests/integration/admin-ops-metrics.integration.test.ts`
- `tests/integration/admin-ops-traces.integration.test.ts`
- `.env.example`
- `README.md`
- `docs/RUNBOOK_ALERTAS_OPS_FASE_4.md`

## Próximo paso inmediato
- Iniciar Fase 5 (seguridad avanzada) con hardening de Vault/KMS, rotación de secretos y rate-limit por usuario/token.
