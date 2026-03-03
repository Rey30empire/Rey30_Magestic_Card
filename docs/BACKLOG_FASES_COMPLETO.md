# Backlog Completo por Fases (sin omisiones)

## Estado de referencia
- Fecha de corte: 2026-02-27.
- Base actual: MVP backend + ACS + Approved Creators + sandbox gate + CI + smoke + tests unit/integration.
- Este backlog integra pendientes de:
  - `Rey30_Mayestic_card_Lowcoding_2.txt` (backend ACS).
  - `Rey30_Mayestic_Card_Lowcoding.txt` (producto completo Unity + backend + operación).

## Fase 1 - Cierre de hardening backend (Completada)
Objetivo: eliminar brechas de seguridad y robustecer ejecución MVP sin cambiar contratos públicos.

Entregables cerrados:
- Ownership estricto por proyecto:
  - `POST /api/memory` bloquea escritura sobre proyectos de otro usuario.
  - `GET /api/rules/project` bloquea lectura cruzada.
  - `POST /api/rules/project` evita mutación sobre proyectos ajenos.
  - `POST /api/agents/:id/rules` valida ownership de `projectId` explícito.
- Training runner en proceso:
  - Cola interna de jobs.
  - Reintentos simulados configurables (`maxRetries`, `simulateFailAttempts`).
  - Reanudación de jobs `queued/running` al reinicio del servidor.
  - Cancelación más robusta (retiro de cola + estado terminal).
- Cobertura de pruebas nuevas:
  - `tests/integration/memory-project-ownership.integration.test.ts`
  - `tests/integration/training-jobs-runner.integration.test.ts`

## Fase 2 - Runner distribuido real (Pendiente)
Objetivo: sacar training del proceso HTTP.

Base ya implementada:
- API con `TRAINING_RUNNER_MODE` (`inline|external|disabled`).
- Worker separado (`npm run worker`) que procesa jobs por polling.
- Backend `redis` opcional (BullMQ) para encolado/consumo de jobs.
- Retry/backoff configurable + DLQ en backend Redis.
- Endpoints admin para listar/requeue de DLQ.
- Endpoint admin para métricas/alertas de cola de training.
- Requeue batch para recuperación masiva de DLQ.
- Test de integración Redis real + job CI con servicio Redis.
- Backpressure por límites per-user/global para creación de training jobs.

Avance implementado (2026-02-28):
- Idempotencia de creación de jobs de training vía header `x-idempotency-key`.
  - deduplicación por usuario + key.
  - replay seguro devuelve el mismo `jobId`.
- Cancelación cooperativa reforzada:
  - evita carreras que reescriben logs terminales.
  - evita transición accidental a `succeeded` tras cancelación.
  - en backend Redis externo intenta remover job pendiente de la cola al cancelar.

Pendientes:
- Operación productiva de cola durable (HA Redis, monitoreo, DLQ y backpressure).
- Reintentos persistentes por política (no solo en memoria).
- Cancelación cooperativa real (señal al worker, no solo cambio de estado DB).
- Timeouts por etapa y dead-letter queue.
- Backoff exponencial y límites por usuario/proyecto.
- Idempotencia de re-ejecución y deduplicación por `jobId`.

## Fase 3 - Datos y escalado (Pendiente)
Objetivo: quitar cuellos de botella de SQLite.

Pendientes:
- Migración SQLite -> PostgreSQL con migraciones versionadas.
- Separación read/write y pooling de conexiones.
- Redis para:
  - matchmaking,
  - rate limit distribuido,
  - cache de lecturas frecuentes (skills/templates).
- Estrategia de backup/restore y pruebas de recuperación.

## Fase 4 - Observabilidad y operación (Pendiente)
Objetivo: operar en producción con señales y alertas.

