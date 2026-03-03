# Estado Motor vs Fases (hecho / documentado / no considerado)

Fecha de corte: 2026-03-03

## Fuentes usadas
- `reycad/src/engine-core/core/Engine.ts`
- `reycad/src/engine-core/core/System.ts`
- `reycad/src/engine-core/physics/PhysicsWorld.ts`
- `reycad/src/engine/runtime/physicsRuntime.ts`
- `reycad/src/engine/rendering/Canvas3D.tsx`
- `reycad/src/engine/rendering/materials.ts`
- `reycad/src/engine/rendering/lighting.tsx`
- `reycad/src/engine-core/performance/QualityManager.ts`
- `reycad/src/editor/persistence/storage.ts`
- `reycad/src/ui/panels/*.tsx`
- `src/socket.ts`
- `src/routes/asset-vault.routes.ts`
- `reymeshy/src/*.rs`
- `docs/ROADMAP_FASES.md`
- `docs/BACKLOG_FASES_COMPLETO.md`
- `docs/REYCAD_LOWCODING_CIERRE_FINAL.md`
- `docs/LOWCODING_PRIORIZACION_AI_FIRST_V2_2026-03-03.md`

## Resumen rapido
- Ya hecho: base de loop, render en Three.js, fisica lite con constraints/raycast/eventos + sub-stepping + broadphase espacial, ECS base con filtro por componentes y metricas por sistema, editor interno fuerte, materiales PBR, export STL/GLB, networking backend, y bridge AI/Python.
- Documentado para hacer: cierre de Fase 7 (paridad Unity), Fases 8-9 de producto, plataforma productiva (Postgres/Redis/ops), Asset Vault global, Play-In-Editor/Build, Mesh Edit avanzado, bridge ReyMeshy.
- No tomado en cuenta de forma explicita en docs actuales: culling avanzado, shader manager propio, audio 3D real, networking de prediccion/reconciliacion, memory manager custom, ray tracing/GI real.

## Fases 1 a 12 (tu arquitectura)

### Fase 1 - Game Loop (corazon)
- Hecho: `Engine.update(deltaTime)` + stages (`input/script/physics/animation/render`) y loop de frame via `useFrame` en `Canvas3D`.
- Documentado para hacer: no hay plan explicito de fixed timestep determinista o loop desacoplado update/render.
- No tomado en cuenta: loop de red/gamepad dedicado y scheduler global de frame budgeting.

### Fase 2 - Render system
- Hecho: render con Three.js (`Canvas3D`), materiales PBR (`MeshStandardMaterial`/`MeshPhysicalMaterial`), luces base, export GLB/STL.
- Documentado para hacer: motor visual premium Unity (URP/VFX/shaders) en backlog.
- No tomado en cuenta: gestion de shaders propia, frustum/occlusion/backface culling formal, render pipeline bajo nivel (DX/Vulkan/OpenGL directo).

### Fase 3 - Fisica
- Hecho: fisica lite con gravedad, rigid body (`dynamic/kinematic/fixed`), colliders, AABB contact events, constraints, impulse, raycast, sub-stepping estable y broadphase espacial por celdas.
- Documentado para hacer: seguir evolucionando runtime de juego y flujo arena/battle.
- No tomado en cuenta: colision por malla robusta + narrowphase avanzado + thread fisico separado real.

### Fase 4 - ECS
- Hecho: entidad ID + componentes + sistemas + stages, filtro por `requiredComponents` y metricas de ejecucion por sistema (ticks/duracion promedio).
- Documentado para hacer: no hay plan detallado de scheduler ECS multithread con job graph.
- No tomado en cuenta: paralelizacion ECS por archetypes/chunks y job graph ECS.

### Fase 5 - Asset Management
- Hecho: texturas/materiales/templates/versionado/autosave en editor + Asset Vault backend + `RuntimeAssetManager` (manifest id/hash/byteSize/version), cola async con prioridades, prefetch y cache LRU con budget/pins.
- Documentado para hacer: Asset Vault inteligente global y pipeline de ingest mas fuerte.
- No tomado en cuenta: streaming multi-nivel por chunks de mundo abierto y cache distribuido entre escenas.

### Fase 6 - Optimizacion GPU/CPU
- Hecho: `QualityManager` (auto/manual), CSG en worker, chunks de build ReyCAD, instancing dinamico, culling+LOD runtime, static batching para escenas densas (quality low/medium), metricas live en `PerformancePanel`, escena benchmark reproducible, presupuesto automatico draw-calls/triangles con alertas `ok|warn|critical`, y prefetch hibrido por camara/seleccion con prioridad dinamica.
- Documentado para hacer: mas hardening de rendimiento en fases de producto.
- No tomado en cuenta: job system de render multihilo y budget scheduler CPU/GPU por subsistema.

