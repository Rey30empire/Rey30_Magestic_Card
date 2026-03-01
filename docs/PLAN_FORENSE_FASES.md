# Plan Forense por Fases - Rey30 Magestic Card

## Objetivo
Corregir vulnerabilidades y condiciones de carrera detectadas en el diagnostico tecnico, con evidencia verificable en pruebas automatizadas.

## Fase 0 - Contencion (Dia 0)
- Congelar despliegues y cambios funcionales hasta cerrar hallazgos criticos.
- Respaldar `data/*.db` y logs actuales.
- Forzar rotacion de `JWT_SECRET` en todos los entornos.
- Definir secreto dedicado para vault (`VAULT_SECRET`) y prohibir secreto por defecto en produccion.

## Fase 1 - Erradicacion Tecnica (Dia 0-1)
- Secretos:
  - Separar clave de cifrado de vault de la clave JWT.
  - Bloquear secreto JWT por defecto en produccion.
- Marketplace:
  - Garantizar una sola publicacion activa por carta (guardas en DB + logica de API).
  - Evitar doble venta con validaciones transaccionales.
- Cartas:
  - Evitar cartas duplicadas por fingerprint canonico.
  - Asegurar consumo de creative points con transacciones atomicas.
- API hardening:
  - Mejorar rate limit para evitar bypass por rutas dinamicas y crecimiento no acotado en memoria.

## Fase 2 - Validacion Forense (Dia 1)
- Agregar pruebas de integracion para:
  - Duplicado de cartas.
  - Doble publicacion/venta de carta.
- Agregar pruebas unitarias de normalizacion de rutas en rate limit.
- Ejecutar evidencia:
  - `npm run check`
  - `npm run test:unit`
  - `npm run test:integration`
  - `npm run smoke:all`

## Fase 3 - Recuperacion y Cierre (Dia 1-2)
- Publicar reporte tecnico de remediacion con:
  - Hallazgos corregidos.
  - Evidencia de pruebas.
  - Riesgo residual.
- Activar monitoreo de:
  - Tasa de errores 409 en marketplace/cartas.
  - 429 por rate limit.
  - Fallos de bootstrap por secretos invalidos.
- Definir backlog de mejoras no criticas (optimizar almacenamiento de tokens en frontend y mejorar revocacion de sesiones).

## Criterios de salida
- Sin hallazgos criticos abiertos.
- Pruebas y smokes en verde.
- Secretos de produccion validados sin fallback inseguro.
- Regla efectiva: una carta no puede venderse dos veces ni crearse duplicada.
