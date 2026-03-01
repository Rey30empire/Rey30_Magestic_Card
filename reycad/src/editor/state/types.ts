import type { Project } from "../../engine/scenegraph/types";

export type AiHistoryBlock = {
  id: string;
  label: string;
  undoSteps: number;
  beforeDepth: number;
  afterDepth: number;
  topCommandId: string | null;
  redoTopCommandId: string | null;
  createdAt: string;
};

export type EditorAiHistory = {
  undoBlocks: AiHistoryBlock[];
  redoBlocks: AiHistoryBlock[];
};

export type EditorData = {
  project: Project;
  selection: string[];
  logs: string[];
  aiHistory: EditorAiHistory;
};

export function createEmptyAiHistory(): EditorAiHistory {
  return {
    undoBlocks: [],
    redoBlocks: []
  };
}
