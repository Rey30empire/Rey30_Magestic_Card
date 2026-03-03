# Priorizacion Lowcoding AI-First V2 (2026-03-03)

## Objetivo

Analizar el nuevo lowcoding `AI-First Plus Core V2` junto con todo el set de lowcoding existente y elegir un unico frente para iniciar implementacion sin romper fases cerradas.

## Fuentes consolidadas

- `Plan de Lowcoding Sistema AI-First & ReyMeshy Core.txt`
- `PROYECTO ReyMeshy (Rust Core Geometry Engine) lowcoding.txt`
- `LOWCODING PARA CODEX - ASSET VAULT ...txt`
- `LOWCODING PARA CODEX - PLAY-IN-EDITOR + BUILD + EXPORT.txt`
- `STACK Y PRINCIPIOS LOWCODING.txt`
- `LOWCODING PARA CODEX.txt`
- Set historico de lowcoding TCG/Reyverse/Card Design.

## Sintesis por bloques

1. **Base ya implementada (repo actual)**:
   - ACS backend, seguridad, training ops, consola modular.
   - ReyCAD con material lab, physics runtime, arena/battle flow.

2. **Bloques nuevos de alto impacto**:
   - ReyMeshy (Rust core geometrico, aislado).
   - VRAM Sentinel + toggles runtime.
   - MCP Gateway Java.
   - Asset Vault inteligente global.
   - Play-In-Editor + Build/Export.

## Matriz de factibilidad en este repo

1. **ReyMeshy aislado**:
   - Ajuste al stack actual: medio.
   - Riesgo de regresion: bajo (si se mantiene aislado).
   - Time-to-first-value: alto (rapido para arrancar base).
   - Dependencias externas: Rust toolchain.

2. **MCP Gateway Java**:
   - Ajuste al stack actual: bajo (backend actual es Node/TS).
   - Riesgo de complejidad operativa: alto.
   - Time-to-first-value: bajo.
   - Dependencias externas: Java/Spring/Vert.x + puente con Node.

3. **VRAM Sentinel real multi-GPU**:
   - Ajuste al stack actual: medio-bajo.
   - Riesgo: medio-alto (observabilidad + procesos AI reales no estan cerrados).
   - Time-to-first-value: medio.
   - Dependencias externas: NVML/nvidia-smi + runtime inference activo.

4. **Asset Vault inteligente**:
   - Ajuste al stack actual: alto (TS + UI ReyCAD).
   - Riesgo de alcance: medio-alto.
   - Time-to-first-value: medio.
   - Dependencias: storage, workers, ingest, endpoints.

5. **Play-In-Editor + Build/Export**:
   - Ajuste al stack actual: medio.
   - Riesgo: alto por arquitectura runtime dual.
   - Time-to-first-value: medio-bajo.
   - Dependencias: ECS runtime, bundler/export, input system.

## Decision de inicio (elegido)

Se elige iniciar por **ReyMeshy Core Fase 1 Aislada**.

### Motivo

- Es el bloque fundacional comun para varios lowcoding posteriores.
- Tiene bajo riesgo de romper lo existente porque vive desacoplado.
- Respeta la regla del nuevo plan: "No mezclar aun con engine".
- Permite avanzar en paralelo sin bloquear ACS/ReyCAD estable.

## Implementacion iniciada en esta ejecucion

Se agrego bootstrap inicial en `reymeshy/`:

- `reymeshy/Cargo.toml`
- `reymeshy/src/lib.rs`
- `reymeshy/src/remesh.rs`
- `reymeshy/src/uv.rs`
- `reymeshy/src/lod.rs`
- `reymeshy/src/compression.rs`

API minima expuesta:

- `auto_remesh(mesh: MeshData) -> MeshData`
- `auto_uv(mesh: MeshData) -> MeshData`
- `optimize_lod(mesh: MeshData) -> MeshData`
- `run_cleanup_pipeline(mesh: MeshData) -> PipelineOutput`

Notas:

- `Cargo.toml` declara `crate-type = ["rlib", "cdylib"]`.
- Soporte WASM preparado por feature (`wasm` + `run_cleanup_pipeline_json`).
- LOD/remesh/UV son versiones bootstrap deterministas para no bloquear Fase 1.

## Bloqueador detectado

Entorno actual sin `cargo`/`rustup`:

- comando `cargo --version` no disponible.

Por eso, en esta iteracion no se pudo compilar ni correr tests de Rust.

## Siguiente paso recomendado inmediato

1. Instalar toolchain Rust (`rustup` + `cargo`) en el entorno.
2. Cerrar validacion local de `reymeshy` (build/test).
3. Luego abrir Fase 1.1: bridge host-side (Node worker o sidecar) sin tocar engine actual.
