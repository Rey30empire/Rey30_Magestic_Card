# Runbook Alertas OPS - Fase 4

## Objetivo
Operar el backend con señales accionables de API y training sin depender solo de memoria de proceso.

## Endpoints operativos
- `GET /api/admin/ops/metrics?windowMinutes=15`
  - snapshot actual de métricas HTTP + training.
- `GET /api/admin/ops/metrics/history?minutes=60&limit=120`
  - historial por minuto persistido en SQLite (`ops_http_minute_metrics`).
- `GET /api/admin/ops/traces?minutes=60&limit=300`
  - spans recientes (`request`, `db`, `queue`, `service`) para diagnóstico.
- `GET /api/admin/ops/traces/export?minutes=60&limit=300&format=ndjson`
  - export estructurado para dashboard externo o ingestión SIEM.
- `GET /api/admin/training/queue-metrics` (solo Redis)
  - profundidad y estado de cola principal + DLQ.

Todos requieren permiso `admin.audit.read` o `admin.training.manage` según endpoint.

## Señales y umbrales
Variables relevantes:
- `OPS_ALERT_CARDS_409_15M`
- `OPS_ALERT_MARKETPLACE_409_15M`
- `OPS_ALERT_RATE_LIMIT_429_15M`
- `OPS_ALERT_HTTP_5XX_15M`
- `OPS_ALERT_TRAINING_QUEUE_DEPTH`
- `OPS_ALERT_TRAINING_FAILURE_RATE_15M`
- `TRAINING_DLQ_ALERT_THRESHOLD`

## Respuesta rápida por alerta
1. `http 5xx above threshold`
   - Revisar últimos errores de proceso y `audit_logs`.
   - Validar conectividad DB/Redis.
2. `rate-limit 429 above threshold`
   - Confirmar posible abuso o burst legítimo.
   - Ajustar `API_RATE_LIMIT_MAX` solo con evidencia.
3. `training queue depth above threshold`
   - Verificar worker activo (`npm run worker`) y concurrencia.
   - Revisar `TRAINING_WORKER_CONCURRENCY` y backlog.
4. `training failure rate above threshold`
   - Muestrear `training_jobs` fallidos por `error_message`.
   - Revisar cambios recientes en pipeline/config.
5. DLQ backlog alto (Redis)
   - Listar `/api/admin/training/dlq`.
   - Requeue controlado (`/requeue` o `/requeue-batch`).
   - Confirmar que `statusBefore -> statusAfter` sea consistente.

## Persistencia de métricas
- La API consolida métricas por minuto en `ops_http_minute_metrics`.
- Frecuencia de flush: `OPS_METRICS_FLUSH_MS` (default 15000 ms).
- Al cierre de proceso (`SIGINT/SIGTERM`) se intenta flush final.

## Correlación
- El backend acepta `x-request-id` en requests y lo devuelve en response.
- El backend acepta `x-trace-id` y lo devuelve en response para correlación entre spans.
- Si no se envía, genera uno automáticamente.
- Usar este id al correlacionar reportes de error entre cliente y servidor.
