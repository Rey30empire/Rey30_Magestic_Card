# Rey30 Mayestic Card - Backend MVP + ACS

Backend Node.js + TypeScript + SQLite con JWT, Socket.IO y sistema ACS (AgentCreator System).

## Incluye
- Auth/JWT y RBAC con roles y permisos.
- Cartas con hash SHA256 + firma R33, inventario, puntos, duelos vs AI, marketplace base y chat realtime.
- ACS completo: agentes (desconectado/conectado/suspendido), reglas multinivel, skills catalog con tests, tools registry real, vault de keys cifradas.
- Versionado de configuración de agentes con rollback (`/api/agents/:id/versions`, `/api/agents/:id/rollback`).
- Historial de ejecuciones dev-tools por agente (`/api/agents/:id/tool-runs`).
- Promoción de skills por ambiente (`draft -> staging -> prod`) con gates de compatibilidad.
- Gobernanza de templates marketplace: versionado por `templateKey`, moderación y deprecación.
- Approved Creators Program: aplicaciones, aprobación/rechazo/suspensión, invite codes, auditoría.
- RAG memory por scope.
- Training jobs simulados con cola/reintentos/reanudación al reinicio, bloqueados por modo fuera de Desktop.
- Agent Sandbox Arena y marketplace de plantillas de agentes.
- ACS Home endpoint para cliente (`GET /api/me/acs-home`) con módulos por rol/permiso/plataforma.

## Requisitos
- Node.js 20+
- npm 10+

## Ejecutar
```bash
npm install
cp .env.example .env
npm run dev
```

Build y arranque:
```bash
npm run check
npm run build
npm start
```

Worker de training (opcional, proceso separado):
```bash
npm run worker
```

Frontend web (incluido en este repo):
- `http://localhost:4000/app` (App Shell premium)
- `http://localhost:4000/console` (Dev Console funcional + ACS Home + selector de plataforma)
- `http://localhost:4000/reycad` (ReyCAD Engine editor 3D)

ReyCAD (build y desarrollo):
```bash
npm run reycad:dev
npm run reycad:build
```

## Testing y QA
Unit + integración:
```bash
npm test
```

Solo unit:
```bash
npm run test:unit
```

Smoke frontend shell:
```bash
npm run test:frontend
```

Smokes backend:
```bash
npm run smoke:all
```

## Modos del runner de training
- `TRAINING_RUNNER_MODE=inline` (default): API procesa jobs en el mismo proceso.
- `TRAINING_RUNNER_MODE=external`: API solo encola jobs y un worker aparte los procesa.
- `TRAINING_RUNNER_MODE=disabled`: API encola jobs sin procesarlos.

Backend de cola:
- `TRAINING_QUEUE_BACKEND=local` (default): worker usa polling SQLite.
- `TRAINING_QUEUE_BACKEND=redis`: API/worker usan Redis/BullMQ.
- `TRAINING_QUEUE_NAME` define el nombre de cola en Redis.
- `TRAINING_WORKER_CONCURRENCY` define concurrencia del worker Redis.
- `TRAINING_QUEUE_ATTEMPTS` define reintentos de entrega en BullMQ.
- `TRAINING_QUEUE_BACKOFF_MS` define backoff base (exponencial) en BullMQ.
- `TRAINING_JOB_MAX_RUNTIME_MS` define timeout maximo por job en ms (`0` deshabilitado).
- `TRAINING_DLQ_NAME` define cola DLQ para jobs agotados.
- `TRAINING_MAX_ACTIVE_PER_USER` limita jobs activos (`queued|running`) por usuario.
- `TRAINING_MAX_ACTIVE_GLOBAL` limita jobs activos totales en sistema.
- `SENSITIVE_RATE_LIMIT_WINDOW_MS` ventana de rate-limit para endpoints sensibles.
- `SENSITIVE_RATE_LIMIT_MAX_PER_USER` límite por usuario para endpoints sensibles.
- `SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN` límite por token para endpoints sensibles.
- `SENSITIVE_RATE_LIMIT_MAX_BUCKETS` máximo de buckets en memoria para rate-limit sensible.
- `ABUSE_RISK_WINDOW_MS` ventana de scoring anti-abuso por usuario.
- `ABUSE_RISK_BLOCK_THRESHOLD` umbral de score para bloqueo temporal.
- `ABUSE_RISK_BLOCK_MS` duración del bloqueo temporal por riesgo.
- `ABUSE_RISK_INCIDENT_COOLDOWN_MS` ventana para reagrupar eventos en el mismo incidente.
- `TEMPLATE_QUALITY_MIN_SCORE` score mínimo para publicar templates de agentes.
- `MARKETPLACE_APP_VERSION` versión default de compatibilidad para imports de templates.
- `OPS_ALERT_TRAINING_QUEUE_DEPTH` umbral de alerta para profundidad de cola training.
- `OPS_ALERT_TRAINING_FAILURE_RATE_15M` umbral de alerta para tasa de fallo de training en ventana.
- `OPS_METRICS_FLUSH_MS` intervalo de persistencia de métricas operativas por minuto.
- `OPS_TRACE_MAX_SPANS` buffer máximo en memoria para spans de trazas operativas.
- `REDIS_URL` es obligatorio cuando `TRAINING_QUEUE_BACKEND=redis`.
- `CORS_ORIGINS` lista allowlist de orígenes HTTP (csv).
- `SOCKET_CORS_ORIGINS` lista allowlist de orígenes para Socket.IO (csv).
- `TRUST_PROXY=true` habilita `trust proxy` para IP real detrás de reverse proxy.

