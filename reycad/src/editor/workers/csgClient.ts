import { BufferAttribute, BufferGeometry } from "three";
import { createId } from "../../lib/ids";
import type { CsgTask, CsgSolvedMesh, SerializedGeometry } from "../../engine/scenegraph/csgSolve";
import { solveBooleanTasks } from "../../engine/scenegraph/csgSolve";
import type { CsgWorkerRequest, CsgWorkerResponse } from "./csgProtocol";

let worker: Worker | null = null;

type PendingRequest = {
  resolve: (value: CsgSolvedMesh[]) => void;
  reject: (reason: unknown) => void;
};

const pending = new Map<string, PendingRequest>();
const MAX_MAIN_THREAD_FALLBACK_TASKS = 8;
const MAX_MAIN_THREAD_FALLBACK_PRIMITIVES = 120;

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./csgWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<CsgWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) {
      return;
    }
    pending.delete(event.data.id);

    if (!event.data.ok) {
      request.reject(new Error(event.data.error ?? "CSG worker failed"));
      return;
    }

    request.resolve(
      event.data.results.map((item) => ({
        groupId: item.groupId,
        sourceNodeIds: item.sourceNodeIds,
        warning: item.warning,
        diagnostics: item.diagnostics,
        geometry: deserializeGeometry(item.geometry)
      }))
    );
  };
  worker.onerror = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  return worker;
}

function deserializeGeometry(payload: SerializedGeometry | null): BufferGeometry | null {
  if (!payload) {
    return null;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(payload.position, 3));
  if (payload.normal) {
    geometry.setAttribute("normal", new BufferAttribute(payload.normal, 3));
  }
  if (payload.index) {
    geometry.setIndex(new BufferAttribute(payload.index, 1));
  }
  return geometry;
}

function buildSkippedFallbackResult(task: CsgTask, reason: string): CsgSolvedMesh {
  return {
    groupId: task.groupId,
    sourceNodeIds: task.primitives.map((item) => item.nodeId),
    geometry: null,
    warning: reason,
    diagnostics: {
      watertight: false,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      degenerateFaces: 0
    }
  };
}

function totalPrimitives(tasks: CsgTask[]): number {
  return tasks.reduce((acc, task) => acc + task.primitives.length, 0);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function solveBooleanTasksFallbackChunked(tasks: CsgTask[]): Promise<CsgSolvedMesh[]> {
  if (tasks.length > MAX_MAIN_THREAD_FALLBACK_TASKS || totalPrimitives(tasks) > MAX_MAIN_THREAD_FALLBACK_PRIMITIVES) {
    return tasks.map((task) =>
      buildSkippedFallbackResult(task, "CSG worker unavailable; skipped heavy boolean to avoid UI freeze.")
    );
  }

  const result: CsgSolvedMesh[] = [];
  for (const task of tasks) {
    result.push(...solveBooleanTasks([task]));
    await yieldToBrowser();
  }
  return result;
}

export async function executeCsgTasks(tasks: CsgTask[]): Promise<CsgSolvedMesh[]> {
  if (tasks.length === 0) {
    return [];
  }

  try {
    const instance = ensureWorker();
    const id = createId("csg_req");
    const payload: CsgWorkerRequest = {
      id,
      tasks
    };

    return await new Promise<CsgSolvedMesh[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      instance.postMessage(payload);
    });
  } catch {
    // Keep UI responsive: fallback only for small batches, otherwise skip with warnings.
    return solveBooleanTasksFallbackChunked(tasks);
  }
}
