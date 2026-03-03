# Security Rotation Runbook (2026-03-03)

Fecha de apertura: 2026-03-03  
Estado: en curso

## Contexto
- Se compartieron credenciales sensibles fuera del gestor de secretos.
- Riesgo principal: uso no autorizado de APIs cloud, SQL y repositorio.

## Acciones cerradas en el repo
- [x] `secret scan` de alta confianza agregado: `scripts/security-scan-secrets.cjs`.
- [x] Comando npm agregado: `npm run security:scan:secrets`.
- [x] Pipeline CI bloquea leaks al inicio (`job: security-secrets`).
- [x] Hardening de `.gitignore` para evitar commit de `.env.*` y archivos de llaves/certificados.

## Rotación obligatoria pendiente (manual)
- [ ] SQL Server password (`SQL_SERVER_PASSWORD`).
- [ ] `OPENAI_API_KEY`.
- [ ] `ANTHROPIC_API_KEY`.
- [ ] `GEMINI_API_KEY`.
- [ ] `RUNWAY_GEN2_API_KEY`.
- [ ] `MESHY_AI_API_KEY`.
- [ ] `ELEVENLABS_API_KEY`.
- [ ] `FAL_AI_API_KEY`.
- [ ] `NGROK_API_KEY`.
- [ ] GitHub personal access token.
- [ ] Revocar y regenerar cualquier SSH key privada potencialmente expuesta.

## Procedimiento operativo
1. Generar nuevas credenciales en cada proveedor y revocar las anteriores.
2. Actualizar solo el `.env` local o secret manager (nunca en archivos versionados).
3. Reiniciar backend/workers para recargar variables.
4. Validar conectividad por proveedor desde `GET /api/mcp/hybrid/status`.
5. Ejecutar validación local:
   - `npm run security:scan:secrets`
   - `npm run check`
   - `npm run smoke:all`

## Criterio de cierre
- Todas las claves anteriores aparecen revocadas en sus paneles.
- El sistema opera con claves nuevas sin errores en `mcp`/`asset-vault`/`reymeshy`.
- CI pasa con `security-secrets` en verde.
