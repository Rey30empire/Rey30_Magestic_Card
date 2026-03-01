# Permissions Matrix

## 1) Roles
- `user`
- `creator`
- `approvedCreator`
- `moderator`
- `admin`

## 2) Permisos por rol (default)

| Permission | user | creator | approvedCreator | moderator | admin |
|---|---:|---:|---:|---:|---:|
| agents.manage | yes | yes | yes | yes | yes |
| agents.connect | yes | yes | yes | no | yes |
| agents.tools.assign | no | no | yes | no | yes |
| creator.apply | yes | yes | yes | no | yes |
| creator.redeem_invite | yes | yes | yes | no | yes |
| memory.manage | yes | yes | yes | yes | yes |
| rules.manage.agent | yes | yes | yes | yes | yes |
| rules.manage.global | no | no | no | no | yes |
| rules.manage.project | no | no | no | no | yes |
| skills.create | no | no | yes | no | yes |
| skills.tests.run | no | no | yes | no | yes |
| publish.agent_template | no | no | yes | no | yes |
| pro.import | no | no | yes | no | yes |
| pro.balance_tools | no | no | yes | no | yes |
| dev_tools.access | no | no | yes | no | yes |
| training.create | yes | yes | yes | no | yes |
| training.view | yes | yes | yes | yes | yes |
| training.cancel | yes | yes | yes | no | yes |
| admin.training.manage | no | no | no | no | yes |
| permissions.assign | no | no | no | no | yes |
| admin.creators.review | no | no | no | no | yes |
| admin.invites.manage | no | no | no | no | yes |
| admin.audit.read | no | no | no | no | yes |

## 3) Reglas adicionales
- `approvedCreator` se obtiene por invite code/redemption (flujo whitelist).
- `admin` bypass en chequeos de rol/permiso.
- `training/jobs` por modo:
  - `fine-tuning`, `lora`, `adapter` => solo `desktop`.
  - `profile-tuning` => `desktop | mobile | web`.
- `admin.training.manage` habilita operaciones DLQ de training:
  - `GET /api/admin/training/dlq`
  - `POST /api/admin/training/dlq/:id/requeue`
  - `POST /api/admin/training/dlq/requeue-batch`
  - `GET /api/admin/training/queue-metrics`
- `dev-tools/*` requiere rol `approvedCreator` + `dev_tools.access`.
- `publish/*` requiere rol `approvedCreator` + `publish.agent_template`.

## 4) Permisos granulares por usuario
Admin puede asignar overrides:
- endpoint: `POST /api/admin/creators/:creatorId/permissions`
- impacto: escribe en `user_permissions`, combinando con permisos heredados por rol.
