# Cutover SQL Server Status (2026-03-03)

## Cierre
- Estado del bloque: **cerrado**.
- Fecha de cierre operativo: 2026-03-03.

## Estado
- `DB_ENGINE=sqlserver` activo como base principal.
- `DB_ENGINE` default cambiado a `sqlserver` en configuración.
- Migracion SQLite -> SQL Server ya aplicada (`npm run db:migrate:sqlite-to-sqlserver`).
- Backend operando en modo SQL Server con healthcheck correcto.
- Suite completa SQL Server (`npm run test:integration:sqlserver:full`) en verde.
- CI reforzado con job dedicado `backend-sqlserver` (SQL Server + Redis) para ejecutar `test:integration:sqlserver:full` y `smoke:all` en cada push/PR.

## Ajustes cerrados en este bloque
- Normalizacion de tipos de salida SQL Server:
  - `BIGINT` convertido a numero seguro cuando aplica.
  - `BIT` convertido a `0/1` para compatibilidad con comportamiento SQLite.
- Transacciones SQL Server corregidas por request/trace:
  - `BEGIN/COMMIT/ROLLBACK` ahora se mantienen en el mismo contexto de ejecucion.
  - Resuelto timeout en `POST /api/cards/:id/revert`.
- Traduccion SQL SQLite -> SQL Server mejorada:
  - Fix en `LIMIT ? OFFSET ?` para evitar inversion de parametros.
- Compatibilidad funcional en dominio cards:
  - Deteccion explicita de duplicados por `card_hash`.
  - Deteccion explicita de drafts equivalentes por `fingerprint`.
- Estabilidad de training queue + DLQ en Redis:
  - Corregido push a DLQ (BullMQ no acepta `jobId` con `:`).
  - Requeue endurecido en `dispatchTrainingJobToQueue` para reciclar jobs terminales antes de re-encolar.
- Guardrails de arranque en modo SQL Server:
  - Si `DB_ENGINE=sqlserver` y faltan credenciales `SQL_SERVER_*`, el backend falla temprano con error explícito.
  - `refreshSqlServerHealthSnapshot` trata SQL Server como activo cuando es motor primario, aunque `SQL_SERVER_ENABLED` no esté forzado.
- Smoke scripts compatibles con ambos motores:
  - nuevo helper `scripts/promote-admin.cjs` para elevar admin en `sqlite` o `sqlserver`.
  - migrados `smoke-test`, `smoke-gates`, `smoke-agent-skills` y `smoke-transactions` para usar helper común.
- Runner de integración unificado:
  - `npm run test:integration` ahora enruta por `DB_ENGINE`.
  - en `sqlserver` usa suite full con limpieza secuencial.
  - en `sqlite` mantiene suite legacy, ahora en ejecución secuencial por archivo para evitar flakes intermitentes de puertos/procesos en tests E2E.

## Scripts nuevos
- Limpieza controlada de dominio cards en SQL Server:
  - `npm run db:sqlserver:clean:cards`
  - Archivo: `scripts/sqlserver-clean-card-domain.cjs`
- Limpieza total de tablas SQL Server entre pruebas:
  - `npm run db:sqlserver:clean:all`
  - Archivo: `scripts/sqlserver-clean-all.cjs`
- Suite de validacion cutover SQL Server:
  - `npm run test:integration:sqlserver:cutover`
- Suite completa SQL Server (secuencial + limpieza por archivo):
  - `npm run test:integration:sqlserver:full`
  - Archivo: `scripts/test-integration-sqlserver-full.cjs`

## Validacion ejecutada
- `npm run check` -> OK
- `npm run build` -> OK
- `npm run test:integration:sqlserver:cutover` -> OK
- `npm run test:integration:sqlserver:full` -> OK
- `DB_ENGINE=sqlserver npm run smoke:all` -> OK
  - auth/me
  - me ai-config
  - asset-vault
  - mcp gateway/hybrid
  - reymeshy jobs
  - cards creator/editor
  - cards marketplace guards

## Nota operativa
- `npm run test:integration` ahora enruta automáticamente por `DB_ENGINE`.
  - `DB_ENGINE=sqlserver` -> usa suite full SQL Server (`test:integration:sqlserver:full`).
  - `DB_ENGINE=sqlite` -> mantiene suite legacy SQLite.
- Para validación rápida de cutover seguir usando:
  - `npm run test:integration:sqlserver:cutover`

## Seguridad posterior al cutover
- Se agregó gate preventivo de secretos versionados:
  - `npm run security:scan:secrets`
  - job CI `security-secrets` como prerequisito de los jobs backend.
- Runbook operativo de rotación:
  - `docs/SECURITY_ROTATION_RUNBOOK_2026-03-03.md`

## Hybrid Broker runtime-control
- `PUT /api/mcp/hybrid/toggles` ahora ejecuta `runtimeControl` al apagar `localEngineEnabled`.
- Control real de procesos locales (best-effort) configurable por env:
  - `MCP_HYBRID_PROCESS_CONTROL_ENABLED`
  - `MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS`
  - `MCP_HYBRID_LOCAL_PROCESS_NAMES`
- En UI `/app` se refleja estado `runtimeCtl=on/off` y feedback del guardado de toggles.
- Los toggles híbridos ahora se persisten por usuario en DB (`mcp_hybrid_toggles`) para mantener estado tras reinicios.
- El budget diario híbrido ahora se persiste en DB (`mcp_hybrid_budget_daily`) para mantener consumo acumulado tras reinicios.
- Endpoint admin no-code para reset manual del budget diario:
  - `POST /api/mcp/hybrid/budget/reset` (role: `admin`)
  - UI: botón `Reset Budget (Admin)` en panel Hybrid Broker de `/app`.
