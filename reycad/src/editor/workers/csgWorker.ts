import { serializeGeometry, solveBooleanTasks, type SerializedCsgSolvedMesh } from "../../engine/scenegraph/csgSolve";
import type { CsgWorkerRequest, CsgWorkerResponse } from "./csgProtocol";

function toTransferableBuffer(buffer: ArrayBufferLike): ArrayBuffer | null {
  return buffer instanceof ArrayBuffer ? buffer : null;
}

function collectTransferables(results: SerializedCsgSolvedMesh[]): Transferable[] {
  const transferables: Transferable[] = [];
  for (const result of results) {
    if (!result.geometry) {
      continue;
    }
    const positionBuffer = toTransferableBuffer(result.geometry.position.buffer);
    if (positionBuffer) {
      transferables.push(positionBuffer);
    }
    if (result.geometry.normal) {
      const normalBuffer = toTransferableBuffer(result.geometry.normal.buffer);
      if (normalBuffer) {
        transferables.push(normalBuffer);
      }
    }
    if (result.geometry.index) {
      const indexBuffer = toTransferableBuffer(result.geometry.index.buffer);
      if (indexBuffer) {
        transferables.push(indexBuffer);
      }
    }
  }
  return transferables;
}

const workerScope = self as unknown as {
  postMessage: (message: CsgWorkerResponse, transfer?: Transferable[]) => void;
};

self.onmessage = (event: MessageEvent<CsgWorkerRequest>) => {
  try {
    const solved = solveBooleanTasks(event.data.tasks);
    const serialized = solved.map((item) => ({
      groupId: item.groupId,
      sourceNodeIds: item.sourceNodeIds,
      warning: item.warning,
      diagnostics: item.diagnostics,
      geometry: serializeGeometry(item.geometry)
    }));

    const response: CsgWorkerResponse = {
      id: event.data.id,
      ok: true,
      results: serialized
    };

    workerScope.postMessage(response, collectTransferables(serialized));
  } catch (error) {
    const response: CsgWorkerResponse = {
      id: event.data.id,
      ok: false,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    };
    workerScope.postMessage(response);
  }
};
