import type { CsgTask, SerializedCsgSolvedMesh } from "../../engine/scenegraph/csgSolve";

export type CsgWorkerRequest = {
  id: string;
  tasks: CsgTask[];
};

export type CsgWorkerResponse = {
  id: string;
  ok: boolean;
  results: SerializedCsgSolvedMesh[];
  error?: string;
};
