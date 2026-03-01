import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { BufferGeometry, Mesh, Object3D, PerspectiveCamera } from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { useEditorStore } from "../../editor/state/editorStore";
import { evaluateProject } from "../scenegraph/evaluator";
import { buildGeometryFromPrimitive } from "./geometry";
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
  const camera = useThree((state) => state.camera as PerspectiveCamera);

  const evaluated = useMemo(() => evaluateProject(data.project), [data.project]);
  const meshRefs = useRef<Record<string, Mesh>>({});
  const transformStart = useRef<{ nodeId: string; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null>(
    null
  );
  const [transformObject, setTransformObject] = useState<Object3D | null>(null);
  const [csgMeshes, setCsgMeshes] = useState<CsgSolvedMesh[]>([]);

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
  }, [selection, evaluated.items.length]);

  useEffect(() => {
    if (frameRequestToken === 0) {
      return;
    }

    const targetIds = frameRequestIds.length > 0 ? frameRequestIds : selection;
    const targetItems =
      targetIds.length > 0 ? evaluated.items.filter((item) => targetIds.includes(item.nodeId)) : evaluated.items;
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

  return (
    <>
      <SceneLighting />
      <SceneGrid size={data.project.grid.size} />

      {evaluated.items.map((item) => {
        const geometry = buildGeometryFromPrimitive(item);
        const materialDef = data.project.materials[item.materialId ?? ""];
        const material = buildThreeMaterial(materialDef);
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
              }
            }}
            castShadow
            receiveShadow
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

      {csgMeshes.map((item) => {
        if (!item.geometry) {
          return null;
        }
        const groupNode = data.project.nodes[item.groupId];
        const materialDef = groupNode?.materialId ? data.project.materials[groupNode.materialId] : undefined;
        const material = buildThreeMaterial(materialDef);
        const isSelected = selection.includes(item.groupId);
        const isHovered = hoveredNodeId === item.groupId;
        material.emissive?.set(isSelected ? "#2f4d72" : isHovered ? "#23364f" : "#000000");
        return (
          <mesh
            key={item.groupId}
            castShadow
            receiveShadow
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
  return (
    <div className="canvas-root">
      <Canvas camera={{ position: [80, 80, 80], fov: 45 }} shadows>
        <SceneContent />
      </Canvas>
    </div>
  );
}
