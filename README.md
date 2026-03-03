# Rey30 Mayestic Card - Backend MVP + ACS

Backend Node.js + TypeScript con JWT, Socket.IO y sistema ACS (AgentCreator System), con SQL Server como backend principal.

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
- DB backend:
  - `DB_ENGINE=sqlserver` (default, base principal)
  - `DB_ENGINE=sqlite` (fallback legado)

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

ReyMeshy sidecar (experimental):
- Core Rust aislado en `reymeshy/`.
- CLI command: `cleanup` (stdin JSON `MeshData`, stdout JSON `PipelineOutput`).
- Endpoints backend:
  - `GET /api/reymeshy/status`
  - `POST /api/reymeshy/cleanup`
  - `POST /api/reymeshy/jobs` (async)
  - `GET /api/reymeshy/jobs/:id` (poll status)
- Activación no-code para usuario final:
  - En `/app` -> `Settings (AI Config)` -> bloque `ReyMeshy Cleanup`.
  - Toggle `Activar ReyMeshy en esta app` + botón `Probar Cleanup`.
- Para validar local:
```bash
wsl bash -lc "source ~/.cargo/env && cd /mnt/c/Users/rey30/Rey30_Magestic_Card/reymeshy && cargo check && cargo test"
```
- Para habilitar invocación desde Node:
  - `REYMESHY_SIDECAR_ENABLED=true`
  - `REYMESHY_SIDECAR_EXECUTABLE` (opcional; default dev usa `cargo run`)
  - `REYMESHY_SIDECAR_ARGS` (csv; args base sin `cleanup`)
  - `REYMESHY_SIDECAR_CWD` (opcional)
  - `REYMESHY_SIDECAR_TIMEOUT_MS`
  - `REYMESHY_JOB_CONCURRENCY` (workers locales para cola async)
  - `REYMESHY_JOB_MAX_STORED` (retención en memoria de jobs)
  - `VRAM_SENTINEL_ENABLED` + `VRAM_SENTINEL_*` (guard real via `nvidia-smi`)
  - Si VRAM Sentinel detecta presión de memoria, `/api/reymeshy/cleanup` y `/api/reymeshy/jobs` responden `503`.

MCP Gateway (experimental):
- Endpoints backend:
  - `GET /api/mcp/status`
  - `GET /api/mcp/hybrid/status`
  - `PUT /api/mcp/hybrid/toggles`
  - `POST /api/mcp/hybrid/budget/reset` (admin; reset manual de budget diario)
  - `POST /api/mcp/execute`
- Tools actuales:
  - `reymeshy.cleanup` (sync o async via jobs)
  - `ollama.generate` (cuando está habilitado)
  - `instantmesh.generate` (cuando está habilitado y configurado)
  - `hybrid.dispatch` (router local/API por categoría + budget + VRAM)
- Flags de control:
  - `MCP_GATEWAY_ENABLED`
  - `MCP_TOOL_REYMESHY_ENABLED`
  - `MCP_TOOL_OLLAMA_ENABLED`
  - `MCP_TOOL_INSTANTMESH_ENABLED`
  - `MCP_OLLAMA_API_BASE_URL`, `MCP_OLLAMA_TIMEOUT_MS`
  - `MCP_INSTANTMESH_COMMAND`, `MCP_INSTANTMESH_ARGS`, `MCP_INSTANTMESH_TIMEOUT_MS`
  - `MCP_HYBRID_PROVIDERS_FILE` (default `config/InferenceProviders.json`)
  - `MCP_HYBRID_RESULTS_QUEUE` (cola Redis para resultados híbridos)
  - `MCP_HYBRID_PROCESS_CONTROL_ENABLED` (si `true`, apagar toggle local intenta detener runtimes locales)
  - `MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS`
  - `MCP_HYBRID_LOCAL_PROCESS_NAMES` (csv; default `ollama,python_worker,python,python3`)
  - `LOCAL_MLL_ENABLED`, `LOCAL_VRAM_LIMIT_MB`, `DAILY_BUDGET_USD`, `PREFER_LOCAL_OVER_API`
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `RUNWAY_GEN2_API_KEY`, `MESHY_AI_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_AI_API_KEY`
  - `REDIS_URL=redis://127.0.0.1:6379` para buzón `MCP_HYBRID_RESULTS_QUEUE`
- Redis local rápido (Docker):
```bash
docker run -d --name rey30-redis -p 6379:6379 redis:7-alpine
docker exec rey30-redis redis-cli ping
```
- UI no-code:
  - En `/app` -> `Settings (AI Config)` -> bloque `Hybrid Dispatch` para ejecutar `hybrid.dispatch` sin código.
  - Los toggles del broker se persisten por usuario en DB (`mcp_hybrid_toggles`) y sobreviven reinicios del backend.
  - El budget diario híbrido se persiste en DB (`mcp_hybrid_budget_daily`) y se recupera tras reinicios.
  - Botón `Reset Budget (Admin)` en `/app` para reset manual del gasto diario (requiere rol admin).

Asset Vault MVP (experimental):
- Endpoints backend:
  - `GET /api/vault/assets` (lista/search/filter)
  - `POST /api/vault/assets` (registro/import metadata + files index)
  - `POST /api/vault/upload?assetId=<uuid>&role=model` (upload binario real a disco)
  - `GET /api/vault/assets/:id` (detalle + files)
  - `GET /api/vault/assets/:id/files/:fileId/download` (descarga binaria)
  - `POST /api/vault/assets/:id/link` (link por referencia a proyecto)
  - `GET /api/vault/projects/:projectId/assets` (assets linkeados por proyecto)
- UI no-code:
  - En `/app` -> `Settings (AI Config)` existe panel de Asset Vault para crear asset record, subir archivo y linkear a proyecto.
