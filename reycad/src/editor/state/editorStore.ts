import { create } from "zustand";
import { createProject } from "../../engine/scenegraph/factory";
import type { Project, Transform } from "../../engine/scenegraph/types";
import type { GizmoMode } from "../../engine/interaction/gizmo";
import type { Command } from "../commands/types";
import { createEmptyAiHistory } from "./types";
import type { EditorAiHistory, EditorData } from "./types";
import { saveProjectAutosave } from "../persistence/storage";
import { PlaySessionManager, type PlayStopReason, type PlaySessionState } from "../runtime/playSessionManager";

type EditorStore = {
  data: EditorData;
  play: PlaySessionState & { lastStopReason: PlayStopReason | null };
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
  startPlaySession: (maxDurationMs?: number) => boolean;
  stopPlaySession: (reason?: PlayStopReason) => boolean;
  panicStopPlaySession: () => boolean;
  hardResetPlaySession: () => boolean;
  tickPlaySession: () => void;
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

function isDestructiveEditorCommand(command: Command): boolean {
  const name = command.name.trim().toLowerCase();
  return (
    name.startsWith("delete ") ||
    name.startsWith("group ") ||
    name === "ungroup" ||
    name.startsWith("add boolean") ||
    name.startsWith("remove boolean")
  );
}

const playSessionManager = new PlaySessionManager();

export const useEditorStore = create<EditorStore>((set, get) => ({
  data: defaultData(),
  play: {
    ...playSessionManager.getState(),
    lastStopReason: null
  },
  toolMode: "translate",
  hoveredNodeId: null,
  frameRequestIds: [],
  frameRequestToken: 0,
  undoStack: [],
  redoStack: [],
  executeCommand: (command) => {
    const state = get();
    if (state.play.isPlaying && isDestructiveEditorCommand(command)) {
      const blockedCommands = playSessionManager.incrementBlockedCommands();
      set((current) => ({
        data: {
          ...current.data,
          logs: [...current.data.logs, `[play] blocked command ${command.name} (not allowed while Play is active)`]
        },
        play: {
          ...current.play,
          blockedCommands
        }
      }));
      return;
    }

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
    set(() => {
      playSessionManager.reset();
      return {
        data: {
          project,
          selection: [],
          logs: ["Project loaded"],
          aiHistory: aiHistory ?? createEmptyAiHistory()
        },
        play: {
          ...playSessionManager.getState(),
          lastStopReason: "project_reload"
        },
        undoStack: [],
        redoStack: []
      };
    }),
  startPlaySession: (maxDurationMs) => {
    const state = get();
    const started = playSessionManager.start(state.data, maxDurationMs);
    if (!started) {
      return false;
    }
    set({
      data: started.playData,
      play: {
        ...playSessionManager.getState(),
        lastStopReason: null
      },
      hoveredNodeId: null,
      frameRequestIds: [],
      frameRequestToken: state.frameRequestToken + 1
    });
    return true;
  },
  stopPlaySession: (reason = "user_stop") => {
    const stopped = playSessionManager.stop(reason);
    if (!stopped) {
      return false;
    }
    persistAutosave(stopped.restoredData);
    set((state) => ({
      data: stopped.restoredData,
      play: {
        ...playSessionManager.getState(),
        lastStopReason: reason
      },
      hoveredNodeId: null,
      frameRequestIds: [],
      frameRequestToken: state.frameRequestToken + 1
    }));
    return true;
  },
  panicStopPlaySession: () => get().stopPlaySession("panic"),
  hardResetPlaySession: () => {
    const resetData = playSessionManager.hardResetScene();
    if (!resetData) {
      return false;
    }
    set((state) => ({
      data: resetData,
      play: {
        ...playSessionManager.getState(),
        lastStopReason: null
      },
      hoveredNodeId: null,
      frameRequestIds: [],
      frameRequestToken: state.frameRequestToken + 1
    }));
    return true;
  },
  tickPlaySession: () => {
    const state = get();
    if (!state.play.isPlaying) {
      return;
    }
    const tick = playSessionManager.tick();
    if (tick.shouldAutoStop) {
      get().stopPlaySession("max_duration");
      return;
    }
    set((current) => ({
      play: {
        ...current.play,
        elapsedMs: tick.elapsedMs
      }
    }));
  }
}));
