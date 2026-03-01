# Plan de Trabajo por Fases - Creador, Editor y Motor de Cartas

## Objetivo
Terminar el flujo completo de cartas desde creacion/edicion hasta ejecucion del motor de juego, con calidad de produccion MVP.

## Estado de implementacion (2026-02-28)
- Fase 0: Completada.
- Fase 1: Completada (modelo/versionado/migraciones).
- Fase 2: Completada en backend (draft create/validate/publish + deduplicacion por fingerprint).
- Fase 3: Completada en backend (clone draft, versions, revert, archive/unarchive, concurrencia optimista).
- Fase 4: Pendiente (UI avanzada de creador/editor en shell).
- Fase 5: Completada v1 en backend (motor determinista + endpoint `/api/duels/engine/simulate`).
- Fase 6: Parcial (bloqueos para cartas archivadas/no publicadas en duelos y marketplace).
- Fase 7: Parcial (unit/integration/smoke cubren flujo nuevo; falta benchmark de latencia).
- Fase 8: Pendiente.

## Fase 0 - Alcance y contratos (1-2 dias)
- Cerrar alcance funcional de:
  - Creador de cartas.
  - Editor de cartas.
  - Motor de cartas (resolucion de efectos + combate).
- Definir contratos unicos (payloads, errores, estados) para frontend y backend.
- Entregables:
  - Documento de reglas funcionales.
  - Contratos API versionados.
- Criterio de salida:
  - No quedan reglas ambiguas ni endpoints sin contrato.

## Fase 1 - Modelo de dominio de cartas (2-3 dias)
- Normalizar entidad Card:
  - Identidad, fingerprint, version, estado (draft/published/archived).
  - Stats base, costos, rareza, clase, habilidades, tags.
- Agregar versionado de cambios para edicion segura.
- Endurecer restricciones de DB:
  - Unicidad de fingerprint.
  - Integridad owner/proyecto.
- Criterio de salida:
  - Migraciones aplicadas y sin inconsistencias legacy.

## Fase 2 - Backend del creador de cartas (3-4 dias)
- Endpoints para:
  - Crear borrador.
  - Validar carta (reglas y balance).
  - Publicar carta.
- Reglas de negocio:
  - Costos de creative points atomicos.
  - Prevencion de duplicados canonicos.
- Auditoria:
  - Eventos create/validate/publish.
- Criterio de salida:
  - Crear carta valida e invalida con respuestas consistentes y testeadas.

## Fase 3 - Backend del editor de cartas (3-4 dias)
- Endpoints para:
  - Editar borrador.
  - Clonar carta.
  - Revertir version.
  - Archivar/desarchivar.
- Controles:
  - Ownership estricto.
  - Concurrencia optimista (version/checksum).
  - Revalidacion automatica tras cada cambio.
- Criterio de salida:
  - Sin perdida de cambios ni ediciones concurrentes corruptas.

## Fase 4 - UI del creador y editor (4-6 dias)
- Creador:
  - Formulario guiado por pasos.
  - Preview en vivo de carta.
  - Mensajes claros de validacion.
- Editor:
  - Historial de versiones.
  - Diff de cambios.
  - Guardado seguro/autosave.
- UX minima:
  - Estados loading/error/empty.
  - Accesibilidad basica (teclado, labels, contrastes).
- Criterio de salida:
  - Flujo completo usable en desktop y mobile web.

## Fase 5 - Motor de cartas v1 (5-7 dias)
- Motor determinista:
  - Pipeline: pre-turno -> accion -> resolucion efectos -> post-turno.
  - Prioridades y stacking de efectos.
  - Cooldowns, buffs/debuffs, condiciones.
- RNG controlado por seed para reproducibilidad.
- API del motor:
  - Simular duelo.
  - Ejecutar turno.
  - Obtener log detallado.
- Criterio de salida:
  - Misma seed => mismo resultado siempre.

## Fase 6 - Integracion motor + cartas + marketplace (3-5 dias)
- Conectar cartas creadas/editadas al motor.
- Bloquear uso de cartas invalidadas/archivadas.
- Compatibilidad con inventario, duelos y marketplace.
- Criterio de salida:
  - Carta publicada se puede jugar; carta invalida no entra al motor.

## Fase 7 - Calidad, seguridad y performance (3-4 dias)
- Pruebas:
  - Unitarias del motor (reglas, efectos, edge cases).
  - Integracion de creador/editor.
  - E2E de flujo completo.
- Seguridad:
  - Hardening de permisos en endpoints de cartas.
  - Rate-limit por operaciones sensibles.
- Performance:
  - Benchmarks de simulacion por partida.
- Criterio de salida:
  - Suite verde + objetivos de latencia acordados.

## Fase 8 - Release y operacion (2 dias)
- Feature flags para rollout progresivo.
- Dashboard operativo:
  - 409 duplicados.
  - 422 validaciones.
  - errores de motor.
- Runbook de incidentes.
- Criterio de salida:
  - Produccion habilitada con monitoreo y rollback definido.

## Orden recomendado de ejecucion
1. Fase 0
2. Fase 1
3. Fase 2 y Fase 3 (parcialmente en paralelo)
4. Fase 4
5. Fase 5
6. Fase 6
7. Fase 7
8. Fase 8

## Riesgos principales a vigilar
- Ambiguedad de reglas de cartas (rompe motor).
- Efectos no deterministas (dificultan testing y anti-cheat).
- Edicion concurrente sin versionado (corrupcion de datos).
- Deuda de pruebas en logica de combate.