Vault y rotación de secretos:
- `VAULT_ACTIVE_KEY_ID` define el key id activo para cifrado nuevo.
- `VAULT_KEYRING` permite keyring de rotación: `keyId:secret,keyId2:secret2`.
- Payloads legacy `v1` se pueden rotar a `v2` vía endpoint admin.

Mirror incremental a Postgres (dual-write):
- `POSTGRES_DUAL_WRITE=true` activa espejo best-effort de `training_jobs` y `audit_logs` hacia Postgres.
- `POSTGRES_URL` define conexión PostgreSQL.
- `POSTGRES_POOL_MAX` define tamaño máximo del pool.

DLQ admin (solo redis):
- `GET /api/admin/training/dlq`
- `POST /api/admin/training/dlq/:id/requeue`
- `POST /api/admin/training/dlq/requeue-batch`
- `GET /api/admin/training/queue-metrics`

Respuesta de requeue individual:
- `POST /api/admin/training/dlq/:id/requeue` retorna `statusBefore` y `statusAfter` para trazabilidad del recovery.

Seguridad admin:
- `GET /api/admin/security/vault/status` (solo admin) muestra estado de versionado de secretos.
- `POST /api/admin/security/vault/rotate` (solo admin) rota entradas vault al key activo.
- `GET /api/admin/security/abuse/incidents` (solo admin) lista incidentes de abuso/fraude.
- `GET /api/admin/security/abuse/summary` (solo admin) resumen de riesgo, bloqueos e incidentes abiertos.
- `POST /api/admin/security/abuse/incidents/:incidentId/resolve` (solo admin) resuelve incidente y desbloquea usuario opcionalmente.
- `GET /api/agent-marketplace/templates/manage` (solo admin) consulta templates con todos los estados.
- `POST /api/agent-marketplace/templates/:id/moderate` (solo admin) aplica moderación (`approve/reject/deprecate/mark-incompatible`).
- `GET /api/admin/audit-logs/export?format=ndjson` exporta auditoría.
- `GET /api/admin/audit-logs/verify` verifica cadena hash (`prev_hash`, `entry_hash`).

Métricas operativas admin:
- `GET /api/admin/ops/metrics?windowMinutes=15` (permiso `admin.audit.read`)
- `GET /api/admin/ops/metrics/history?minutes=60&limit=120` (permiso `admin.audit.read`)
- `GET /api/admin/ops/traces?minutes=60&limit=300&kinds=request,db,queue` (permiso `admin.audit.read`)
- `GET /api/admin/ops/traces/export?minutes=60&limit=300&format=ndjson` (permiso `admin.audit.read`)
- Incluye contadores de `409` (`/api/cards`, `/api/marketplace`), `429` de rate-limit, `5xx` y snapshot de training (`queueDepth`, `success/failure rate`, `avgDurationMs`) con alertas por umbral.

