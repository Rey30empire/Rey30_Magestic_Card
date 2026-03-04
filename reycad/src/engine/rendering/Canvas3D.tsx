import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { BufferGeometry, Frustum, InstancedMesh, Matrix4, Mesh, Object3D, PerspectiveCamera, Sphere, Vector3 } from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useEditorStore } from "../../editor/state/editorStore";
import { useQualityStore } from "../runtime/qualityStore";
import { physicsRuntime } from "../runtime/physicsRuntime";
import { evaluateProject, type RenderPrimitive } from "../scenegraph/evaluator";
import { buildGeometryFromPrimitive, type GeometryLodLevel } from "./geometry";
import {
  clamp,
  computeSceneRuntimeProfile,
  evaluateSceneBudgetUsage,
  primitiveScaleRadius,
  resolveLodLevel,
  resolveSceneBudgetTargets,
  type SceneBudgetAlertLevel
} from "./renderTuning";
import { buildThreeMaterial } from "./materials";
import { SceneLighting } from "./lighting";
import { SceneGrid } from "./grid";
import { runtimeAssetManager } from "../runtime/assetManager";
import { FrameBudgetScheduler } from "../runtime/frameBudgetScheduler";
import { RuntimeJobSystemLite } from "../runtime/jobSystemLite";
import { applySelectionRules } from "../interaction/selection";
import { modeFromKeyboardKey } from "../interaction/gizmo";
import { frameBounds } from "../interaction/camera";
import { computeSelectionBounds } from "../scenegraph/bounds";
import { deleteNodesCommand, updateTransformCommand } from "../../editor/commands/basicCommands";
import { duplicateCommand } from "../../editor/commands/advancedCommands";
import { executeCsgTasks } from "../../editor/workers/csgClient";
import type { CsgSolvedMesh } from "../scenegraph/csgSolve";
import type { MaterialDef, TextureAsset } from "../scenegraph/types";

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

type StaticBatchGroup = {
  key: string;
  materialId: string | undefined;
  itemCount: number;
  itemIds: string[];
  items: RenderPrimitive[];
  geometry: BufferGeometry;
  lodLevel: GeometryLodLevel;
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

function collectMaterialTextureIds(material: MaterialDef | undefined): string[] {
  if (!material || material.kind !== "pbr") {
    return [];
  }
  const pbr = material.pbr;
  if (!pbr) {
    return [];
  }

  const textureIds = [
    pbr.baseColorMapId,
    pbr.normalMapId,
    pbr.aoMapId,
    pbr.roughnessMapId,
    pbr.metalnessMapId,
    pbr.emissiveMapId
  ];
  return textureIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function resolveStaticBatchLod(level: "low" | "medium" | "high" | "ultra"): GeometryLodLevel {
  if (level === "low") {
    return "low";
  }
  if (level === "medium") {
    return "medium";
  }
  return "high";
}

function buildStaticBatchPlan(
  directItems: RenderPrimitive[],
  nodeRigidBodyEnabled: Record<string, boolean>,
  selection: string[],
  hoveredNodeId: string | null,
  effectiveLevel: "low" | "medium" | "high" | "ultra"
): { directItems: RenderPrimitive[]; staticBatchGroups: StaticBatchGroup[] } {
  const allowBatching = (effectiveLevel === "low" || effectiveLevel === "medium") && directItems.length >= 120;
  if (!allowBatching) {
    return {
      directItems,
      staticBatchGroups: []
    };
  }

  const selectionSet = new Set(selection);
  const byMaterial = new Map<string, RenderPrimitive[]>();
  const passthrough: RenderPrimitive[] = [];

  for (const item of directItems) {
    const isSelectable = selectionSet.has(item.nodeId) || item.nodeId === hoveredNodeId;
    const isStaticBody = !nodeRigidBodyEnabled[item.nodeId];
    const canBatchPrimitive =
      item.mode === "solid" &&
      isStaticBody &&
      !isSelectable &&
      (item.primitive === "box" || item.primitive === "cylinder" || item.primitive === "sphere" || item.primitive === "cone");

    if (!canBatchPrimitive) {
      passthrough.push(item);
      continue;
    }

    const key = item.materialId ?? "default";
    const bucket = byMaterial.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      byMaterial.set(key, [item]);
    }
  }

  const staticBatchGroups: StaticBatchGroup[] = [];
  const dummy = new Object3D();
  const lodLevel = resolveStaticBatchLod(effectiveLevel);
  let batchIndex = 0;

  for (const [materialKey, bucket] of byMaterial.entries()) {
    if (bucket.length < 3) {
      passthrough.push(...bucket);
      continue;
    }

    const chunkSize = 96;
    for (let start = 0; start < bucket.length; start += chunkSize) {
      const chunk = bucket.slice(start, Math.min(start + chunkSize, bucket.length));
      if (chunk.length < 3) {
        passthrough.push(...chunk);
        continue;
      }

      const geometries: BufferGeometry[] = [];
      for (const item of chunk) {
        const geometry = buildGeometryFromPrimitive(item, lodLevel).clone();
        dummy.position.set(item.transform.position[0], item.transform.position[1], item.transform.position[2]);
        dummy.rotation.set(item.transform.rotation[0], item.transform.rotation[1], item.transform.rotation[2]);
        dummy.scale.set(item.transform.scale[0], item.transform.scale[1], item.transform.scale[2]);
        dummy.updateMatrix();
        geometry.applyMatrix4(dummy.matrix);
        geometries.push(geometry);
      }

      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) {
        geometry.dispose();
      }

      if (!merged) {
        passthrough.push(...chunk);
        continue;
      }

      merged.computeBoundingSphere();
      staticBatchGroups.push({
        key: `sb:${materialKey}:${batchIndex}`,
        materialId: materialKey === "default" ? undefined : materialKey,
        itemCount: chunk.length,
        itemIds: chunk.map((item) => item.nodeId),
        items: chunk,
        geometry: merged,
        lodLevel
      });
      batchIndex += 1;
    }
  }

  return {
    directItems: passthrough,
    staticBatchGroups
  };
}