Pendientes:
- Métricas (latencia, errores, throughput, depth de colas, success rate training).
- Trazas distribuidas en rutas críticas.
- Logs estructurados con correlación (requestId/jobId/userId).
- Alertas (SLO/SLA) y runbooks operativos.
- Dashboards de operación (API, workers, DB, colas).

## Fase 5 - Seguridad avanzada (Completada)
Objetivo: reducir riesgo operativo y abuso.

Entregado:
- Rotación de secretos + versionado (local keyring).
- Rate limit por usuario/token en endpoints sensibles.
- Detección de abuso/fraude en marketplace y dev-tools.
- Auditoría exportable y verificable por hash chain.
- Hardening de autenticación websocket y scopes de eventos.

Pendiente residual:
- Vault/KMS externo real (salir de cifrado local en SQLite).
- Auditoría inmutable externa (WORM/object-lock).

## Fase 6 - ACS producto completo (Completada)
Objetivo: cerrar todo el alcance funcional ACS.

Entregado:
- Versionado/rollback de configuración de agentes.
- Historial de ejecuciones de tools por agente.
- Promoción de skills entre ambientes (draft/staging/prod).
- Gobernanza de templates (versiones, deprecación, compatibilidad).
- Políticas de publicación avanzadas (moderación y quality gates).

## Fase 7 - Unity ACS UI (En progreso)
Objetivo: integrar frontend Unity con todos los flujos ACS.

Avance inicial:
- Endpoint base UI `GET /api/me/acs-home` para resolver módulos por rol/permiso/plataforma y counts operativos.
- Consola web `/console` con bloque ACS Home y envío dinámico de `x-client-platform`.
- Consola web `/console` con `ACS Workspace` modular (Agent Editor, Connection, Rules, Skills, Tools, Memory, Training, Sandbox, Marketplace) conectado a APIs reales.
- Hardening Fase 7 aplicado en backend/editor:
  - validación y bloqueo de endpoints LLM inseguros.
  - timeout/retry controlado para llamadas LLM.
  - mejoras de estabilidad en evaluación scenegraph y fallback CSG.

Pendientes:
- Integración de pantallas equivalentes en cliente Unity (`ACS Home`, `Agent Editor`, `Connection`, `Rules Console`, `Skills Catalog`, `Tools`, `Memory`, `Training`, `Sandbox`, `Marketplace`), ya operativas en la consola web.
- Manejo UX de errores de rol/permiso/plataforma.
- Envío consistente de `x-client-platform`.
- Flujos admin/creator completos dentro de cliente.

Avance adicional:
- Consola web agrega módulo admin `Training Ops` con lectura de `queue-metrics`, listado `DLQ` y acciones de `requeue` individual/batch (sin romper contratos backend existentes).

## Fase 8 - Alcance juego/experiencia (Pendiente)
Objetivo: cerrar visión completa del lowcoding original.

Pendientes:
- Multiplayer PvP robusto (casual/ranked/apuestas/2v2) con estado server-authoritative.
- Matchmaking productivo (ELO/latencia/región/crossplay real con Redis).
- Reystorage completo (licencias, historial, políticas premium/gratis).
- Economía y progresión (puntos creativos, eventos, desbloqueos).
- Importación externa avanzada (GLTF/animaciones/materiales).
- Editor modular avanzado 3D (beyond backend).
- Motor visual premium en Unity (URP, VFX, shaders, cinemática).

## Fase 9 - Comunidad y operación live (Pendiente)
Objetivo: escalar comunidad creadora y contenido vivo.

Pendientes:
- Eventos y torneos.
- Moderación comunitaria avanzada.
- Herramientas de liveops (campañas, recompensas, temporadas).
- Soporte de marketplace creator-first con métricas de conversión.

## Definition of Done global
Cada fase se cierra solo si cumple:
- `npm run check` y `npm run build` en verde.
- tests unit/integration/smoke verdes.
- docs actualizadas (endpoints, permisos, roadmap, criterios de salida).
- sin romper rutas existentes ni contratos ya publicados.
