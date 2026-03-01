import { serializeGeometry, solveBooleanTasks, type SerializedCsgSolvedMesh } from "../../engine/scenegraph/csgSolve";
import type { CsgWorkerRequest, CsgWorkerResponse } from "./csgProtocol";

function collectTransferables(results: SerializedCsgSolvedMesh[]): ArrayBuffer[] {
  const transferables: ArrayBuffer[] = [];
  for (const result of results) {
    if (!result.geometry) {
      continue;
    }
    transferables.push(result.geometry.position.buffer);
    if (result.geometry.normal) {
      transferables.push(result.geometry.normal.buffer);
    }
    if (result.geometry.index) {
      transferables.push(result.geometry.index.buffer);
    }
  }
  return transferables;
}

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

    self.postMessage(response, collectTransferables(serialized));
  } catch (error) {
    const response: CsgWorkerResponse = {
      id: event.data.id,
      ok: false,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    };
    self.postMessage(response);
  }
};
