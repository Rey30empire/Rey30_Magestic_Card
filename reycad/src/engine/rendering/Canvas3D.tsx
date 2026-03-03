import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { BufferGeometry, Frustum, InstancedMesh, Matrix4, Mesh, Object3D, PerspectiveCamera, Sphere, Vector3 } from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { useEditorStore } from "../../editor/state/editorStore";
import { useQualityStore } from "../runtime/qualityStore";
import { physicsRuntime } from "../runtime/physicsRuntime";
import { evaluateProject, type RenderPrimitive } from "../scenegraph/evaluator";
import { buildGeometryFromPrimitive, type GeometryLodLevel } from "./geometry";
import { clamp, computeSceneRuntimeProfile, primitiveScaleRadius, resolveLodLevel } from "./renderTuning";
import { buildThreeMaterial } from "./materials";
import { SceneLighting } from "./lighting";
import { SceneGrid } from "./grid";
import { applySelectionRules } from "../interaction/selection";
import { modeFromKeyboardKey } from "../interaction/gizmo";
import { frameBounds } from "../interaction/camera";
import { computeSelectionBounds } from "../scenegraph/bounds";
import { deleteNodesCommand, updateTransformCommand } from "../../editor/commands/basicCommands";
import { duplicateCommand } from "../../editor/commands/advancedCommands";
import { executeCsgTasks } from "../../editor/workers/csgClient";
import type { CsgSolvedMesh } from "../scenegraph/csgSolve";

(BufferGeometry.prototype as BufferGeometry & { computeBoundsTree?: () => void; disposeBoundsTree?: () => void }).computeBoundsTree = computeBoundsTree;
(BufferGeometry.prototype as BufferGeometry & { computeBoundsTree?: () => void; disposeBoundsTree?: () => void }).disposeBoundsTree =
  disposeBoundsTree;
(Mesh.prototype as Mesh).raycast = acceleratedRaycast;

type InstancedGroup = {
  key: string;
  prototype: RenderPrimitive;
  items: RenderPrimitive[];
  nodeIds: string[];
};

function canUseInstancing(item: RenderPrimitive): boolean {
  if (item.mode !== "solid") {
    return false;
  }
  return item.primitive === "box" || item.primitive === "cylinder" || item.primitive === "sphere" || item.primitive === "cone";
}

function instancingSignature(item: RenderPrimitive): string {
  return `${item.primitive}|${item.materialId ?? "default"}|${JSON.stringify(item.params)}`;
}

function buildInstancingPlan(
  items: RenderPrimitive[],
  selection: string[],
  hoveredNodeId: string | null,
  minGroupSize: number
): { directItems: RenderPrimitive[]; instancedGroups: InstancedGroup[] } {
  const pinned = new Set(selection);
  if (hoveredNodeId) {
    pinned.add(hoveredNodeId);
  }

  const directItems: RenderPrimitive[] = [];
  const grouped = new Map<string, RenderPrimitive[]>();

  for (const item of items) {
    if (!canUseInstancing(item) || pinned.has(item.nodeId)) {
      directItems.push(item);
      continue;
    }

    const key = instancingSignature(item);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }

  const instancedGroups: InstancedGroup[] = [];
  for (const [key, bucket] of grouped.entries()) {
    if (bucket.length < minGroupSize) {
      directItems.push(...bucket);
      continue;
    }

    instancedGroups.push({
      key,
      prototype: bucket[0],
      items: bucket,
      nodeIds: bucket.map((item) => item.nodeId)
    });
  }

  return { directItems, instancedGroups };
}

function computeInstancedGroupBounds(groups: InstancedGroup[]): Map<string, { center: [number, number, number]; radius: number }> {
  const out = new Map<string, { center: [number, number, number]; radius: number }>();

  for (const group of groups) {
    if (group.items.length === 0) {
      continue;
    }

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const item of group.items) {
      sumX += item.transform.position[0];
      sumY += item.transform.position[1];
      sumZ += item.transform.position[2];
    }

    const cx = sumX / group.items.length;
    const cy = sumY / group.items.length;
    const cz = sumZ / group.items.length;

    let radius = 0;
    for (const item of group.items) {
      const dx = item.transform.position[0] - cx;
      const dy = item.transform.position[1] - cy;
      const dz = item.transform.position[2] - cz;
      const distance = Math.hypot(dx, dy, dz);
      radius = Math.max(radius, distance + primitiveScaleRadius(item));
    }

    out.set(group.key, {
      center: [cx, cy, cz],
      radius: Math.max(radius, 1)
    });
  }

  return out;
}

