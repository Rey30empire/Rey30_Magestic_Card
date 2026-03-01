# ACS SPEC (Unity UI Flows)

## 1) Pantallas principales

### 1.1 ACS Home
Objetivo: entrada al sistema de agentes.

Widgets:
- Lista de agentes (`disconnected/connected/suspended`).
- Botón `Create Agent`.
- Filtros por proyecto/estado.
- CTA `Open Marketplace Templates`.

### 1.2 Agent Editor
Secciones:
- Identity: `name`, `role`, `detail`.
- Personality/Lore.
- Memory Scope selector (`private/project/public`).
- Estado de conexión.

Botones:
- `Save Profile` -> `PATCH /api/agents/:id`
- `Duplicate` -> `POST /api/agents/:id/duplicate`
- `Suspend` -> `POST /api/agents/:id/suspend`
- `Delete` -> `DELETE /api/agents/:id`

### 1.3 Agent Connection
Campos:
- Provider (`ollama|llama.cpp|api`)
- Model
- API key (opcional si ya hay keysRef)
- Params JSON

Botones:
- `Connect` -> `POST /api/agents/:id/connect`
- `Disconnect` -> `POST /api/agents/:id/disconnect`

### 1.4 Rules Console
Tabs:
- Global Rules (admin)
- Project Rules
- Agent Rules
- Session Rules

Botones:
- `Create Rule`
- `Refresh Effective Rules` -> `GET /api/agents/:id/rules`

### 1.5 Skills Catalog
Lista:
- name, version, status, tests summary

Botones:
- `Create Skill` -> `POST /api/skills`
- `Run Tests` -> `POST /api/skills/:id/tests/run`
- `View Tests` -> `GET /api/skills/:id/tests`
- `Assign to Agent` -> `POST /api/agents/:id/skills`

### 1.6 Tools & Dev Tools
Vista de tools soportadas:
- requiredPermission
- enabledForUser

Botones:
- `Assign Tool` -> `POST /api/agents/:id/tools`
- `Run Tool (Dev)` -> `POST /api/dev-tools/:toolKey/run`

Precondición:
- Si `Run Tool` usa `agentId`, exigir sandbox reciente `passed` para ese agente.

### 1.7 Memory / RAG
Componentes:
- formulario `scope + text + metadata`
- tabla de memorias por filtro

Botones:
- `Store` -> `POST /api/memory`
- `Search` -> `GET /api/memory`
- `Delete` -> `DELETE /api/memory/:id`

### 1.8 Training Jobs (Mode-Gated)
Regla por modo:
- `fine-tuning`, `lora`, `adapter`: visible/ejecutable solo en desktop.
- `profile-tuning`: permitido también en mobile y web.

Botones:
- `Create Job` -> `POST /api/training/jobs`
- `Refresh` -> `GET /api/training/jobs`
- `Cancel` -> `POST /api/training/jobs/:id/cancel`

Estados:
- queued/running/succeeded/failed con logs.

### 1.8.1 Projects
Pantalla para gestionar contexto de memoria/training/rules.

Botones:
- `Create Project` -> `POST /api/projects`
- `List Projects` -> `GET /api/projects`
- `Update Project` -> `PATCH /api/projects/:id`
- `Archive Project` -> `DELETE /api/projects/:id`

### 1.9 Sandbox Arena
Botón:
- `Run Sandbox Test` -> `POST /api/agents/:id/sandbox-test`

Resultado:
- checks (`hardRules`, `zodOutputs`, `memoryScope`)
- issues list.

### 1.10 Agent Marketplace Templates
Tabs:
- `Explore Templates`
- `Publish Template` (approvedCreator)

Botones:
- `Publish` -> `POST /api/agent-marketplace/templates`
- `Import` -> `POST /api/agent-marketplace/templates/:id/import`

Precondición:
- `Publish` requiere sandbox reciente `passed` del agente fuente.

## 2) Creator Program UI

### 2.1 Creator Application
- Form `message`
- `Apply` -> `POST /api/creators/apply`
- `My Status` -> `GET /api/creators/status`

### 2.2 Invite Redemption
- Input `inviteCode`
- `Redeem` -> `POST /api/creators/redeem-invite`

### 2.3 Admin Panel
Listas y acciones:
- aplicaciones pendientes
- approve/reject/suspend
- generar invite codes
- asignar permisos
- ver audit logs

## 3) UX Rules
- Siempre enviar `x-client-platform`.
- En mobile/web, ocultar training jobs o mostrar bloqueado.
- Mostrar errores de permiso/rol/plataforma sin retry automático.
- Nunca mostrar secrets ni `apiKey` persistida.
