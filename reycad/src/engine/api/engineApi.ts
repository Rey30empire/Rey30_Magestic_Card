import { Group, Mesh, Scene } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { createPrimitiveNode } from "../scenegraph/factory";
import type { BooleanOp, MaterialDef, PrimitiveType, Project, Transform } from "../scenegraph/types";
import { useEditorStore } from "../../editor/state/editorStore";
import {
  addNodeCommand,
  deleteNodesCommand,
  removeMaterialCommand,
  setGridCommand,
  setMaterialCommand,
  toggleHoleCommand,
  upsertMaterialCommand,
  updateParamsCommand,
  updateTransformCommand
} from "../../editor/commands/basicCommands";
import { addBooleanOpCommand, duplicateCommand, groupCommand, removeBooleanOpCommand, ungroupCommand } from "../../editor/commands/advancedCommands";
import { evaluateProject } from "../scenegraph/evaluator";
import { buildGeometryFromPrimitive } from "../rendering/geometry";
import { solveBooleanTasks } from "../scenegraph/csgSolve";
import templates from "../../assets/templates/templates.json";
import { createId } from "../../lib/ids";

export interface EngineAPI {
  createPrimitive: (type: PrimitiveType, params?: Partial<Record<string, unknown>>, transform?: Partial<Transform>, materialId?: string) => string;
  createGroup: (childrenIds: string[], mode: "solid" | "hole" | "mixed") => string;
  setNodeTransform: (nodeId: string, transformPatch: Partial<Transform>) => void;
  setNodeParams: (nodeId: string, paramsPatch: Record<string, unknown>) => void;
  setNodeMaterial: (nodeId: string, materialId?: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  duplicateNodes: (nodeIds: string[]) => string[];
  group: (nodeIds: string[]) => string;
  ungroup: (groupId: string) => string[];
  toggleHole: (nodeId: string) => void;
  addBooleanOp: (op: "union" | "subtract" | "intersect", aId: string, bId: string) => string;
  removeBooleanOp: (opId: string, groupId: string) => void;
  insertTemplate: (templateId: string, targetParentId?: string) => string[];
  frameSelection: (nodeIds: string[]) => void;
  exportSTL: (selectionIds?: string[]) => Promise<Blob>;
  exportGLB: (selectionIds?: string[]) => Promise<Blob>;
  getSelection: () => string[];
  setSelection: (ids: string[]) => void;
  setGrid: (patch: Partial<Project["grid"]>) => void;
  createMaterial: (kind: MaterialDef["kind"], seed?: Partial<MaterialDef>) => string;
  updateMaterial: (materialId: string, patch: Partial<MaterialDef>) => void;
  deleteMaterial: (materialId: string, fallbackMaterialId?: string) => void;
  getProjectSnapshot: () => Project;
  listTemplates: () => Array<{ id: string; name: string; tags: string[] }>;
  listMaterials: () => Array<{ id: string; name: string; kind: MaterialDef["kind"]; color?: string; pbr?: MaterialDef["pbr"] }>;
}

function patchTransform(base: Transform, patch: Partial<Transform>): Transform {
  return {
    position: patch.position ?? base.position,
    rotation: patch.rotation ?? base.rotation,
    scale: patch.scale ?? base.scale
  };
}

function buildExportScene(selectionIds?: string[]): Scene {
  const state = useEditorStore.getState();
  const scene = new Scene();
  const evaluated = evaluateProject(state.data.project);
  const items = selectionIds && selectionIds.length > 0 ? evaluated.items.filter((item) => selectionIds.includes(item.nodeId)) : evaluated.items;
  for (const item of items) {
    const geometry = buildGeometryFromPrimitive(item);
    const materialDef = state.data.project.materials[item.materialId ?? ""];
    const color = materialDef?.color ?? materialDef?.pbr?.baseColor ?? "#aaaaaa";
    const mesh = new Mesh(geometry);
    mesh.position.set(...item.transform.position);
    mesh.rotation.set(...item.transform.rotation);
    mesh.scale.set(...item.transform.scale);
    mesh.name = item.nodeId;
    mesh.userData.color = color;
    scene.add(mesh);
  }

  const csgTasks =
    selectionIds && selectionIds.length > 0
      ? evaluated.booleanTasks.filter((task) => selectionIds.includes(task.groupId))
      : evaluated.booleanTasks;
  const solved = solveBooleanTasks(csgTasks);
  for (const result of solved) {
    if (!result.geometry) {
      continue;
    }
    const groupNode = state.data.project.nodes[result.groupId];
    const materialDef = groupNode?.materialId ? state.data.project.materials[groupNode.materialId] : undefined;
    const color = materialDef?.color ?? materialDef?.pbr?.baseColor ?? "#a9adb3";
    const mesh = new Mesh(result.geometry);
    mesh.name = result.groupId;
    mesh.userData.color = color;
    scene.add(mesh);
  }
  return scene;
}

function cloneMaterial(material: MaterialDef): MaterialDef {
  return JSON.parse(JSON.stringify(material)) as MaterialDef;
}

function createMaterialName(kind: MaterialDef["kind"], currentCount: number): string {
  return kind === "solidColor" ? `Solid ${currentCount + 1}` : `PBR ${currentCount + 1}`;
}

export const engineApi: EngineAPI = {
  createPrimitive(type, params, transform, materialId) {
    const state = useEditorStore.getState();
    const node = createPrimitiveNode(type);
    node.materialId = materialId;
    if (params) {
      node.params = {
        ...node.params,
        ...params
      } as never;
    }
    if (transform) {
      node.transform = patchTransform(node.transform, transform);
    }

    state.executeCommand(addNodeCommand(node, state.data.project.rootId));
    return node.id;
  },

  createGroup(childrenIds, mode) {
    useEditorStore.getState().executeCommand(groupCommand(childrenIds, mode));
    return useEditorStore.getState().data.selection[0] ?? "";
  },

  setNodeTransform(nodeId, transformPatch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node) {
      return;
    }
    const next = patchTransform(node.transform, transformPatch);
    state.executeCommand(updateTransformCommand(nodeId, node.transform, next));
  },