function FramePerformanceProbe(): null {
  const ingestFrameMs = useQualityStore((state) => state.ingestFrameMs);
  useFrame((_state, delta) => {
    ingestFrameMs(delta * 1000);
  });
  return null;
}

function SceneContent(): JSX.Element {
  const data = useEditorStore((state) => state.data);
  const selection = useEditorStore((state) => state.data.selection);
  const setSelection = useEditorStore((state) => state.setSelection);
  const toolMode = useEditorStore((state) => state.toolMode);
  const setToolMode = useEditorStore((state) => state.setToolMode);
  const hoveredNodeId = useEditorStore((state) => state.hoveredNodeId);
  const setHoveredNodeId = useEditorStore((state) => state.setHoveredNodeId);
  const updateTransformDirect = useEditorStore((state) => state.updateTransformDirect);
  const executeCommand = useEditorStore((state) => state.executeCommand);
  const addLog = useEditorStore((state) => state.addLog);
  const frameRequestIds = useEditorStore((state) => state.frameRequestIds);
  const frameRequestToken = useEditorStore((state) => state.frameRequestToken);
  const qualityProfile = useQualityStore((state) => state.profile);
  const effectiveLevel = useQualityStore((state) => state.effectiveLevel);
  const setRenderStats = useQualityStore((state) => state.setRenderStats);
  const camera = useThree((state) => state.camera as PerspectiveCamera);

  const evaluated = useMemo(() => evaluateProject(data.project), [data.project]);
  const sceneRuntimeProfile = useMemo(() => computeSceneRuntimeProfile(evaluated.items, effectiveLevel), [evaluated.items, effectiveLevel]);
  const instancingPlan = useMemo(
    () => buildInstancingPlan(evaluated.items, selection, hoveredNodeId, sceneRuntimeProfile.instancingThreshold),
    [evaluated.items, hoveredNodeId, sceneRuntimeProfile.instancingThreshold, selection]
  );
  const directItems = instancingPlan.directItems;
  const instancedGroups = instancingPlan.instancedGroups;

  const directItemById = useMemo(() => {
    const map = new Map<string, RenderPrimitive>();
    for (const item of directItems) {
      map.set(item.nodeId, item);
    }
    return map;
  }, [directItems]);

  const instancedGroupByKey = useMemo(() => {
    const map = new Map<string, InstancedGroup>();
    for (const group of instancedGroups) {
      map.set(group.key, group);
    }
    return map;
  }, [instancedGroups]);

  const instancedBoundsByKey = useMemo(() => computeInstancedGroupBounds(instancedGroups), [instancedGroups]);

  const meshRefs = useRef<Record<string, Mesh | null>>({});
  const instancedMeshRefs = useRef<Record<string, InstancedMesh | null>>({});
  const lodByNodeId = useRef<Record<string, GeometryLodLevel>>({});
  const lodByGroupKey = useRef<Record<string, GeometryLodLevel>>({});

  const cullProjection = useRef(new Matrix4());
  const cullFrustum = useRef(new Frustum());
  const cullSphere = useRef(new Sphere());
  const cullCenter = useRef(new Vector3());
  const cullHiddenAtMs = useRef<Record<string, number>>({});
  const previousCameraPosition = useRef(new Vector3());
  const hasPreviousCameraPosition = useRef(false);

  const instancingDummy = useRef(new Object3D());

  const transformStart = useRef<{ nodeId: string; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null>(
    null
  );
  const [transformObject, setTransformObject] = useState<Object3D | null>(null);
  const [csgMeshes, setCsgMeshes] = useState<CsgSolvedMesh[]>([]);

  useEffect(() => {
    const alive = new Set(directItems.map((item) => item.nodeId));
    for (const key of Object.keys(meshRefs.current)) {
      if (!alive.has(key)) {
        delete meshRefs.current[key];
        delete lodByNodeId.current[key];
        delete cullHiddenAtMs.current[`n:${key}`];
      }
    }
  }, [directItems]);

  useEffect(() => {
    const alive = new Set(instancedGroups.map((group) => group.key));
    for (const key of Object.keys(instancedMeshRefs.current)) {
      if (!alive.has(key)) {
        delete instancedMeshRefs.current[key];
        delete lodByGroupKey.current[key];
        delete cullHiddenAtMs.current[`g:${key}`];
      }
    }
  }, [instancedGroups]);

  useEffect(() => {
    const dummy = instancingDummy.current;
    for (const group of instancedGroups) {
      const mesh = instancedMeshRefs.current[group.key];
      if (!mesh) {
        continue;
      }

      for (let index = 0; index < group.items.length; index += 1) {
        const item = group.items[index];
        dummy.position.set(item.transform.position[0], item.transform.position[1], item.transform.position[2]);
        dummy.rotation.set(item.transform.rotation[0], item.transform.rotation[1], item.transform.rotation[2]);
        dummy.scale.set(item.transform.scale[0], item.transform.scale[1], item.transform.scale[2]);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;
    }
  }, [instancedGroups]);

  useFrame((state, delta) => {
    const snapshot = useEditorStore.getState().data.project;
    physicsRuntime.step(snapshot, delta, {
      onLog: addLog,
      onUpdateTransform: (nodeId, transform) => {
        updateTransformDirect(nodeId, transform);
      }
    });

    const events = physicsRuntime.drainStepEvents().filter((item) => item.type === "enter" || item.type === "exit");
    if (events.length > 0) {
      const recent = events[events.length - 1];
      if (recent) {
        addLog(`[physics] ${recent.type} ${recent.a}<->${recent.b}`);
      }
    }

    camera.updateMatrixWorld();
    cullProjection.current.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    cullFrustum.current.setFromProjectionMatrix(cullProjection.current);

    const nowMs = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    let cameraSpeed = 0;
    if (hasPreviousCameraPosition.current) {
      const moved = previousCameraPosition.current.distanceTo(camera.position);
      cameraSpeed = moved / Math.max(delta, 0.001);
    } else {
      hasPreviousCameraPosition.current = true;
    }
    previousCameraPosition.current.copy(camera.position);

    const dynamicCullMargin = Number((sceneRuntimeProfile.cullBaseMargin + clamp(cameraSpeed * 0.0019, 0, 0.22)).toFixed(3));
    const cullGraceMs = sceneRuntimeProfile.cullGraceMs;
    const lodDistances = sceneRuntimeProfile.lodDistances;

    let visibleMeshes = csgMeshes.length;
    let culledMeshes = 0;
    let visibleInstancedGroups = 0;
    const lodUsage: Record<GeometryLodLevel, number> = {
      high: 0,
      medium: 0,
      low: 0
    };

    for (const [nodeId, mesh] of Object.entries(meshRefs.current)) {
      if (!mesh) {
        continue;
      }

      const item = directItemById.get(nodeId);
      if (!item) {
        continue;
      }

      const radius = primitiveScaleRadius(item) * dynamicCullMargin;
      cullCenter.current.set(item.transform.position[0], item.transform.position[1], item.transform.position[2]);
      cullSphere.current.center.copy(cullCenter.current);
      cullSphere.current.radius = Math.max(0.5, radius);

      const cullKey = `n:${nodeId}`;
      const intersects = cullFrustum.current.intersectsSphere(cullSphere.current);
      let isVisible = intersects;
      if (intersects) {
        delete cullHiddenAtMs.current[cullKey];
      } else {
        const hiddenAt = cullHiddenAtMs.current[cullKey] ?? nowMs;
        cullHiddenAtMs.current[cullKey] = hiddenAt;
        if (nowMs - hiddenAt < cullGraceMs) {
          isVisible = true;
        }
      }

      mesh.visible = isVisible;
      if (!isVisible) {
        culledMeshes += 1;
        continue;
      }

      visibleMeshes += 1;
      const distance = camera.position.distanceTo(cullCenter.current);
      const lodLevel = resolveLodLevel(distance, lodDistances);
      lodUsage[lodLevel] += 1;

      if (lodByNodeId.current[nodeId] !== lodLevel) {
        mesh.geometry = buildGeometryFromPrimitive(item, lodLevel);
        lodByNodeId.current[nodeId] = lodLevel;
      }
    }

    for (const [groupKey, mesh] of Object.entries(instancedMeshRefs.current)) {
      if (!mesh) {
        continue;
      }

      const group = instancedGroupByKey.get(groupKey);
      const bounds = instancedBoundsByKey.get(groupKey);
      if (!group || !bounds) {
        continue;
      }

      cullCenter.current.set(bounds.center[0], bounds.center[1], bounds.center[2]);
      cullSphere.current.center.copy(cullCenter.current);
      cullSphere.current.radius = bounds.radius * dynamicCullMargin;

      const cullKey = `g:${groupKey}`;
      const intersects = cullFrustum.current.intersectsSphere(cullSphere.current);
      let isVisible = intersects;
      if (intersects) {
        delete cullHiddenAtMs.current[cullKey];
      } else {
        const hiddenAt = cullHiddenAtMs.current[cullKey] ?? nowMs;
        cullHiddenAtMs.current[cullKey] = hiddenAt;
        if (nowMs - hiddenAt < cullGraceMs) {
          isVisible = true;
        }
      }

      mesh.visible = isVisible;
      if (!isVisible) {
        culledMeshes += group.items.length;
        continue;
      }

      visibleInstancedGroups += 1;
      visibleMeshes += group.items.length;
      const distance = camera.position.distanceTo(cullCenter.current);
      const lodLevel = resolveLodLevel(distance, lodDistances);
      lodUsage[lodLevel] += group.items.length;

      if (lodByGroupKey.current[groupKey] !== lodLevel) {
        mesh.geometry = buildGeometryFromPrimitive(group.prototype, lodLevel);
        lodByGroupKey.current[groupKey] = lodLevel;
      }
    }

    setRenderStats({
      drawCalls: state.gl.info.render.calls,
      triangles: state.gl.info.render.triangles,
      lines: state.gl.info.render.lines,
      points: state.gl.info.render.points,
      visibleMeshes,
      culledMeshes,
      instancedGroups: visibleInstancedGroups,
      lodHigh: lodUsage.high,
      lodMedium: lodUsage.medium,
      lodLow: lodUsage.low,
      sceneProfile: sceneRuntimeProfile.sceneProfile,
      sceneRadius: sceneRuntimeProfile.sceneRadius,
      sceneNodeCount: sceneRuntimeProfile.sceneNodeCount,
      instancingThreshold: sceneRuntimeProfile.instancingThreshold,
      cullMargin: dynamicCullMargin,
      lodNearDistance: lodDistances.near,
      lodMidDistance: lodDistances.mid
    });
  });

  useEffect(() => {
    let cancelled = false;

    async function solve() {
      if (evaluated.booleanTasks.length === 0) {
        setCsgMeshes([]);
        return;
      }

      try {
        const result = await executeCsgTasks(evaluated.booleanTasks);
        if (!cancelled) {
          setCsgMeshes(result);
          const warnings = result.filter((item) => item.warning).map((item) => item.warning as string);
          for (const warning of warnings) {
            addLog(`[csg] ${warning}`);
          }
          for (const mesh of result) {
            if (mesh.diagnostics && !mesh.diagnostics.watertight) {
              addLog(
                `[csg] manifold warning ${mesh.groupId} boundary=${mesh.diagnostics.boundaryEdges} nonManifold=${mesh.diagnostics.nonManifoldEdges} degenerate=${mesh.diagnostics.degenerateFaces}`
              );
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          addLog(`[csg] worker failure: ${String(error)}`);
          setCsgMeshes([]);
        }
      }
    }

    void solve();

    return () => {
      cancelled = true;
    };
  }, [addLog, evaluated.booleanTasks]);

  useEffect(() => {
    const selectedId = selection.length === 1 ? selection[0] : null;
    setTransformObject(selectedId ? meshRefs.current[selectedId] ?? null : null);
  }, [selection, directItems.length]);

  useEffect(() => {
    if (frameRequestToken === 0) {
      return;
    }

    const targetIds = frameRequestIds.length > 0 ? frameRequestIds : selection;
    const targetItems = targetIds.length > 0 ? evaluated.items.filter((item) => targetIds.includes(item.nodeId)) : evaluated.items;
    const bounds = computeSelectionBounds(targetItems);
    if (!bounds) {
      return;
    }
    frameBounds(camera, bounds);
  }, [camera, evaluated.items, frameRequestIds, frameRequestToken, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mode = modeFromKeyboardKey(event.key);
      if (mode) {
        setToolMode(mode);
        return;
      }

      if (event.key === "Escape") {
        setSelection([]);
        return;
      }

      if (event.key === "Delete" && selection.length > 0) {
        executeCommand(deleteNodesCommand(selection));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && selection.length > 0) {
        executeCommand(duplicateCommand(selection));
        return;
      }

      if (event.key.toLowerCase() === "f" && selection.length > 0) {
        const selectedItems = evaluated.items.filter((item) => selection.includes(item.nodeId));
        const bounds = computeSelectionBounds(selectedItems);
        if (bounds) {
          frameBounds(camera, bounds);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [camera, evaluated.items, executeCommand, selection, setSelection, setToolMode]);

  function handleInstancedSelection(event: ThreeEvent<MouseEvent>, group: InstancedGroup): void {
    event.stopPropagation();
    const index = typeof event.instanceId === "number" ? event.instanceId : -1;
    const nodeId = group.nodeIds[index];
    if (!nodeId) {
      return;
    }
    setSelection(applySelectionRules(selection, nodeId, event.shiftKey));
  }

  function handleInstancedPointerOver(event: ThreeEvent<PointerEvent>, group: InstancedGroup): void {
    event.stopPropagation();
    const index = typeof event.instanceId === "number" ? event.instanceId : -1;
    const nodeId = group.nodeIds[index];
    if (!nodeId) {
      return;
    }
    setHoveredNodeId(nodeId);
  }

  return (
    <>
      <FramePerformanceProbe />
      <SceneLighting shadows={qualityProfile.shadows} />
      <SceneGrid size={data.project.grid.size} />

      {directItems.map((item) => {
        const geometryLod = lodByNodeId.current[item.nodeId] ?? "high";
        const geometry = buildGeometryFromPrimitive(item, geometryLod);
        const materialDef = data.project.materials[item.materialId ?? ""];
        const material = buildThreeMaterial(materialDef, (id) => data.project.textures[id]);
        const isSelected = selection.includes(item.nodeId);
        const isHovered = hoveredNodeId === item.nodeId;
        material.wireframe = item.mode === "hole";
        material.color.set(item.mode === "hole" ? "#7fb5ff" : material.color);
        material.emissive?.set(isSelected ? "#3d5a80" : isHovered ? "#1f3c5c" : "#000000");

        return (
          <mesh
            key={item.nodeId}
            ref={(ref) => {
              if (ref) {
                meshRefs.current[item.nodeId] = ref;
                if (!lodByNodeId.current[item.nodeId]) {
                  lodByNodeId.current[item.nodeId] = geometryLod;
                }
              } else {
                delete meshRefs.current[item.nodeId];
                delete lodByNodeId.current[item.nodeId];
              }
            }}
            castShadow={qualityProfile.shadows}
            receiveShadow={qualityProfile.shadows}
            geometry={geometry}
            material={material}
            position={item.transform.position}
            rotation={item.transform.rotation}
            scale={item.transform.scale}
            onClick={(event) => {
              event.stopPropagation();
              setSelection(applySelectionRules(selection, item.nodeId, event.shiftKey));
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              setHoveredNodeId(item.nodeId);
            }}
            onPointerOut={() => setHoveredNodeId(null)}
          />
        );
      })}

      {instancedGroups.map((group) => {
        const geometryLod = lodByGroupKey.current[group.key] ?? "high";
        const geometry = buildGeometryFromPrimitive(group.prototype, geometryLod);
        const materialDef = data.project.materials[group.prototype.materialId ?? ""];
        const material = buildThreeMaterial(materialDef, (id) => data.project.textures[id]);

        return (
          <instancedMesh
            key={group.key}
            ref={(ref) => {
              if (ref) {
                instancedMeshRefs.current[group.key] = ref;
                if (!lodByGroupKey.current[group.key]) {
                  lodByGroupKey.current[group.key] = geometryLod;
                }
              } else {
                delete instancedMeshRefs.current[group.key];
                delete lodByGroupKey.current[group.key];
              }
            }}
            args={[geometry, material, group.items.length]}
            castShadow={qualityProfile.shadows}
            receiveShadow={qualityProfile.shadows}
            onClick={(event) => handleInstancedSelection(event, group)}
            onPointerOver={(event) => handleInstancedPointerOver(event, group)}
            onPointerOut={() => setHoveredNodeId(null)}
          />
        );
      })}

      {csgMeshes.map((item) => {
        if (!item.geometry) {
          return null;
        }
        const groupNode = data.project.nodes[item.groupId];
        const materialDef = groupNode?.materialId ? data.project.materials[groupNode.materialId] : undefined;
        const material = buildThreeMaterial(materialDef, (id) => data.project.textures[id]);
        const isSelected = selection.includes(item.groupId);
        const isHovered = hoveredNodeId === item.groupId;
        material.emissive?.set(isSelected ? "#2f4d72" : isHovered ? "#23364f" : "#000000");
        return (
          <mesh
            key={item.groupId}
            castShadow={qualityProfile.shadows}
            receiveShadow={qualityProfile.shadows}
            geometry={item.geometry}
            material={material}
            onClick={(event) => {
              event.stopPropagation();
              setSelection(applySelectionRules(selection, item.groupId, event.shiftKey));
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              setHoveredNodeId(item.groupId);
            }}
            onPointerOut={() => setHoveredNodeId(null)}
          />
        );
      })}

      <mesh
        visible={false}
        onClick={() => {
          setSelection([]);
        }}
      />

      {transformObject && selection.length === 1 && (
        <TransformControls
          mode={toolMode}
          object={transformObject}
          translationSnap={data.project.grid.snap}
          rotationSnap={(Math.PI / 180) * data.project.grid.angleSnap}
          scaleSnap={data.project.grid.snap}
          onMouseDown={() => {
            const nodeId = selection[0];
            const node = data.project.nodes[nodeId];
            if (!node) {
              return;
            }
            transformStart.current = {
              nodeId,
              position: [...node.transform.position] as [number, number, number],
              rotation: [...node.transform.rotation] as [number, number, number],
              scale: [...node.transform.scale] as [number, number, number]
            };
          }}
          onObjectChange={() => {
            const nodeId = selection[0];
            const ref = meshRefs.current[nodeId];
            if (!ref) {
              return;
            }
            updateTransformDirect(nodeId, {
              position: [ref.position.x, ref.position.y, ref.position.z],
              rotation: [ref.rotation.x, ref.rotation.y, ref.rotation.z],
              scale: [ref.scale.x, ref.scale.y, ref.scale.z]
            });
          }}
          onMouseUp={() => {
            const start = transformStart.current;
            const nodeId = selection[0];
            const node = useEditorStore.getState().data.project.nodes[nodeId];
            if (!start || !node || start.nodeId !== nodeId) {
              return;
            }
            executeCommand(updateTransformCommand(nodeId, start, node.transform));
            addLog(
              `[transform] ${nodeId} p=${node.transform.position.map((value) => value.toFixed(2)).join(",")} mode=${toolMode}`
            );
            transformStart.current = null;
          }}
        />
      )}

      <OrbitControls makeDefault />
    </>
  );
}

export default function Canvas3D(): JSX.Element {
  const qualityProfile = useQualityStore((state) => state.profile);

  return (
    <div className="canvas-root">
      <Canvas
        camera={{ position: [80, 80, 80], fov: 45 }}
        dpr={qualityProfile.dpr}
        shadows={qualityProfile.shadows}
        gl={{
          antialias: qualityProfile.antialias,
          powerPreference: qualityProfile.powerPreference
        }}
      >
        <SceneContent />
      </Canvas>
    </div>
  );
}