function computeStaticBatchBounds(groups: StaticBatchGroup[]): Map<string, { center: [number, number, number]; radius: number }> {
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

type HybridPrefetchPriority = "critical" | "high" | "normal" | "low";

function priorityRank(priority: HybridPrefetchPriority): number {
  if (priority === "critical") {
    return 4;
  }
  if (priority === "high") {
    return 3;
  }
  if (priority === "normal") {
    return 2;
  }
  return 1;
}

function maxPriority(current: HybridPrefetchPriority | undefined, next: HybridPrefetchPriority): HybridPrefetchPriority {
  if (!current) {
    return next;
  }
  return priorityRank(next) > priorityRank(current) ? next : current;
}

function tickNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
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
  const tickPlaySession = useEditorStore((state) => state.tickPlaySession);
  const frameRequestIds = useEditorStore((state) => state.frameRequestIds);
  const frameRequestToken = useEditorStore((state) => state.frameRequestToken);
  const qualityProfile = useQualityStore((state) => state.profile);
  const effectiveLevel = useQualityStore((state) => state.effectiveLevel);
  const setRenderStats = useQualityStore((state) => state.setRenderStats);
  const setAssetStats = useQualityStore((state) => state.setAssetStats);
  const camera = useThree((state) => state.camera as PerspectiveCamera);

  const evaluated = useMemo(() => evaluateProject(data.project), [data.project]);
  const nodeRigidBodyEnabled = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const node of Object.values(data.project.nodes)) {
      map[node.id] = Boolean(node.rigidBody?.enabled);
    }
    return map;
  }, [data.project.nodes]);
  const sceneRuntimeProfile = useMemo(() => computeSceneRuntimeProfile(evaluated.items, effectiveLevel), [evaluated.items, effectiveLevel]);
  const instancingPlan = useMemo(
    () => buildInstancingPlan(evaluated.items, selection, hoveredNodeId, sceneRuntimeProfile.instancingThreshold),
    [evaluated.items, hoveredNodeId, sceneRuntimeProfile.instancingThreshold, selection]
  );
  const instancedGroups = instancingPlan.instancedGroups;
  const staticBatchPlan = useMemo(
    () => buildStaticBatchPlan(instancingPlan.directItems, nodeRigidBodyEnabled, selection, hoveredNodeId, effectiveLevel),
    [effectiveLevel, hoveredNodeId, instancingPlan.directItems, nodeRigidBodyEnabled, selection]
  );
  const directItems = staticBatchPlan.directItems;
  const staticBatchGroups = staticBatchPlan.staticBatchGroups;

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
  const staticBatchGroupByKey = useMemo(() => {
    const map = new Map<string, StaticBatchGroup>();
    for (const group of staticBatchGroups) {
      map.set(group.key, group);
    }
    return map;
  }, [staticBatchGroups]);

  const instancedBoundsByKey = useMemo(() => computeInstancedGroupBounds(instancedGroups), [instancedGroups]);
  const staticBatchBoundsByKey = useMemo(() => computeStaticBatchBounds(staticBatchGroups), [staticBatchGroups]);
  const referencedTextureAssets = useMemo(() => {
    const ids = new Set<string>();
    for (const item of evaluated.items) {
      const material = data.project.materials[item.materialId ?? ""];
      for (const textureId of collectMaterialTextureIds(material)) {
        ids.add(textureId);
      }
    }

    const out: Array<{ id: string; asset: (typeof data.project.textures)[string] }> = [];
    for (const id of ids) {
      const asset = data.project.textures[id];
      if (asset) {
        out.push({ id, asset });
      }
    }
    return out;
  }, [data.project.materials, data.project.textures, evaluated.items]);
  const selectedTextureAssets = useMemo(() => {
    const selectedIds = new Set(selection);
    const textureIds = new Set<string>();
    for (const item of evaluated.items) {
      if (!selectedIds.has(item.nodeId)) {
        continue;
      }
      const material = data.project.materials[item.materialId ?? ""];
      for (const textureId of collectMaterialTextureIds(material)) {
        textureIds.add(textureId);
      }
    }

    const out: Array<{ id: string; asset: (typeof data.project.textures)[string] }> = [];
    for (const id of textureIds) {
      const asset = data.project.textures[id];
      if (asset) {
        out.push({ id, asset });
      }
    }
    return out;
  }, [data.project.materials, data.project.textures, evaluated.items, selection]);
  const texturePrefetchCandidates = useMemo(() => {
    const candidates: Array<{
      nodeId: string;
      position: [number, number, number];
      assets: TextureAsset[];
    }> = [];
    for (const item of evaluated.items) {
      const material = data.project.materials[item.materialId ?? ""];
      const textureIds = collectMaterialTextureIds(material);
      if (textureIds.length === 0) {
        continue;
      }
      const assets: TextureAsset[] = [];
      for (const textureId of textureIds) {
        const asset = data.project.textures[textureId];
        if (asset) {
          assets.push(asset);
        }
      }
      if (assets.length === 0) {
        continue;
      }
      candidates.push({
        nodeId: item.nodeId,
        position: item.transform.position,
        assets
      });
    }
    return candidates;
  }, [data.project.materials, data.project.textures, evaluated.items]);

  const meshRefs = useRef<Record<string, Mesh | null>>({});
  const instancedMeshRefs = useRef<Record<string, InstancedMesh | null>>({});
  const staticBatchMeshRefs = useRef<Record<string, Mesh | null>>({});
  const lodByNodeId = useRef<Record<string, GeometryLodLevel>>({});
  const lodByGroupKey = useRef<Record<string, GeometryLodLevel>>({});

  const cullProjection = useRef(new Matrix4());
  const cullFrustum = useRef(new Frustum());
  const cullSphere = useRef(new Sphere());
  const cullCenter = useRef(new Vector3());
  const cullHiddenAtMs = useRef<Record<string, number>>({});
  const previousCameraPosition = useRef(new Vector3());
  const hasPreviousCameraPosition = useRef(false);
  const budgetAlertState = useRef<{ level: SceneBudgetAlertLevel; lastLogAtMs: number }>({
    level: "ok",
    lastLogAtMs: 0
  });
  const hybridPrefetchNextAtMs = useRef(0);
  const frameBudgetSchedulerRef = useRef(new FrameBudgetScheduler());
  const runtimeJobSystemRef = useRef(new RuntimeJobSystemLite({ maxQueueSize: 480 }));
  const lastGpuPressureRef = useRef(1);

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
    const alive = new Set(staticBatchGroups.map((group) => group.key));
    for (const key of Object.keys(staticBatchMeshRefs.current)) {
      if (!alive.has(key)) {
        delete staticBatchMeshRefs.current[key];
        delete cullHiddenAtMs.current[`s:${key}`];
      }
    }
  }, [staticBatchGroups]);

  useEffect(() => {
    return () => {
      for (const group of staticBatchGroups) {
        group.geometry.dispose();
      }
    };
  }, [staticBatchGroups]);

  useEffect(
    () => () => {
      runtimeJobSystemRef.current.clear();
    },
    []
  );

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

  useEffect(() => {
    runtimeAssetManager.syncTextureAssets(data.project.textures);
    runtimeAssetManager.setPinnedTextureIds(referencedTextureAssets.map((entry) => entry.id));
    setAssetStats(runtimeAssetManager.getSnapshot());
  }, [data.project.textures, referencedTextureAssets, setAssetStats]);

  useFrame((state, delta) => {
    tickPlaySession();

    const frameStartedAtMs = tickNowMs();
    const frameBudgetScheduler = frameBudgetSchedulerRef.current;
    const runtimeJobs = runtimeJobSystemRef.current;
    const dynamicFrameBudgetMs = clamp(delta * 1000 * 0.94, 8.5, 24);
    frameBudgetScheduler.beginFrame(dynamicFrameBudgetMs, lastGpuPressureRef.current);

    const snapshot = useEditorStore.getState().data.project;
    const physicsStartedAtMs = tickNowMs();
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
    const physicsDurationMs = tickNowMs() - physicsStartedAtMs;
    frameBudgetScheduler.recordUsage("physics", physicsDurationMs);

    camera.updateMatrixWorld();
    cullProjection.current.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    cullFrustum.current.setFromProjectionMatrix(cullProjection.current);

    const nowMs = tickNowMs();
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
    const budgetTargets = resolveSceneBudgetTargets(sceneRuntimeProfile.sceneProfile, effectiveLevel, sceneRuntimeProfile.sceneNodeCount);

    let prefetchPlanningMs = 0;
    if (nowMs >= hybridPrefetchNextAtMs.current) {
      const prefetchStartedAtMs = tickNowMs();
      const prefetchReservation = frameBudgetScheduler.reserve("prefetch", 0.32);
      if (prefetchReservation.granted) {
        const hybridRequestsByTextureId = new Map<string, { asset: TextureAsset; priority: HybridPrefetchPriority }>();
        const selectedNodeIds = new Set(selection);

        for (const selected of selectedTextureAssets) {
          hybridRequestsByTextureId.set(selected.id, {
            asset: selected.asset,
            priority: "critical"
          });
        }

        const nearDistance = lodDistances.near * (1.5 + clamp(cameraSpeed * 0.004, 0, 1.4));
        const midDistance = lodDistances.mid * (1.2 + clamp(cameraSpeed * 0.003, 0, 1.6));
        const farDistance = lodDistances.mid * (2.1 + clamp(cameraSpeed * 0.0035, 0, 2.4));

        for (const candidate of texturePrefetchCandidates) {
          const dx = candidate.position[0] - camera.position.x;
          const dy = candidate.position[1] - camera.position.y;
          const dz = candidate.position[2] - camera.position.z;
          const distance = Math.hypot(dx, dy, dz);

          let priority: HybridPrefetchPriority | null = null;
          if (selectedNodeIds.has(candidate.nodeId)) {
            priority = "critical";
          } else if (hoveredNodeId && candidate.nodeId === hoveredNodeId) {
            priority = "high";
          } else if (distance <= nearDistance) {
            priority = "high";
          } else if (distance <= midDistance) {
            priority = "normal";
          } else if (
            distance <= farDistance &&
            (cameraSpeed > 25 || sceneRuntimeProfile.sceneProfile !== "indoor")
          ) {
            priority = "low";
          }

          if (!priority) {
            continue;
          }

          for (const asset of candidate.assets) {
            const existing = hybridRequestsByTextureId.get(asset.id);
            hybridRequestsByTextureId.set(asset.id, {
              asset,
              priority: maxPriority(existing?.priority, priority)
            });
          }
        }

        if (hybridRequestsByTextureId.size > 0) {
          const requests = [...hybridRequestsByTextureId.values()];
          runtimeJobs.enqueue({
            id: "prefetch:texture-hybrid",
            subsystem: "prefetch",
            priority: selectedTextureAssets.length > 0 ? "critical" : "normal",
            estimatedMs: Math.min(3.2, 0.2 + requests.length * 0.015),
            run: () => {
              runtimeAssetManager.prefetchTextureRequests(requests);
            }
          });
        }
      }
      const nextIntervalMs = cameraSpeed > 120 ? 120 : cameraSpeed > 45 ? 180 : 260;
      hybridPrefetchNextAtMs.current = nowMs + nextIntervalMs;
      prefetchPlanningMs = tickNowMs() - prefetchStartedAtMs;
      frameBudgetScheduler.recordUsage("prefetch", prefetchPlanningMs);
    }

    const cullingStartedAtMs = tickNowMs();
    let visibleMeshes = csgMeshes.length;
    let culledMeshes = 0;
    let visibleInstancedGroups = 0;
    let visibleStaticBatchGroups = 0;
    let visibleStaticBatchMeshes = 0;
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

    for (const [groupKey, mesh] of Object.entries(staticBatchMeshRefs.current)) {
      if (!mesh) {
        continue;
      }

      const group = staticBatchGroupByKey.get(groupKey);
      const bounds = staticBatchBoundsByKey.get(groupKey);
      if (!group || !bounds) {
        continue;
      }

      cullCenter.current.set(bounds.center[0], bounds.center[1], bounds.center[2]);
      cullSphere.current.center.copy(cullCenter.current);
      cullSphere.current.radius = bounds.radius * dynamicCullMargin;

      const cullKey = `s:${groupKey}`;
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
        culledMeshes += group.itemCount;
        continue;
      }

      visibleStaticBatchGroups += 1;
      visibleStaticBatchMeshes += group.itemCount;
      visibleMeshes += group.itemCount;
      lodUsage[group.lodLevel] += group.itemCount;
    }
    const cullingDurationMs = tickNowMs() - cullingStartedAtMs;
    frameBudgetScheduler.recordUsage("culling", cullingDurationMs);

    const budgetUsage = evaluateSceneBudgetUsage(state.gl.info.render.calls, state.gl.info.render.triangles, budgetTargets);
    const gpuPressure = Number(Math.max(budgetUsage.drawCallUsage, budgetUsage.triangleUsage).toFixed(3));
    lastGpuPressureRef.current = gpuPressure;
    const previousBudget = budgetAlertState.current;
    const shouldLogTransition = previousBudget.level !== budgetUsage.alert;
    const shouldLogPulse = budgetUsage.alert !== "ok" && nowMs - previousBudget.lastLogAtMs >= 5000;
    if (shouldLogTransition || shouldLogPulse) {
      if (budgetUsage.alert === "ok") {
        addLog("[perf] budget recovered");
      } else {
        const reasons = budgetUsage.reasons.length > 0 ? ` ${budgetUsage.reasons.join(" | ")}` : "";
        addLog(`[perf] budget ${budgetUsage.alert}${reasons}`);
      }
      budgetAlertState.current = {
        level: budgetUsage.alert,
        lastLogAtMs: nowMs
      };
    }

    const jobsReservation = frameBudgetScheduler.reserve("jobs", 0.22);
    let jobsExecuted = 0;
    let jobsDeferred = 0;
    let jobsDropped = 0;
    let jobRuntimeDurationMs = 0;
    if (jobsReservation.granted && jobsReservation.allowanceMs > 0.02) {
      const jobSummary = runtimeJobs.drain(jobsReservation.allowanceMs);
      frameBudgetScheduler.recordUsage("jobs", jobSummary.durationMs);
      jobRuntimeDurationMs = jobSummary.durationMs;
      jobsExecuted = jobSummary.executed;
      jobsDeferred = jobSummary.deferred;
      jobsDropped = jobSummary.dropped;
      if (jobSummary.deferred > 0) {
        frameBudgetScheduler.markDeferred("jobs", 1);
      }
    } else {
      const pending = runtimeJobs.getSnapshot();
      jobsDeferred = pending.queueDepth;
      jobsDropped = pending.droppedPending;
    }

    const measuredWithoutMiscMs = tickNowMs() - frameStartedAtMs;
    const miscDurationMs = Math.max(0, measuredWithoutMiscMs - (physicsDurationMs + cullingDurationMs + prefetchPlanningMs + jobRuntimeDurationMs));
    frameBudgetScheduler.recordUsage("misc", miscDurationMs);
    const frameBudgetSummary = frameBudgetScheduler.getSnapshot();
    const jobSnapshot = runtimeJobs.getSnapshot();

    setRenderStats({
      drawCalls: state.gl.info.render.calls,
      triangles: state.gl.info.render.triangles,
      budgetDrawCallsTarget: budgetUsage.targets.drawCalls,
      budgetTrianglesTarget: budgetUsage.targets.triangles,
      budgetDrawCallUsage: budgetUsage.drawCallUsage,
      budgetTriangleUsage: budgetUsage.triangleUsage,
      budgetAlert: budgetUsage.alert,
      lines: state.gl.info.render.lines,
      points: state.gl.info.render.points,
      visibleMeshes,
      culledMeshes,
      instancedGroups: visibleInstancedGroups,
      staticBatchGroups: visibleStaticBatchGroups,
      staticBatchMeshes: visibleStaticBatchMeshes,
      lodHigh: lodUsage.high,
      lodMedium: lodUsage.medium,
      lodLow: lodUsage.low,
      sceneProfile: sceneRuntimeProfile.sceneProfile,
      sceneRadius: sceneRuntimeProfile.sceneRadius,
      sceneNodeCount: sceneRuntimeProfile.sceneNodeCount,
      instancingThreshold: sceneRuntimeProfile.instancingThreshold,
      cullMargin: dynamicCullMargin,
      lodNearDistance: lodDistances.near,
      lodMidDistance: lodDistances.mid,
      cpuFrameBudgetMs: frameBudgetSummary.frameBudgetMs,
      cpuFrameUsedMs: frameBudgetSummary.frameUsedMs,
      cpuFrameRemainingMs: frameBudgetSummary.frameRemainingMs,
      cpuPressure: frameBudgetSummary.cpuPressure,
      gpuPressure,
      jobQueueDepth: jobSnapshot.queueDepth,
      jobsExecuted,
      jobsDeferred,
      jobsDropped,
      physicsBudgetMs: frameBudgetSummary.subsystems.physics.budgetMs,
      physicsUsedMs: frameBudgetSummary.subsystems.physics.usedMs,
      physicsDeferred: frameBudgetSummary.subsystems.physics.deferred,
      cullingBudgetMs: frameBudgetSummary.subsystems.culling.budgetMs,
      cullingUsedMs: frameBudgetSummary.subsystems.culling.usedMs,
      cullingDeferred: frameBudgetSummary.subsystems.culling.deferred,
      prefetchBudgetMs: frameBudgetSummary.subsystems.prefetch.budgetMs,
      prefetchUsedMs: frameBudgetSummary.subsystems.prefetch.usedMs,
      prefetchDeferred: frameBudgetSummary.subsystems.prefetch.deferred,
      jobSystemBudgetMs: frameBudgetSummary.subsystems.jobs.budgetMs,
      jobSystemUsedMs: frameBudgetSummary.subsystems.jobs.usedMs,
      jobSystemDeferred: frameBudgetSummary.subsystems.jobs.deferred,
      miscBudgetMs: frameBudgetSummary.subsystems.misc.budgetMs,
      miscUsedMs: frameBudgetSummary.subsystems.misc.usedMs,
      miscDeferred: frameBudgetSummary.subsystems.misc.deferred
    });
    setAssetStats(runtimeAssetManager.getSnapshot());
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

  function nearestNodeIdFromBatchPoint(group: StaticBatchGroup, point: [number, number, number]): string | null {
    let nearestId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const item of group.items) {
      const dx = item.transform.position[0] - point[0];
      const dy = item.transform.position[1] - point[1];
      const dz = item.transform.position[2] - point[2];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = item.nodeId;
      }
    }
    return nearestId;
  }

  function handleStaticBatchSelection(event: ThreeEvent<MouseEvent>, group: StaticBatchGroup): void {
    event.stopPropagation();
    const point: [number, number, number] = [event.point.x, event.point.y, event.point.z];
    const nodeId = nearestNodeIdFromBatchPoint(group, point);
    if (!nodeId) {
      return;
    }
    setSelection(applySelectionRules(selection, nodeId, event.shiftKey));
  }

  function handleStaticBatchPointerOver(event: ThreeEvent<PointerEvent>, group: StaticBatchGroup): void {
    event.stopPropagation();
    const point: [number, number, number] = [event.point.x, event.point.y, event.point.z];
    const nodeId = nearestNodeIdFromBatchPoint(group, point);
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

      {staticBatchGroups.map((group) => {
        const materialDef = group.materialId ? data.project.materials[group.materialId] : undefined;
        const material = buildThreeMaterial(materialDef, (id) => data.project.textures[id]);
        return (
          <mesh
            key={group.key}
            ref={(ref) => {
              if (ref) {
                staticBatchMeshRefs.current[group.key] = ref;
              } else {
                delete staticBatchMeshRefs.current[group.key];
              }
            }}
            castShadow={qualityProfile.shadows}
            receiveShadow={qualityProfile.shadows}
            geometry={group.geometry}
            material={material}
            onClick={(event) => handleStaticBatchSelection(event, group)}
            onPointerOver={(event) => handleStaticBatchPointerOver(event, group)}
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
