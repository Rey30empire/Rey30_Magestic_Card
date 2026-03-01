# Reporte Fase 3 - Recuperacion y Cierre

## Objetivo de fase
Activar observabilidad operativa y dejar evidencia de cierre posterior a la remediacion tecnica.

## Implementado
- Endpoint de observabilidad para admin:
  - `GET /api/admin/ops/metrics?windowMinutes=15`
  - Archivo: `src/routes/admin.routes.ts`
- Recoleccion automatica de metricas HTTP en runtime:
  - `409` en `/api/cards`
  - `409` en `/api/marketplace`
  - `429` por rate-limit
  - `4xx` y `5xx` agregados
  - Archivos: `src/services/ops-metrics.ts`, `src/middleware/ops-metrics.ts`, `src/index.ts`
- Alertas por umbral parametrizable via `.env`:
  - `OPS_ALERT_CARDS_409_15M`
  - `OPS_ALERT_MARKETPLACE_409_15M`
  - `OPS_ALERT_RATE_LIMIT_429_15M`
  - `OPS_ALERT_HTTP_5XX_15M`
- Trazabilidad de fallos de bootstrap:
  - evento estructurado `[ops.bootstrap.failure]`

## Evidencia esperada
- Admin autenticado con permiso `admin.audit.read` consulta `/api/admin/ops/metrics`.
- Respuesta contiene:
  - `totals`
  - `window.counts`
  - `thresholds`
  - `alerts`
- Las alertas se activan al superar umbrales en la ventana solicitada.

## Riesgo residual
- Las metricas son in-memory (se reinician al reiniciar proceso).
- Para produccion se recomienda exportar a Prometheus/OTel y centralizar logs.
