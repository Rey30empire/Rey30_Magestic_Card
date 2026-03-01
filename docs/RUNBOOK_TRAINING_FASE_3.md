# Runbook Training - Fase 3

## Objetivo
Estandarizar operacion del pipeline de training en modo MVP robusto, con controles de cancelacion, timeout, requeue y recovery.

## Modos de operacion
- `TRAINING_RUNNER_MODE=inline`
  - La API ejecuta jobs en el mismo proceso.
  - Recomendado solo para desarrollo local rapido.
- `TRAINING_RUNNER_MODE=external`
  - La API encola jobs y `npm run worker` los procesa.
  - Recomendado para entorno productivo MVP.
- `TRAINING_RUNNER_MODE=disabled`
  - Crea/encola jobs, pero no los procesa.
  - Util para mantenimiento o pruebas de backpressure.

Backend de cola:
- `TRAINING_QUEUE_BACKEND=local`
  - Polling sobre SQLite.
  - Sin dependencia Redis.
- `TRAINING_QUEUE_BACKEND=redis`
  - BullMQ + Redis con DLQ admin y metricas de cola.
  - Recomendado para external worker.

## Variables criticas de entorno
- `TRAINING_WORKER_POLL_MS`: intervalo de polling en backend local.
- `TRAINING_JOB_MAX_RUNTIME_MS`: timeout maximo por job (ms). `0` deshabilita timeout.
- `TRAINING_QUEUE_ATTEMPTS`: reintentos de entrega en BullMQ.
- `TRAINING_QUEUE_BACKOFF_MS`: base de backoff exponencial en cola Redis.
- `TRAINING_WORKER_CONCURRENCY`: concurrencia del worker Redis.
- `TRAINING_DLQ_NAME`: nombre de cola DLQ.
- `TRAINING_DLQ_ALERT_THRESHOLD`: umbral de alerta para backlog DLQ.
- `TRAINING_MAX_ACTIVE_PER_USER`: limite de jobs `queued|running` por usuario.
- `TRAINING_MAX_ACTIVE_GLOBAL`: limite global de jobs `queued|running`.
- `REDIS_URL`: obligatorio cuando `TRAINING_QUEUE_BACKEND=redis`.

## Criterios de uso rapido
- Desarrollo simple:
  - `TRAINING_RUNNER_MODE=inline`
  - `TRAINING_QUEUE_BACKEND=local`
- Entorno con separacion API/worker:
  - `TRAINING_RUNNER_MODE=external`
  - `TRAINING_QUEUE_BACKEND=local` o `redis`
- Entorno recomendado (fase 3):
  - `TRAINING_RUNNER_MODE=external`
  - `TRAINING_QUEUE_BACKEND=redis`
  - `TRAINING_JOB_MAX_RUNTIME_MS > 0`

## Recovery operativo
1. Job en ejecucion colgado:
   - Configurar `TRAINING_JOB_MAX_RUNTIME_MS` para forzar fallo controlado.
   - Validar `error_message = "job timeout"` en `/api/training/jobs`.
2. Cancelacion de usuario:
   - `POST /api/training/jobs/:id/cancel`
   - El estado terminal esperado es `failed` con `errorMessage="cancelled by user"`.
3. Requeue DLQ individual (redis):
   - `POST /api/admin/training/dlq/:id/requeue`
   - Verificar respuesta:
     - `statusBefore` (ej. `failed`)
     - `statusAfter` (`queued`)
4. Requeue DLQ batch (redis):
   - `POST /api/admin/training/dlq/requeue-batch`
   - Revisar `requeued`, `failed` y `failures[]`.
5. Reinicio de worker:
   - Reiniciar proceso `npm run worker`.
   - Jobs `running/queued` deben recuperarse sin perdida.

## Verificacion minima post-cambio
- `npm run check`
- `npm run build`
- `npm run test:unit`
- `npm run test:integration`
- `npm run smoke:core-regression`

## Notas de seguridad operativa
- No requeue de jobs `succeeded`.
- Requeue prepara estado DB antes de reenviar a cola.
- En Redis/BullMQ, si `jobId` duplicado existe en estado terminal, se recicla y se reencola.
