import { create } from "zustand";
import { createProject } from "../../engine/scenegraph/factory";
import type { Project, Transform } from "../../engine/scenegraph/types";
import type { GizmoMode } from "../../engine/interaction/gizmo";
import type { Command } from "../commands/types";
import { createEmptyAiHistory } from "./types";
import type { EditorAiHistory, EditorData } from "./types";
import { saveProjectAutosave } from "../persistence/storage";

type EditorStore = {
  data: EditorData;
  toolMode: GizmoMode;
  hoveredNodeId: string | null;
  frameRequestIds: string[];
  frameRequestToken: number;
  undoStack: Command[];
  redoStack: Command[];
  executeCommand: (command: Command) => void;
  undo: () => void;
  undoSteps: (count: number) => number;
  redo: () => void;
  redoSteps: (count: number) => number;
  setAiHistory: (history: EditorAiHistory) => void;
  setSelection: (selection: string[]) => void;
  setToolMode: (mode: GizmoMode) => void;
  setHoveredNodeId: (nodeId: string | null) => void;
  requestFrameSelection: (nodeIds: string[]) => void;
  setGrid: (partial: Partial<Project["grid"]>) => void;
  updateTransformDirect: (nodeId: string, transform: Transform) => void;
  addLog: (message: string) => void;
  loadProject: (project: Project, aiHistory?: EditorAiHistory) => void;
};

function defaultData(): EditorData {
  return {
    project: createProject(),
    selection: [],
    logs: ["ReyCAD ready"],
    aiHistory: createEmptyAiHistory()
  };
}

function persistAutosave(data: EditorData): void {
  saveProjectAutosave(data.project, data.aiHistory).catch(() => {
    // Ignore autosave failures.
  });
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  data: defaultData(),
  toolMode: "translate",
  hoveredNodeId: null,
  frameRequestIds: [],
  frameRequestToken: 0,
  undoStack: [],
  redoStack: [],
  executeCommand: (command) => {
    const state = get();
    const nextData = command.do(state.data);
    persistAutosave(nextData);
    set({
      data: { ...nextData, logs: [...nextData.logs, `[cmd] ${command.name}`] },
      undoStack: [...state.undoStack, command],
      redoStack: []
    });
  },
  undo: () => {
    const state = get();
    const command = state.undoStack[state.undoStack.length - 1];
    if (!command) {
      return;
    }
    const nextData = command.undo(state.data);
    persistAutosave(nextData);
    set({
      data: { ...nextData, logs: [...nextData.logs, `[undo] ${command.name}`] },
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [command, ...state.redoStack]
    });
  },
  undoSteps: (count) => {
    const steps = Math.max(0, Math.floor(count));
    if (steps <= 0) {
      return 0;
    }

    let applied = 0;
    for (let index = 0; index < steps; index += 1) {
      const state = get();
      const command = state.undoStack[state.undoStack.length - 1];
      if (!command) {
        break;
      }

      const nextData = command.undo(state.data);
      persistAutosave(nextData);
      set({
        data: { ...nextData, logs: [...nextData.logs, `[undo] ${command.name}`] },
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [command, ...state.redoStack]
      });
      applied += 1;
    }

    return applied;
  },
  redo: () => {
    const state = get();
    const command = state.redoStack[0];
    if (!command) {
      return;
    }
    const nextData = command.do(state.data);
    persistAutosave(nextData);
    set({
      data: { ...nextData, logs: [...nextData.logs, `[redo] ${command.name}`] },
      undoStack: [...state.undoStack, command],
      redoStack: state.redoStack.slice(1)
    });
  },
  redoSteps: (count) => {
    const steps = Math.max(0, Math.floor(count));
    if (steps <= 0) {
      return 0;
    }

    let applied = 0;
    for (let index = 0; index < steps; index += 1) {
      const state = get();
      const command = state.redoStack[0];
      if (!command) {
        break;
      }

      const nextData = command.do(state.data);
      persistAutosave(nextData);
      set({
        data: { ...nextData, logs: [...nextData.logs, `[redo] ${command.name}`] },
        undoStack: [...state.undoStack, command],
        redoStack: state.redoStack.slice(1)
      });
      applied += 1;
    }

    return applied;
  },
  setAiHistory: (history) =>
    set((state) => {
      const nextData: EditorData = {
        ...state.data,
        aiHistory: history
      };
      persistAutosave(nextData);
      return {
        data: nextData
      };
    }),
  setSelection: (selection) =>
    set((state) => ({
      data: {
        ...state.data,
        selection
      }
    })),
  setToolMode: (mode) => set({ toolMode: mode }),
  setHoveredNodeId: (nodeId) => set({ hoveredNodeId: nodeId }),
  requestFrameSelection: (nodeIds) =>
    set((state) => ({
      frameRequestIds: [...nodeIds],
      frameRequestToken: state.frameRequestToken + 1
    })),
  setGrid: (partial) =>
    set((state) => ({
      data: {
        ...state.data,
        project: {
          ...state.data.project,
          grid: {
            ...state.data.project.grid,
            ...partial
          }
        }
      }
    })),
  updateTransformDirect: (nodeId, transform) =>
    set((state) => {
      const node = state.data.project.nodes[nodeId];
      if (!node) {
        return state;
      }
      return {
        data: {
          ...state.data,
          project: {
            ...state.data.project,
            nodes: {
              ...state.data.project.nodes,
              [nodeId]: {
                ...node,
                transform
              }
            }
          }
        }
      };
    }),
  addLog: (message) =>
    set((state) => ({
      data: {
        ...state.data,
        logs: [...state.data.logs, message]
      }
    })),
  loadProject: (project, aiHistory) =>
    set(() => ({
      data: {
        project,
        selection: [],
        logs: ["Project loaded"],
        aiHistory: aiHistory ?? createEmptyAiHistory()
      },
      undoStack: [],
      redoStack: []
    }))
}));
