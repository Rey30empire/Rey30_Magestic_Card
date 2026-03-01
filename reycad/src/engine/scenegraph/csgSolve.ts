import { BufferGeometry } from "three";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import type { BooleanOp } from "./types";
import type { RenderPrimitive } from "./evaluator";
import { buildGeometryFromPrimitive } from "../rendering/geometry";

export type CsgTask = {
  groupId: string;
  primitives: RenderPrimitive[];
  ops: BooleanOp[];
};

export type CsgSolvedMesh = {
  groupId: string;
  sourceNodeIds: string[];
  geometry: BufferGeometry | null;
  warning?: string;
  diagnostics?: {
    watertight: boolean;
    boundaryEdges: number;
    nonManifoldEdges: number;
    degenerateFaces: number;
  };
};

function opCode(op: BooleanOp["op"]) {
  if (op === "union") {
    return ADDITION;
  }
  if (op === "intersect") {
    return INTERSECTION;
  }
  return SUBTRACTION;
}

function buildBrush(item: RenderPrimitive): Brush {
  const geometry = buildGeometryFromPrimitive(item);
  const brush = new Brush(geometry);
  brush.position.set(...item.transform.position);
  brush.rotation.set(...item.transform.rotation);
  brush.scale.set(...item.transform.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

function solveSingleTask(task: CsgTask): CsgSolvedMesh {
  const evaluator = new Evaluator();
  const solids = task.primitives.filter((item) => item.mode !== "hole");
  const holes = task.primitives.filter((item) => item.mode === "hole");

  if (solids.length === 0) {
    return {
      groupId: task.groupId,
      sourceNodeIds: task.primitives.map((item) => item.nodeId),
      geometry: null,
      warning: "No solid primitives available for boolean solve."
    };
  }

  const brushes = new Map<string, Brush>();
  for (const primitive of task.primitives) {
    brushes.set(primitive.nodeId, buildBrush(primitive));
  }

  let result: Brush = brushes.get(solids[0].nodeId)!;

  for (let index = 1; index < solids.length; index += 1) {
    const brush = brushes.get(solids[index].nodeId);
    if (!brush) {
      continue;
    }
    result = evaluator.evaluate(result, brush, ADDITION);
  }

  for (const hole of holes) {
    const holeBrush = brushes.get(hole.nodeId);
    if (!holeBrush) {
      continue;
    }
    result = evaluator.evaluate(result, holeBrush, SUBTRACTION);
  }

  for (const op of task.ops) {
    const right = brushes.get(op.b);
    if (!right) {
      continue;
    }
    result = evaluator.evaluate(result, right, opCode(op.op));
  }

  const geometry = result.geometry.clone();
  geometry.computeVertexNormals();
  const diagnostics = validateWatertightGeometry(geometry);

  const warnings: string[] = [];
  if (!diagnostics.watertight) {
    warnings.push(
      `Geometry may be non-manifold (boundaryEdges=${diagnostics.boundaryEdges}, nonManifoldEdges=${diagnostics.nonManifoldEdges}, degenerateFaces=${diagnostics.degenerateFaces})`
    );
  }

  return {
    groupId: task.groupId,
    sourceNodeIds: task.primitives.map((item) => item.nodeId),
    geometry,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
    diagnostics
  };
}

export function solveBooleanTasks(tasks: CsgTask[]): CsgSolvedMesh[] {
  const out: CsgSolvedMesh[] = [];
  for (const task of tasks) {
    try {
      out.push(solveSingleTask(task));
    } catch (error) {
      out.push({
        groupId: task.groupId,
        sourceNodeIds: task.primitives.map((item) => item.nodeId),
        geometry: null,
        warning: `CSG solve error: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics: {
          watertight: false,
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          degenerateFaces: 0
        }
      });
    }
  }
  return out;
}

function validateWatertightGeometry(geometry: BufferGeometry): {
  watertight: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  degenerateFaces: number;
} {
  const positionAttr = geometry.getAttribute("position");
  if (!positionAttr) {
    return {
      watertight: false,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      degenerateFaces: 0
    };
  }

  const indices = geometry.getIndex()?.array;
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(positionAttr.count / 3);
  const edgeUse = new Map<string, number>();
  let degenerateFaces = 0;

  function edgeKey(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  function countEdge(a: number, b: number): void {
    const key = edgeKey(a, b);
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  }

  for (let face = 0; face < triangleCount; face += 1) {
    const i0 = indices ? Number(indices[face * 3]) : face * 3;
    const i1 = indices ? Number(indices[face * 3 + 1]) : face * 3 + 1;
    const i2 = indices ? Number(indices[face * 3 + 2]) : face * 3 + 2;

    if (i0 === i1 || i1 === i2 || i0 === i2) {
      degenerateFaces += 1;
      continue;
    }

    countEdge(i0, i1);
    countEdge(i1, i2);
    countEdge(i2, i0);
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const useCount of edgeUse.values()) {
    if (useCount === 1) {
      boundaryEdges += 1;
    } else if (useCount > 2) {
      nonManifoldEdges += 1;
    }
  }

  return {
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && degenerateFaces === 0,
    boundaryEdges,
    nonManifoldEdges,
    degenerateFaces
  };
}

export type SerializedGeometry = {
  position: Float32Array;
  normal?: Float32Array;
  index?: Uint32Array | Uint16Array;
};

export type SerializedCsgSolvedMesh = {
  groupId: string;
  sourceNodeIds: string[];
  geometry: SerializedGeometry | null;
  warning?: string;
  diagnostics?: {
    watertight: boolean;
    boundaryEdges: number;
    nonManifoldEdges: number;
    degenerateFaces: number;
  };
};

export function serializeGeometry(geometry: BufferGeometry | null): SerializedGeometry | null {
  if (!geometry) {
    return null;
  }

  const positionAttr = geometry.getAttribute("position");
  if (!positionAttr) {
    return null;
  }

  const normalAttr = geometry.getAttribute("normal");
  const indexAttr = geometry.getIndex();

  const serialized: SerializedGeometry = {
    position: new Float32Array(positionAttr.array as ArrayLike<number>)
  };

  if (normalAttr) {
    serialized.normal = new Float32Array(normalAttr.array as ArrayLike<number>);
  }

  if (indexAttr) {
    const indexArray = indexAttr.array as Uint16Array | Uint32Array;
    serialized.index = indexArray instanceof Uint32Array ? new Uint32Array(indexArray) : new Uint16Array(indexArray);
  }

  return serialized;
}
