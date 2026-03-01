# ENDPOINTS ACS

## Base
- Header recomendado en todas las requests: `x-client-platform: desktop|mobile|web`
- Si falta header: server asume `web`.
- Auth: `Authorization: Bearer <token>`

## 1) Me
- `GET /api/me` (auth)
- `GET /api/me/acs-home?includeCounts=true|false` (auth)
  - Resumen ACS para UI: roles/permisos/plataforma, módulos habilitados, reglas de training por plataforma y counts operativos opcionales.

## 2) Creators
- `POST /api/creators/apply` (auth, `creator.apply`)
- `GET /api/creators/status` (auth)
- `POST /api/creators/redeem-invite` (auth, `creator.redeem_invite`)

## 3) Admin Creators + Invites + Audit
- `GET /api/admin/creators/applications` (auth, `admin.creators.review`)
- `POST /api/admin/creators/:applicationId/approve` (auth, `admin.creators.review`)
- `POST /api/admin/creators/:applicationId/reject` (auth, `admin.creators.review`)
- `POST /api/admin/creators/:creatorId/suspend` (auth, `admin.creators.review`)
- `POST /api/admin/creators/:creatorId/permissions` (auth, `permissions.assign`)
- `POST /api/admin/invites` (auth, `admin.invites.manage`)
- `GET /api/admin/invites` (auth, `admin.invites.manage`)
- `GET /api/admin/audit-logs` (auth, `admin.audit.read`)
- `GET /api/admin/training/dlq` (auth, `admin.training.manage`, solo backend redis)
- `POST /api/admin/training/dlq/:id/requeue` (auth, `admin.training.manage`, solo backend redis)
- `POST /api/admin/training/dlq/requeue-batch` (auth, `admin.training.manage`, solo backend redis)
- `GET /api/admin/training/queue-metrics` (auth, `admin.training.manage`, solo backend redis)

## 4) Agents (ACS)
- `POST /api/agents` (auth, `agents.manage`)
- `GET /api/agents` (auth)
- `GET /api/agents/:id` (auth)
- `GET /api/agents/:id/versions` (auth)
- `GET /api/agents/:id/tool-runs` (auth)
- `PATCH /api/agents/:id` (auth, `agents.manage`)
- `POST /api/agents/:id/rollback` (auth, `agents.manage`)
- `POST /api/agents/:id/connect` (auth, `agents.connect`)
- `POST /api/agents/:id/disconnect` (auth, `agents.connect`)
- `POST /api/agents/:id/suspend` (auth, `agents.manage`)
- `POST /api/agents/:id/duplicate` (auth, `agents.manage`)
- `DELETE /api/agents/:id` (auth, `agents.manage`)

### Agent rules + tools + sandbox
- `GET /api/agents/:id/rules` (auth)
- `POST /api/agents/:id/rules` (auth, `rules.manage.agent`)
- `POST /api/agents/:id/tools` (auth, `agents.tools.assign`)
- `POST /api/agents/:id/skills` (auth, `agents.manage`) asignar/actualizar/quitar skills por agente
- `POST /api/agents/:id/sandbox-test` (auth, `agents.manage`)

## 4.1) Projects
- `POST /api/projects` (auth)
- `GET /api/projects` (auth)
- `GET /api/projects/:id` (auth)
- `PATCH /api/projects/:id` (auth)
- `DELETE /api/projects/:id` (auth, soft archive)

## 5) Rules
- `GET /api/rules/global` (auth, `rules.manage.global`)
- `POST /api/rules/global` (auth, `rules.manage.global`)
- `GET /api/rules/project?projectId=<uuid>` (auth)
- `POST /api/rules/project` (auth, `rules.manage.project`)

## 6) Skills Catalog
- `POST /api/skills` (auth, `skills.create`)
- `GET /api/skills` (auth)
- `GET /api/skills/:id` (auth)
- `GET /api/skills/:id/tests` (auth)
- `GET /api/skills/:id/promotions` (auth)
- `POST /api/skills/:id/promote` (auth, `skills.create`)
- `POST /api/skills/:id/tests/run` (auth, `skills.tests.run`)

## 7) Tools Registry + Dev Tools
- `GET /api/tools` (auth)
- `POST /api/dev-tools/:toolKey/run` (auth, role `approvedCreator`, `dev_tools.access`)
  - Si se envía `agentId`, el agente debe tener sandbox reciente `passed` (`POST /api/agents/:id/sandbox-test`).

## 8) Memory / RAG
- `POST /api/memory` (auth, `memory.manage`)
- `GET /api/memory` (auth)
- `DELETE /api/memory/:id` (auth, `memory.manage`)

## 9) Training Jobs
Regla de plataforma por modo:
- `fine-tuning`, `lora`, `adapter` => solo `desktop`
- `profile-tuning` => `desktop | mobile | web`

- `POST /api/training/jobs` (auth, `training.create`)
  - Header opcional: `x-idempotency-key` (8-120 chars) para deduplicar reintentos de cliente.
  - Reintento con misma key y mismo usuario devuelve el mismo `jobId` (respuesta `200` replay).
- `GET /api/training/jobs` (auth, `training.view`)
- `POST /api/training/jobs/:id/cancel` (auth, `training.cancel`)
  - Cancelación cooperativa: el job cancelado queda terminal (`failed`, `errorMessage=cancelled by user`) y no vuelve a `succeeded`.

Backpressure:
- `POST /api/training/jobs` puede responder `429` cuando se excede:
  - límite por usuario (`TRAINING_MAX_ACTIVE_PER_USER`)
  - límite global (`TRAINING_MAX_ACTIVE_GLOBAL`)

MVP note:
- pipeline simulado con cola interna/reintentos/reanudación (`queued/running/succeeded/failed`).
- runner distribuido real en fase posterior.
- operación:
  - modo `inline` (default): API ejecuta jobs.
  - modo `external`: API solo encola + proceso `worker` ejecuta jobs.
  - backend de cola:
    - `local`: polling SQLite.
    - `redis`: Redis/BullMQ (`REDIS_URL` obligatorio).
    - reintentos/backoff configurables (`TRAINING_QUEUE_ATTEMPTS`, `TRAINING_QUEUE_BACKOFF_MS`).
    - jobs agotados se envían a DLQ (`TRAINING_DLQ_NAME`).

## 10) Agent Marketplace Templates
- `POST /api/agent-marketplace/templates` (auth, role `approvedCreator`, `publish.agent_template`)
  - Requiere sandbox reciente `passed` del agente fuente antes de publicar.
  - Soporta `templateKey` para versionado (`v1`, `v2`, ...).
  - Aplica quality gate mínimo (`TEMPLATE_QUALITY_MIN_SCORE`).
- `GET /api/agent-marketplace/templates` (public)
- `GET /api/agent-marketplace/templates/manage` (auth, role `admin`)
- `POST /api/agent-marketplace/templates/:id/import` (auth)
- `POST /api/agent-marketplace/templates/:id/deprecate` (auth, role `approvedCreator`, `publish.agent_template`)
- `POST /api/agent-marketplace/templates/:id/moderate` (auth, role `admin`)

Alias protegido publish:
- `POST /api/publish/templates` (auth, role `approvedCreator`, `publish.agent_template`)

## 11) Smoke test sugerido
1. Register/login.
2. Crear agente desconectado.
3. Conectar agente con provider/model dummy.
4. Creator apply + admin invite + redeem invite.
5. Training en mobile (403) y desktop (201 queued).
6. Sandbox test en agente.
