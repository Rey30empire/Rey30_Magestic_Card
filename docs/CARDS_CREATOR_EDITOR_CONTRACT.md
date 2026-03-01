# Contrato API - Creador y Editor de Cartas

## Resumen
Este contrato define endpoints para flujo de cartas en modo studio:
- Drafts (crear, editar, validar, publicar).
- Versionado (historial, revert).
- Estado de carta (archive/unarchive).

## Drafts

### `POST /api/cards/drafts`
Crea un draft.

Body:
```json
{
  "name": "Atlas",
  "rarity": "epic",
  "cardClass": "guardian",
  "abilities": ["shield", "regen"],
  "summonCost": 6,
  "energy": 7,
  "baseStats": { "attack": 12, "defense": 14, "speed": 8 },
  "model3dUrl": "https://example.com/model.glb"
}
```

### `GET /api/cards/drafts?status=draft|validated|published`
Lista drafts del usuario autenticado.

### `GET /api/cards/drafts/:draftId`
Obtiene un draft por id (owner only).

### `PATCH /api/cards/drafts/:draftId`
Actualiza draft con control optimista.

Body:
```json
{
  "expectedVersion": 1,
  "changes": {
    "abilities": ["shield", "regen", "pierce"]
  }
}
```

### `POST /api/cards/drafts/:draftId/validate`
Ejecuta validación de balance y actualiza estado (`draft|validated`).

### `POST /api/cards/drafts/:draftId/publish`
Publica draft como carta.

Body opcional:
```json
{
  "consumeCreativePoints": true
}
```

## Editor de cartas publicadas

### `POST /api/cards/:id/clone-draft`
Clona una carta publicada a nuevo draft editable.

### `GET /api/cards/:id/versions`
Obtiene historial de versiones de una carta.

### `POST /api/cards/:id/revert`
Revierte carta a una versión anterior.

Body:
```json
{
  "version": 1,
  "note": "rollback por balance"
}
```

### `POST /api/cards/:id/archive`
Archiva carta, la saca de inventario activo y cancela listings activos.

### `POST /api/cards/:id/unarchive`
Restaura carta a estado publicado.

## Endpoints legacy compatibles
- `POST /api/cards` crea carta publicada directa.
- `PUT /api/cards/:id/stats` actualiza stats y crea nueva versión.

## Códigos de error relevantes
- `400`: payload inválido.
- `402`: puntos insuficientes.
- `403`: acceso/ownership inválido.
- `404`: recurso no encontrado.
- `409`: conflicto de versión/estado o duplicado de fingerprint.
- `422`: validación de balance fallida.
