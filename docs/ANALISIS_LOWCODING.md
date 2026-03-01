# Analisis del nuevo lowcoding (Lowcoding_2)

## 1) Resumen ejecutivo
El lowcoding nuevo ya no pide solo un MVP de cartas; exige una capa de plataforma: ACS (agentes, reglas, skills, tools), programa de creadores aprobado, control estricto por plataforma y auditoría.

El repositorio actual ya cubre la mayor parte del alcance backend solicitado y compila correctamente.

## 2) Cobertura actual verificada en el repo
- ACS completo con agentes desconectados/conectados/suspendidos.
- Rules engine multinivel (`global > project > agent > session`) con `effectiveRules`.
- Skills versionadas con tests ejecutables.
- Tools registry real con permisos.
- Vault de claves cifradas/obfuscadas, sin exponer secretos.
- Approved Creators Program con aplicaciones, invites, whitelist y auditoría.
- Desktop training gate activo por modo (`fine-tuning/lora/adapter`).
- Marketplace de plantillas de agentes (sin keys/secrets).

## 3) Brecha detectada y aplicada
Brecha relevante encontrada:
- El endpoint de sandbox existía, pero no se exigía explícitamente antes de acciones sensibles.

Implementación aplicada:
- Se agregó un **sandbox gate** reutilizable (`src/services/sandbox-gate.ts`).
- Se bloquea `POST /api/dev-tools/:toolKey/run` cuando el agente no tiene sandbox reciente en estado `passed`.
- Se bloquea `POST /api/agent-marketplace/templates` cuando el agente fuente no tiene sandbox reciente en estado `passed`.

Resultado:
- Mayor alineación con la regla de “sandbox antes de acciones sensibles”.

## 4) Riesgos residuales
- `training_jobs` ya soporta modo API+worker separado y backend Redis/BullMQ opcional; falta operación HA de producción.
- Falta instrumentación operativa del DLQ (dashboards, alertas, replay administrativo).
- Falta infraestructura de escalado real (PostgreSQL/Redis/observabilidad).
- El cliente Unity aún debe integrar todos los flujos ACS en UI final.

## 5) Recomendación de ejecución
- Mantener el backend actual como base estable.
- Pasar a una Fase 5 enfocada en runner distribuido, escalado y operación.
- Evitar abrir editor 3D avanzado hasta cerrar hardening operativo del backend.
