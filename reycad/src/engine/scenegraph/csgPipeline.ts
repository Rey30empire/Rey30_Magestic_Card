import type { Node, Project } from "./types";

export type CsgWarning = {
  nodeId: string;
  message: string;
};

export type CsgResult = {
  resolvedNodeIds: string[];
  warnings: CsgWarning[];
};

export function evaluateCsgPipeline(_project: Project, nodes: Node[]): CsgResult {
  const warnings: CsgWarning[] = [];
  const hasPotentialBoolean = nodes.some((node) => node.type === "group" && (node.ops?.length ?? 0) > 0);

  if (hasPotentialBoolean) {
    // Boolean tasks are handled by worker-enabled CSG solver in canvas/export path.
  }

  return {
    resolvedNodeIds: nodes.map((node) => node.id),
    warnings
  };
}
