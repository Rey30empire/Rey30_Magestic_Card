# ReyCAD Lowcoding Anterior - Cierre Fase 3/6 (PhysicsEngine)

## Fuente
- Documento base: `LOWCODING — REY SCENE ENGINE + ASSET SYSTEM + MANNEQUIN PAINT SYSTEM.txt`
- Alcance fase 3:
  - rigid body
  - static body
  - collision detection
  - gravity toggle
  - impulse force
  - trigger volumes
  - activar fisica solo en modo arena
  - desactivar fisica para render estatico

## Estado
- Fecha de cierre: 2026-03-02
- Resultado: cerrada

## Checklist de salida
- [x] `rigid body` y `static body` soportados (`dynamic|kinematic|fixed`).
- [x] deteccion de colision y eventos `enter/stay/exit`.
- [x] control de gravedad por mundo (`gravity`) y habilitacion (`enabled/simulate`).
- [x] `impulse force` implementado en runtime/API/UI/AI/Python.
- [x] `trigger volumes` soportados (`collider.isTrigger`).
- [x] fisica solo en modo arena (`physics.runtimeMode = "arena"`).
- [x] render estatico sin simulacion (`physics.runtimeMode = "static"`).
- [x] cobertura de tests y validacion local en verde.

## Cambios principales
- Nuevo modo de runtime fisico:
  - `physics.runtimeMode: "static" | "arena"` en proyecto.
  - migracion defensiva para proyectos previos (fallback a `static`).
- Gating de simulacion:
  - `physicsRuntime.step` solo corre si `enabled && simulate && runtimeMode === "arena"`.
  - `physicsRuntime.applyImpulse` bloqueado fuera de arena.
- Impulse force:
  - `PhysicsWorld.applyImpulse`.
  - `engineApi.applyPhysicsImpulse`.
  - controles en `Inspector` para aplicar impulso al nodo seleccionado.
- Integracion de herramientas:
  - AI tool `apply_impulse`.
  - Python `rc.physics.impulse(...)`.

## Evidencia de validacion
- `npm run check` -> OK
- `npm run test:unit` -> OK
- Test nuevo:
  - `physicsRuntime runs only in arena mode and blocks impulse in static mode`
