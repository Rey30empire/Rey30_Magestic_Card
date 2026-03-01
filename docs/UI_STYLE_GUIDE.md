# UI Style Guide - Imperial Dark Gold

## Vision
Rey30 usa un lenguaje visual **Imperial Dark Gold**: oscuro premium, acentos metalicos y superficies glassmorphism con glow sutil.

## Palette
- `--color-bg-1`: `#07070B`
- `--color-bg-2`: `#0A0A12`
- `--color-bg-3`: `#11111C`
- `--color-surface`: `rgba(15, 16, 26, 0.72)`
- `--color-border`: `rgba(255, 220, 145, 0.18)`
- `--color-border-strong`: `rgba(255, 220, 145, 0.38)`
- `--color-text`: `#F5ECD8`
- `--color-text-soft`: `#C5B9A0`
- `--color-gold-1`: `#B9852F`
- `--color-gold-2`: `#F3CC79`
- `--color-gold-3`: `#FFDEA2`
- `--color-green`: `#45B887`
- `--color-red`: `#DF6D64`
- `--color-blue`: `#75A6FF`

Tokens centralizados en:
- [public/shared/tokens.css](C:/Users/rey30/Rey30_Magestic_Card/public/shared/tokens.css)

## Typography
- Display/titulos: `Cormorant Garamond`
- UI/general: `Manrope`
- Monospace/IDs y estados tecnicos: `IBM Plex Mono`

## Spacing System
Grid base de `8px`:
- `--space-2 = 8px`
- `--space-4 = 16px`
- `--space-6 = 24px`
- `--space-8 = 40px`

Regla operativa:
- entre bloques principales: `24px`
- dentro de cards: `16px-24px`
- micro espaciado en formularios/listas: `8px-12px`

## Radius + Shadows
- Radius: `12 / 16 / 20 / 24`
- Sombra principal: `--shadow-card`
- Glow de marca: `--shadow-glow`

## Background / Grain Overlay
- Fondo premium con gradientes radiales + linear.
- Overlay grain via SVG turbulence (`.app-bg::after`) para textura cinematica.

## Components (Reusable)
Componentes base definidos en:
- [public/shared/ui.css](C:/Users/rey30/Rey30_Magestic_Card/public/shared/ui.css)
- [public/shared/ui.js](C:/Users/rey30/Rey30_Magestic_Card/public/shared/ui.js)

Incluye:
- Button: `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-btn-ghost`, `.ui-btn-danger`
- Card glass: `.ui-glass`, `.ui-card`
- Badge status: `.ui-badge` + `success|warning|error|info`
- Inputs: `.ui-input`, `.ui-select`, `.ui-textarea`
- Tabs: `.ui-tabs`, `.ui-tab`
- Modal: `.ui-modal`, `.ui-modal-panel`
- Toast: `.ui-toast-root`, `.ui-toast`
- Skeleton: `.ui-skeleton`
- Tooltip para disabled states: `.ui-tooltip[data-tooltip]`

## Routes UI
- `/app`: App Shell premium (sidebar/topbar/home + modulos)
- `/console`: Dev Console operativo (auth/profile/projects/training)

## App Shell Structure (/app)
- Sidebar navegable con menu responsive (drawer en mobile).
- Topbar con estado backend online/offline, reloj y perfil mini.
- Home con:
  - Featured Card (marco de rareza animado).
  - Pulse metrics (cards, jobs, memories, agents).
  - Quick actions.
  - Activity feed + Training pulse list.
- Secciones funcionales: Reystorage, Inventario, Duelos, Editor, Agents, Creators.
- Settings con cards reales `Coming Soon` y botones deshabilitados con tooltip.

## Interaction Rules
- Hover con elevacion leve (`translateY`, borde y glow)
- Focus ring consistente (`--focus-ring`)
- Loading states con skeleton shimmer
- Disabled controls con tooltip obligatorio en features no implementadas
- Mobile nav: toggle + overlay para cerrar panel lateral

## Verification Checklist
1. Abrir `http://localhost:4000/app`.
2. Revisar sidebar + topbar + hero + featured card animada.
3. Verificar `Open Console` navega a `http://localhost:4000/console`.
4. En `/console`, probar login/register + crear proyecto + crear/cancelar training.
5. En `/app`, abrir modal de auth, iniciar sesion y validar metricas + training pulse.
6. Confirmar que no aparezca error de `favicon.ico` (usa `/shared/favicon.svg`).
