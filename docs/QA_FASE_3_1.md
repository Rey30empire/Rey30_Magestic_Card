# QA Fase 3.1 - Frontend Shell + Console

## Objetivo
Validar que `/app` y `/console` mantengan funcionalidad operativa y estética premium sin romper endpoints backend.

## QA Automatizado
1. `npm run test:frontend`
2. `npm test`

Cobertura automática incluida:
- `GET /` redirige a `/app`.
- `GET /app` y `GET /console` devuelven HTML válido con secciones requeridas.
- `GET /favicon.ico` redirige a `/shared/favicon.svg`.
- Assets críticos responden `200`:
  - `/shared/tokens.css`
  - `/shared/ui.css`
  - `/shared/ui.js`
  - `/shared/favicon.svg`
  - `/app/app.css`
  - `/app/app.js`
  - `/console/console.css`
  - `/console/console.js`

## QA Manual Visual/Funcional
1. Ejecutar `npm run dev`.
2. Abrir `http://localhost:4000/app`.
3. Verificar:
   - Sidebar premium + navegación por secciones.
   - Topbar con estado backend + perfil mini + reloj.
   - Hero featured card con marco animado.
   - Quick actions operativas.
   - Activity feed con estados y timestamps.
4. En móvil (DevTools):
   - Toggle `Menu` abre/cierra sidebar.
   - Overlay y tecla `Esc` cierran sidebar.
   - Layout no se rompe en `<= 680px`.
5. Auth:
   - Login/Register desde modal de `/app`.
   - Logout mantiene UI consistente.
6. Funcionalidad principal `/app`:
   - Reystorage: crear/listar/eliminar memory.
   - Inventario: crear listing y comprar (si aplica).
   - Duelos: ejecutar vs AI con 1-10 cartas.
   - Editor: crear carta + actualizar stats.
   - Agents: crear y listar agentes.
   - Creators: aplicar y redeem invite.
7. Abrir `http://localhost:4000/console` y validar:
   - Login/Register.
   - Perfil.
   - Crear/archivar projects.
   - Crear/cancelar training jobs.

## Criterios de Aprobación
- No errores JS en consola al navegar secciones.
- No 404 de favicon.
- Endpoints existentes siguen respondiendo.
- `npm run check`, `npm run build`, `npm test` en verde.
