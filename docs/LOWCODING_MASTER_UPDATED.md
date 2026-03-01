# LOWCODING MASTER UPDATED (ACS + Approved Creators + Desktop Gate)

## 1) Resumen
Se integra un módulo completo de `AgentCreator System (ACS)` sobre el MVP existente, sin romper rutas previas.

Nuevos bloques:
- ACS (agentes, reglas, skills, tools, sandbox).
- Approved Creators Program (whitelist con invitaciones + auditoría).
- Desktop Training Gate por modo (`fine-tuning/lora/adapter` solo desktop).
- Marketplace de plantillas de agentes (sin secretos).

## 2) ACS - AgentCreator System

### 2.1 Agent Profiles
Cada agente soporta:
- identidad: `name`, `role`, `detail`, `personality`, `lore`
- estado: `disconnected | connected | suspended`
- memoria: `memoryScope`
- conexión: `provider`, `model`, `keysRef`, params

### 2.2 Agente desconectado vs conectado
- `POST /api/agents` crea agente en estado `disconnected`.
- `POST /api/agents/:id/connect` conecta con provider/model y referencia de key.
- `POST /api/agents/:id/disconnect` vuelve a estado desconectado.

### 2.3 Vault
- Las keys no se exponen en responses.
- Se guardan cifradas/obfuscadas en SQLite (`vault_entries`).
- Nota obligatoria para producción: migrar a KMS/Secret Manager.

### 2.4 Rules Engine
Reglas por niveles con enforcement `soft|hard`:
- Global
- Project
- Agent
- Session

Se resuelven con prioridad y se devuelven como `effectiveRules`.

### 2.5 Skills
`skills_catalog` almacena paquete versionado:
- definición de skill
- input/output schema (Zod-compatible definition)
- required tools
- tests automáticos (`skill_tests`)

### 2.6 Tools
Tools reales con ejecución backend, no solo texto:
- `memory.storeSnippet`
- `agent.profileEcho`
- `cards.balanceCheck`

Asignación por agente via `agent_tools` y validación por permiso.

### 2.7 Agent Sandbox Arena
`POST /api/agents/:id/sandbox-test` valida:
- reglas hard (tools prohibidas)
- contrato Zod en tests de skills
- no romper memory scope

Guarda resultado en DB (`agent_sandbox_tests`).

Aplicación en runtime:
- `dev-tools` y `publish templates` exigen sandbox reciente en estado `passed` cuando operan sobre agente.

## 3) Approved Creators Program

Roles:
- `user`
- `creator`
- `approvedCreator`
- `moderator`
- `admin`

Flujo:
1. `creator` aplica (`pending`).
2. Admin revisa cola (approve/reject/suspend). En `approve` otorga rol `approvedCreator`.
3. También se puede otorgar `approvedCreator` por invite code/redemption.

Admin panel:
- cola de solicitudes
- aprobación/rechazo/suspensión
- generación/listado de invites
- asignación granular de permisos
- lectura de auditoría

## 4) Desktop Training Gate

Header de plataforma:
- `x-client-platform: desktop | mobile | web`
- fallback automático: `web`

Reglas:
- `training/jobs` por modo:
  - `fine-tuning`, `lora`, `adapter`: solo desktop.
  - `profile-tuning`: desktop/mobile/web.
- `dev-tools/*`: approvedCreator + `dev_tools.access`.
- `publish/*`: approvedCreator + `publish.agent_template`.

`training_jobs` implementa pipeline simulado con estados:
- `queued`
- `running`
- `succeeded`
- `failed`

Incluye cola interna, reintentos simulados y recuperación al reinicio.
También soporta modo API+worker separado (`TRAINING_RUNNER_MODE=external` + `npm run worker`).
Soporta backend de cola Redis/BullMQ en modo external.
Incluye retry/backoff configurable y DLQ para fallos agotados en Redis.
Nota: el runner distribuido real de entrenamiento queda para fase posterior.

## 5) Agent Marketplace Templates
- Publicación solo approvedCreator.
- Solo plantilla; no incluye keys ni secretos.
- Importación crea un nuevo agente `disconnected` para el usuario importador.

## 6) Seguridad y Anti-abuso
- JWT `requireAuth`.
- `requireRole` / `requirePermission`.
- gate por modo en training (`fine-tuning/lora/adapter` requieren desktop).
- Rate limit in-memory en `/api/*`.
- Auditoría en `audit_logs` para acciones admin, publish, training, dev-tools.

## 7) Smoke mínimo documentado
Casos cubiertos en docs:
- register/login
- crear agente desconectado
- conectar agente provider dummy
- creator application + invite + redeem + rol actualizado
- training bloqueado en mobile y permitido en desktop
- sandbox-test responde OK