- Reglas MVP:
  - Dedupe por `dedupeHash` por usuario (no duplica registros del vault).
  - Upload dedupe por `sha256` por asset (si ya existe mismo archivo, no reescribe).
  - Proyecto guarda referencias (`project_asset_links`) + `overrides`/`embedMode`.
  - Por defecto no copia archivos al proyecto (`reference`).
  - Configurable por env: `VAULT_STORAGE_DIR`, `VAULT_UPLOAD_MAX_BYTES`, `VAULT_ALLOWED_EXTENSIONS`.

## Testing y QA
Unit + integración:
```bash
npm test
```

Fallback SQLite explícito (legacy):
```bash
DB_ENGINE=sqlite npm test
```

`npm run test:integration` es automático según `DB_ENGINE`:
- `sqlserver` -> ejecuta `test:integration:sqlserver:full` (limpieza por archivo).
- `sqlite` -> ejecuta la suite legacy SQLite.

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
- Scan preventivo de leaks en archivos versionados:
```bash
npm run security:scan:secrets
```
- CI ejecuta ese scan al inicio (`job: security-secrets`) y bloquea el pipeline si detecta tokens reales.

Mirror incremental a Postgres (dual-write):
- `POSTGRES_DUAL_WRITE=true` activa espejo best-effort de `training_jobs` y `audit_logs` hacia Postgres.
- `POSTGRES_URL` define conexión PostgreSQL.
- `POSTGRES_POOL_MAX` define tamaño máximo del pool.

SQL Server (backend principal por defecto):
- Con `DB_ENGINE=sqlserver`, el backend exige `SQL_SERVER_*` completos y hace probe al iniciar.
- `SQL_SERVER_ENABLED=true` mantiene probe explícito aunque no sea modo principal.
- `SQL_SERVER_HOST`, `SQL_SERVER_PORT`, `SQL_SERVER_DATABASE`.
- `SQL_SERVER_USER`, `SQL_SERVER_PASSWORD` (compatibilidad legacy: `SQL_USER`, `SQL_PASSWORD`).
- `SQL_SERVER_INSTANCE` (opcional para instancias tipo `SQLEXPRESS`).
- `SQL_SERVER_ENCRYPT`, `SQL_SERVER_TRUST_SERVER_CERTIFICATE`.
- `SQL_SERVER_CONNECT_TIMEOUT_MS`, `SQL_SERVER_REQUEST_TIMEOUT_MS`, `SQL_SERVER_POOL_MAX`.
- `SQL_SERVER_DUAL_WRITE=true` habilita mirror best-effort de `training_jobs` y `audit_logs` en SQL Server.
- Para cutover total: `DB_ENGINE=sqlserver` + credenciales `SQL_SERVER_*` válidas.

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

Migración completa SQLite -> SQL Server (schema + data):
```bash
npm run db:migrate:sqlite-to-sqlserver
```
- Usa `DB_PATH` como origen SQLite.
- Usa `SQL_SERVER_*` (o compatibilidad `SQL_USER`/`SQL_PASSWORD`) como destino SQL Server.
- Recrea tablas destino y carga todos los registros del origen.

Validación rápida de cutover SQL Server (smoke de endpoints críticos):
```bash
npm run test:integration:sqlserver:cutover
```
- Incluye limpieza controlada del dominio `cards/*` entre pruebas para evitar colisiones de hash en una base SQL Server compartida.
- Para limpiar manualmente solo ese dominio:
```bash
npm run db:sqlserver:clean:cards
```

Suite completa de integración sobre SQL Server (secuencial con limpieza total entre archivos):
```bash
npm run test:integration:sqlserver:full
```
- Requiere `DB_ENGINE=sqlserver`.
- Limpieza total manual:
```bash
npm run db:sqlserver:clean:all
```

Para modo `external`:
1. Levantar API con `TRAINING_RUNNER_MODE=external`.
2. Levantar `npm run worker` con el mismo `DB_PATH`.

Healthcheck:
- `GET /health`
- Incluye `db.sqlite`, `db.postgresMirror` y `db.sqlServer` (estado de conexión y flag `dualWriteEnabledByEnv`, sin exponer secretos).

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
- [docs/REYCAD_LOWCODING_FASE_3_CIERRE.md](docs/REYCAD_LOWCODING_FASE_3_CIERRE.md)
- [docs/REYCAD_LOWCODING_FASE_4_5_AVANCE.md](docs/REYCAD_LOWCODING_FASE_4_5_AVANCE.md)
- [docs/REYCAD_LOWCODING_CIERRE_FINAL.md](docs/REYCAD_LOWCODING_CIERRE_FINAL.md)
- [docs/UI_STYLE_GUIDE.md](docs/UI_STYLE_GUIDE.md)
- [docs/QA_FASE_3_1.md](docs/QA_FASE_3_1.md)
- [docs/RUNBOOK_TRAINING_FASE_3.md](docs/RUNBOOK_TRAINING_FASE_3.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_4.md](docs/PLAN_LOWCODING_APROBADO_FASE_4.md)
- [docs/RUNBOOK_ALERTAS_OPS_FASE_4.md](docs/RUNBOOK_ALERTAS_OPS_FASE_4.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_5.md](docs/PLAN_LOWCODING_APROBADO_FASE_5.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_6.md](docs/PLAN_LOWCODING_APROBADO_FASE_6.md)
- [docs/PLAN_LOWCODING_APROBADO_FASE_7.md](docs/PLAN_LOWCODING_APROBADO_FASE_7.md)
- [docs/SECURITY_ROTATION_RUNBOOK_2026-03-03.md](docs/SECURITY_ROTATION_RUNBOOK_2026-03-03.md)