  setNodeParams(nodeId, paramsPatch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type !== "primitive") {
      return;
    }
    state.executeCommand(updateParamsCommand(nodeId, node.params, { ...node.params, ...paramsPatch } as never));
  },

  setNodeMaterial(nodeId, materialId) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node) {
      return;
    }
    state.executeCommand(setMaterialCommand(nodeId, node.materialId, materialId));
  },

  deleteNodes(nodeIds) {
    if (nodeIds.length === 0) {
      return;
    }
    useEditorStore.getState().executeCommand(deleteNodesCommand(nodeIds));
  },

  duplicateNodes(nodeIds) {
    if (nodeIds.length === 0) {
      return [];
    }
    const state = useEditorStore.getState();
    state.executeCommand(duplicateCommand(nodeIds));
    return useEditorStore.getState().data.selection;
  },

  group(nodeIds) {
    useEditorStore.getState().executeCommand(groupCommand(nodeIds, "mixed"));
    return useEditorStore.getState().data.selection[0] ?? "";
  },

  ungroup(groupId) {
    const state = useEditorStore.getState();
    const groupNode = state.data.project.nodes[groupId];
    if (!groupNode || groupNode.type !== "group") {
      return [];
    }
    state.executeCommand(ungroupCommand(groupId));
    return useEditorStore.getState().data.selection;
  },

  toggleHole(nodeId) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type === "import") {
      return;
    }
    const before = node.mode ?? "solid";
    const after = before === "solid" ? "hole" : "solid";
    state.executeCommand(toggleHoleCommand(nodeId, before, after));
  },

  addBooleanOp(op, aId, bId) {
    const state = useEditorStore.getState();
    const a = state.data.project.nodes[aId];
    if (!a || !a.parentId) {
      return "";
    }
    const opId = createId("bool");
    const value: BooleanOp = { id: opId, op, a: aId, b: bId };
    state.executeCommand(addBooleanOpCommand(a.parentId, value));
    return opId;
  },

  removeBooleanOp(opId, groupId) {
    useEditorStore.getState().executeCommand(removeBooleanOpCommand(groupId, opId));
  },

  insertTemplate(templateId, targetParentId) {
    const state = useEditorStore.getState();
    const template = (templates as Array<{ id: string; node: { primitive: PrimitiveType; params: Record<string, unknown> } }>).find(
      (item) => item.id === templateId
    );
    if (!template) {
      return [];
    }
    const node = createPrimitiveNode(template.node.primitive);
    node.params = { ...node.params, ...template.node.params } as never;
    state.executeCommand(addNodeCommand(node, targetParentId ?? state.data.project.rootId));
    return [node.id];
  },

  frameSelection(nodeIds) {
    const state = useEditorStore.getState();
    state.requestFrameSelection(nodeIds);
    state.addLog(`Frame request: ${nodeIds.join(", ")}`);
  },

  async exportSTL(selectionIds) {
    const scene = buildExportScene(selectionIds);
    const exporter = new STLExporter();
    const content = exporter.parse(scene as unknown as Group, { binary: false }) as string;
    return new Blob([content], { type: "model/stl" });
  },

  async exportGLB(selectionIds) {
    const scene = buildExportScene(selectionIds);
    const exporter = new GLTFExporter();
    return await new Promise<Blob>((resolve, reject) => {
      exporter.parse(
        scene,
        (data) => {
          if (data instanceof ArrayBuffer) {
            resolve(new Blob([data], { type: "model/gltf-binary" }));
            return;
          }
          resolve(new Blob([JSON.stringify(data, null, 2)], { type: "application/gltf+json" }));
        },
        (error) => reject(error),
        {
          binary: true
        }
      );
    });
  },

  getSelection() {
    return [...useEditorStore.getState().data.selection];
  },

  setSelection(ids) {
    useEditorStore.getState().setSelection(ids);
  },

  setGrid(patch) {
    const state = useEditorStore.getState();
    const before = state.data.project.grid;
    const after: Project["grid"] = {
      size: patch.size ?? before.size,
      snap: patch.snap ?? before.snap,
      angleSnap: patch.angleSnap ?? before.angleSnap
    };
    state.executeCommand(setGridCommand(before, after));
  },

  createMaterial(kind, seed) {
    const state = useEditorStore.getState();
    const currentCount = Object.keys(state.data.project.materials).length;
    const id = createId("mat");
    const base: MaterialDef =
      kind === "solidColor"
        ? {
            id,
            name: createMaterialName(kind, currentCount),
            kind,
            color: "#cccccc"
          }
        : {
            id,
            name: createMaterialName(kind, currentCount),
            kind,
            pbr: {
              metalness: 0.2,
              roughness: 0.6,
              baseColor: "#cccccc"
            }
          };

    const next: MaterialDef = {
      ...base,
      ...seed,
      id
    };

    state.executeCommand(upsertMaterialCommand(id, undefined, next));
    return id;
  },

  updateMaterial(materialId, patch) {
    const state = useEditorStore.getState();
    const current = state.data.project.materials[materialId];
    if (!current) {
      return;
    }

    const next: MaterialDef = {
      ...cloneMaterial(current),
      ...patch,
      id: materialId,
      kind: current.kind
    };

    if (current.kind === "solidColor") {
      next.color = typeof patch.color === "string" ? patch.color : current.color ?? "#cccccc";
      delete next.pbr;
    } else {
      const currentPbr = current.pbr ?? { metalness: 0.2, roughness: 0.6, baseColor: "#cccccc" };
      const patchPbr = patch.pbr ?? {};
      next.pbr = {
        metalness: typeof patchPbr.metalness === "number" ? patchPbr.metalness : currentPbr.metalness,
        roughness: typeof patchPbr.roughness === "number" ? patchPbr.roughness : currentPbr.roughness,
        baseColor: typeof patchPbr.baseColor === "string" ? patchPbr.baseColor : currentPbr.baseColor
      };
      delete next.color;
    }

    state.executeCommand(upsertMaterialCommand(materialId, cloneMaterial(current), next));
  },

  deleteMaterial(materialId, fallbackMaterialId) {
    const state = useEditorStore.getState();
    const current = state.data.project.materials[materialId];
    if (!current) {
      return;
    }

    const materialIds = Object.keys(state.data.project.materials);
    if (materialIds.length <= 1) {
      state.addLog("[materials] at least one material must remain");
      return;
    }

    const fallback = fallbackMaterialId && fallbackMaterialId !== materialId ? fallbackMaterialId : materialIds.find((id) => id !== materialId);
    const reassignedNodes = Object.values(state.data.project.nodes)
      .filter((node) => node.materialId === materialId)
      .map((node) => node.id);

    state.executeCommand(removeMaterialCommand(materialId, cloneMaterial(current), reassignedNodes, fallback));
  },

  getProjectSnapshot() {
    return structuredClone(useEditorStore.getState().data.project);
  },

  listTemplates() {
    return (templates as Array<{ id: string; name: string; tags: string[] }>).map((item) => ({
      id: item.id,
      name: item.name,
      tags: item.tags
    }));
  },

  listMaterials() {
    const projectMaterials = Object.values(useEditorStore.getState().data.project.materials);
    return projectMaterials.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      color: item.color,
      pbr: item.pbr
    }));
  }
};

export default engineApi;
