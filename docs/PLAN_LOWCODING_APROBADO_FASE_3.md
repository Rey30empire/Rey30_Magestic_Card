# Plan de Implementacion - Lowcoding Aprobado - Fase 3

## Estado
- Fecha de inicio: 2026-03-01
- Estado: cerrada
- Dependencia: Fase 2 cerrada
- Objetivo operativo: iniciar escalado productivo del runner de training sin romper flujos existentes.

## Alcance de esta fase
Fase 3 se enfoca en robustez operativa del pipeline de training:
- cancelacion cooperativa real,
- control de runtime por job,
- pruebas de regresion especificas del runner.

No incluye:
- migracion completa a PostgreSQL,
- despliegue HA de Redis,
- observabilidad full (se cubrira en paquetes posteriores).

## Paquetes de implementacion (orden)

### Paquete 3.1 - Runner control de ejecucion (completado)
Objetivo:
- evitar jobs colgados y mejorar respuesta de cancelacion.

Tareas:
- [x] Agregar senal de cancelacion activa en runner de jobs.
- [x] Abortar ejecucion en vuelo cuando usuario cancela.
- [x] Agregar timeout de runtime por job (`maxRuntimeMs`).
- [x] Agregar test de integracion para timeout.
- [x] Mantener compatibilidad con reintentos/idempotencia.

Salida:
- runner con cancelacion en tiempo real + timeout controlado por config/env.

### Paquete 3.2 - Persistencia y operacion de colas
Objetivo:
- reforzar operacion de cola externa.

Tareas:
- [x] endurecer politicas de requeue/recovery.
- [x] ampliar smoke de escenarios redis (caidas y recuperacion).
- [x] completar evidencia de no perdida de jobs ante reinicio.

Salida:
- requeue DLQ seguro (no-ops eliminados por duplicado de `jobId` en BullMQ) y recuperacion real de jobs al reiniciar worker.

### Paquete 3.3 - Calidad y cierre de fase
Objetivo:
- cerrar fase con evidencia de estabilidad.

Tareas:
- [x] ejecutar check/build/unit/integration/smoke de fase.
- [x] actualizar docs de variables/env y criterios de uso.
- [x] cierre formal de Fase 3.

Salida:
- fase cerrada con validacion completa y runbook operativo de training.

## Evidencia ejecutada (Paquete 3.1)
- `npm run check` -> OK
- `npm run build` -> OK
- `npm run test:unit` -> OK
- `npx tsx --test tests/integration/training-timeout.integration.test.ts tests/integration/training-idempotency-cancel.integration.test.ts` -> OK
- `npm run smoke:core-regression` -> OK

Implementado:
- `src/services/training-jobs.ts`
  - cancelacion cooperativa con `AbortController` por job activo.
  - timeout de runtime por job (`maxRuntimeMs`) con fallo terminal controlado (`error_message = "job timeout"`).
  - interrupcion de espera por cancelacion sin esperar el fin del paso simulado.
- `src/config/env.ts` + `.env.example`
  - nueva variable `TRAINING_JOB_MAX_RUNTIME_MS` (default `0`, deshabilitado).
- `tests/integration/training-timeout.integration.test.ts`
  - cobertura de timeout real del runner.
- `package.json`
  - integration suite incluye `training-timeout.integration.test.ts`.

## Evidencia ejecutada (Paquete 3.2)
- `npm run check` -> OK
- `npm run build` -> OK
- `npx tsx --test tests/integration/training-idempotency-cancel.integration.test.ts tests/integration/training-timeout.integration.test.ts tests/integration/training-worker-redis.integration.test.ts` -> OK
  - entorno actual sin `REDIS_URL`: suite redis en estado `SKIP` (controlado por test)
- `npm run test:unit` -> OK
- `npm run smoke:core-regression` -> OK
- `npm run reycad:build` -> OK

Implementado:
- `src/services/training-jobs.ts`
  - nueva funcion `prepareTrainingJobForRequeue(...)`:
    - valida existencia de job,
    - bloquea requeue de jobs `succeeded`,
    - resetea `failed/running` a `queued` con limpieza de error/tiempos,
    - deja traza en logs y reencola localmente cuando aplica.
- `src/services/training-queue.ts`
  - `requeueTrainingDlqJob(...)` ahora prepara estado DB antes de reencolar.
  - `dispatchTrainingJobToQueue(...)` ahora recicla job BullMQ terminal (`completed/failed`) cuando existe conflicto por `jobId` duplicado, evitando requeue falso positivo.
- `src/routes/admin.routes.ts`
  - respuesta de `POST /api/admin/training/dlq/:id/requeue` incluye `statusBefore` y `statusAfter`.
- `tests/integration/training-worker-redis.integration.test.ts`
  - batch requeue ahora valida fallos controlados cuando el `jobId` no existe en DB.
  - nuevo escenario de requeue real de job `failed` (seed DLQ + recuperación a `succeeded`).
  - nuevo escenario de recuperación tras reinicio de worker (job en `running` termina `succeeded` después del restart).

## Evidencia ejecutada (Paquete 3.3)
- `npm run check` -> OK
- `npm run build` -> OK
- `npm run test:unit` -> OK
- `npm run test:integration` -> OK
  - resultado: 15 pass, 0 fail, 1 skip (`training-worker-redis.integration.test.ts` sin `REDIS_URL`)
- `npm run smoke:core-regression` -> OK

Documentacion actualizada:
- `README.md`
  - agregado `TRAINING_JOB_MAX_RUNTIME_MS`.
  - agregado contrato de respuesta para requeue individual (`statusBefore`, `statusAfter`).
- `docs/RUNBOOK_TRAINING_FASE_3.md`
  - modos de operacion, variables criticas, criterios de uso, recovery y verificacion minima.

## Cierre formal de fase
- Fase 3 cerrada.
- Objetivo cumplido: runner de training con cancelacion cooperativa, timeout por job, requeue DLQ robusto y recovery validado.
- Riesgo residual:
  - pruebas Redis con recovery profundo requieren `REDIS_URL` disponible en entorno de ejecucion.

## Proximo paso inmediato
- Preparar Fase 4 (observabilidad y operacion) con persistencia de metricas fuera de memoria y runbooks de alertas.