Correlación de requests:
- El backend acepta `x-request-id` y lo devuelve en cada response.
- El backend acepta `x-trace-id` y lo devuelve en cada response.
- Si no se envía, genera un request id automáticamente.

Testing Redis:
```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:integration:redis
```

Testing Postgres mirror:
```bash
POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/rey30_test npm run test:integration:postgres
```

Para modo `external`:
1. Levantar API con `TRAINING_RUNNER_MODE=external`.
2. Levantar `npm run worker` con el mismo `DB_PATH`.

Healthcheck:
- `GET /health`

## Header de plataforma (obligatorio para cliente)
El backend detecta plataforma con `x-client-platform: desktop | mobile | web`.

Si no se envía, asume `web`.

Reglas:
- `training/jobs` por modo:
  - `fine-tuning`, `lora`, `adapter`: solo `desktop`.
  - `profile-tuning`: permitido en `desktop | mobile | web`.
  - `x-idempotency-key` (opcional, 8-120 chars) permite deduplicar creación de training jobs por usuario.
- `dev-tools/*` solo `approvedCreator` con permiso.
- `publish/*` solo `approvedCreator` con permiso.

## Ejemplos curl

1. Register
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -H "x-client-platform: web" \
  -d '{"username":"demo_user","password":"demoPass123"}'
```

2. Login
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -H "x-client-platform: web" \
  -d '{"username":"demo_user","password":"demoPass123"}'
```

3. Crear agente desconectado
```bash
curl -X POST http://localhost:4000/api/agents \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "x-client-platform: web" \
  -d '{"name":"Astra","role":"strategist","detail":"MVP agent","memoryScope":"private"}'
```

4. Conectar agente (provider dummy)
```bash
curl -X POST http://localhost:4000/api/agents/<AGENT_ID>/connect \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "x-client-platform: desktop" \
  -d '{"provider":"api","model":"dummy-local","apiKey":"dummy_secret_12345","params":{"temperature":0.2}}'
```

5. Training bloqueado en mobile
```bash
curl -X POST http://localhost:4000/api/training/jobs \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "x-client-platform: mobile" \
  -d '{"mode":"fine-tuning","config":{"epochs":1}}'
```

6. Training permitido en desktop
```bash
curl -X POST http://localhost:4000/api/training/jobs \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "x-client-platform: desktop" \
  -d '{"mode":"fine-tuning","config":{"epochs":1}}'
```

## Vault (MVP)
- Las keys de providers no se devuelven en responses.
- En MVP se almacenan cifradas/obfuscadas en SQLite (`vault_entries`).
- El cifrado usa `VAULT_SECRET` (secreto separado de `JWT_SECRET`).
- En producción debe migrarse a KMS/Secret Manager.

## Documentación adicional
- [docs/LOWCODING_MASTER_UPDATED.md](docs/LOWCODING_MASTER_UPDATED.md)
- [docs/ACS_SPEC.md](docs/ACS_SPEC.md)
- [docs/PERMISSIONS_MATRIX.md](docs/PERMISSIONS_MATRIX.md)
- [docs/ENDPOINTS_ACS.md](docs/ENDPOINTS_ACS.md)
- [docs/ROADMAP_FASES.md](docs/ROADMAP_FASES.md)
- [docs/BACKLOG_FASES_COMPLETO.md](docs/BACKLOG_FASES_COMPLETO.md)
- [docs/UI_STYLE_GUIDE.md](docs/UI_STYLE_GUIDE.md)
- [docs/QA_FASE_3_1.md](docs/QA_FASE_3_1.md)
- [docs/RUNBOOK_TRAINING_FASE_3.md](docs/RUNBOOK_TRAINING_FASE_3.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_4.md](docs/PLAN_LOWCODING_APROBADO_FASE_4.md)
- [docs/RUNBOOK_ALERTAS_OPS_FASE_4.md](docs/RUNBOOK_ALERTAS_OPS_FASE_4.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_5.md](docs/PLAN_LOWCODING_APROBADO_FASE_5.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_6.md](docs/PLAN_LOWCODING_APROBADO_FASE_6.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_7.md](docs/PLAN_LOWCODING_APROBADO_FASE_7.md)