### Fase 7 - Iluminacion avanzada
- Hecho: iluminacion basica (ambient + directional) y material fisico PBR.
- Documentado para hacer: motor visual premium en Unity.
- No tomado en cuenta: GI dinamica, ray tracing, virtual shadow maps.

### Fase 8 - Particulas
- Hecho: solo tipo de componente `ParticleEmitter` en schema.
- Documentado para hacer: VFX aparece en backlog Unity, pero sin plan tecnico de runtime de particulas en ReyCAD.
- No tomado en cuenta: sistema de particulas GPU compute separado del render principal.

### Fase 9 - Audio engine
- Hecho: solo tipo de componente `AudioSource` en schema.
- Documentado para hacer: no hay fase dedicada de audio engine.
- No tomado en cuenta: spatial audio 3D, reverb dinamica, doppler, streaming de audio.

### Fase 10 - Networking
- Hecho: websocket backend (`chat`, `matchmaking`) y servicios de duelo/matchmaking.
- Documentado para hacer: multiplayer PvP robusto server-authoritative (backlog).
- No tomado en cuenta: prediccion cliente + reconciliacion servidor + compresion de paquetes para gameplay en tiempo real.

### Fase 11 - Editor interno
- Hecho: editor fuerte (scene panel, inspector, assets, material lab, performance, export, AI panel, python panel, undo/redo, versiones).
- Documentado para hacer: paridad completa en cliente Unity y flujos faltantes.
- No tomado en cuenta: editor de animaciones avanzado y pipeline tipo prefab profesional completo.

### Fase 12 - Integracion total
- Hecho: integracion funcional de varios subsistemas para caso editor/battle.
- Documentado para hacer: cierre global de fases de plataforma + Unity + experiencia.
- No tomado en cuenta: presupuesto unificado de frame/CPU/GPU/memoria con contratos de performance por escena.

## Nivel 2 (motor profesional real)

### 1) Animacion avanzada (blend tree/state machine/IK/root motion/retarget)
- Hecho: no (solo `AnimatorComponent` tipado).
- Documentado para hacer: solo menciones indirectas de animaciones en backlog.
- No tomado en cuenta: plan tecnico detallado de runtime de animacion avanzada.

### 2) Scripting layer
- Hecho: parcial fuerte (AI tools + Python bridge/worker + permisos).
- Documentado para hacer: continuar integracion en UX/cliente.
- No tomado en cuenta: capa de visual scripting tipo blueprint.

### 3) Material system avanzado
- Hecho: parcial alto (PBR + mapas + transmission/ior + MaterialLab).
- Documentado para hacer: seguir calidad visual Unity.
- No tomado en cuenta: subsurface scattering, reflection probes y pipeline de materiales por plataforma.

### 4) UI interno
- Hecho: si, editor y consola modular operativos.
- Documentado para hacer: paridad Unity.
- No tomado en cuenta: no aplica como brecha principal (ya existe base robusta).

### 5) Guardado/serializacion
- Hecho: si (autosave, versiones locales, export/import JSON).
- Documentado para hacer: robustecer data platform y backups del backend.
- No tomado en cuenta: no hay estrategia formal de savegame runtime para juego final.

### 6) Build/export multiplataforma
- Hecho: parcial (export GLB/STL + builds web existentes).
- Documentado para hacer: Play-In-Editor + Build/Export como frente nuevo.
- No tomado en cuenta: empaquetado multiplataforma completo (Windows/Linux/Android/consolas).

### 7) Debug/profiling
- Hecho: parcial (FPS/quality panel + ops metrics/tracing backend).
- Documentado para hacer: observabilidad productiva completa.
- No tomado en cuenta: profiler GPU de editor con draw calls y costo por sistema de juego.

## Nivel 3 (AAA industrial)

### Streaming mundo abierto
- Hecho: no.
- Documentado para hacer: no explicito.
- No tomado en cuenta: si.

### Terreno procedural masivo
- Hecho: parcial basico (primitive `terrain`).
- Documentado para hacer: no explicito para streaming masivo.
- No tomado en cuenta: pipeline procedural por sectores.

### Render hibrido (raster + ray tracing)
- Hecho: no.
- Documentado para hacer: no explicito.
- No tomado en cuenta: si.

### Job system avanzado
- Hecho: parcial (workers CSG/Python y colas backend), no job system de engine general.
- Documentado para hacer: fases de cola/training y operaciones backend.
- No tomado en cuenta: scheduler universal de jobs del engine.

### Memory manager custom
- Hecho: no.
- Documentado para hacer: no explicito.
- No tomado en cuenta: si.

## Gap principal hoy
- Tu repo ya cubre gran parte del "Nivel 1 indie funcional" y parte del "Nivel 2" (sobre todo tooling/editor/materiales/scripting parcial).
- Lo mas atrasado respecto a tu lista: culling/LOD integrado al runtime, audio real, particulas reales, networking de gameplay avanzado, animacion avanzada, y arquitectura AAA (job system/memory manager/render hibrido).
