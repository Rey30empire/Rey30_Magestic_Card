import { useCallback, useRef } from "react";
import { DockviewReadyEvent, DockviewReact } from "dockview";
import "dockview/dist/styles/dockview.css";
import ScenePanel from "../ui/panels/ScenePanel";
import InspectorPanel from "../ui/panels/InspectorPanel";
import AssetsPanel from "../ui/panels/AssetsPanel";
import ExportPanel from "../ui/panels/ExportPanel";
import ConsolePanel from "../ui/panels/ConsolePanel";
import AiPanel from "../ui/panels/AiPanel";
import PythonConsolePanel from "../ui/panels/PythonConsolePanel";
import VersionPanel from "../ui/panels/VersionPanel";
import MaterialLabPanel from "../ui/panels/MaterialLabPanel";
import PerformancePanel from "../ui/panels/PerformancePanel";
import Canvas3D from "../engine/rendering/Canvas3D";
import { useEditorStore } from "../editor/state/editorStore";
import engineApi from "../engine/api/engineApi";

const LAYOUT_KEY = "reycad.layout.v5";
const DEFAULT_PLAY_SESSION_MS = 10 * 60 * 1000;

const panelComponents = {
  canvas: () => <Canvas3D />,
  scene: () => <ScenePanel />,
  inspector: () => <InspectorPanel />,
  assets: () => <AssetsPanel />,
  export: () => <ExportPanel />,
  console: () => <ConsolePanel />,
  ai: () => <AiPanel />,
  python: () => <PythonConsolePanel />,
  versions: () => <VersionPanel />,
  materiallab: () => <MaterialLabPanel />,
  performance: () => <PerformancePanel />
};

function seedDefaultLayout(event: DockviewReadyEvent): void {
  event.api.clear();
  const canvas = event.api.addPanel({
    id: "panel_canvas",
    component: "canvas",
    title: "Viewport"
  });

  event.api.addPanel({
    id: "panel_assets",
    component: "assets",
    title: "Assets",
    position: {
      referencePanel: canvas,
      direction: "left"
    }
  });

  event.api.addPanel({
    id: "panel_scene",
    component: "scene",
    title: "Scene",
    position: {
      referencePanel: canvas,
      direction: "left"
    }
  });

  event.api.addPanel({
    id: "panel_inspector",
    component: "inspector",
    title: "Inspector",
    position: {
      referencePanel: canvas,
      direction: "right"
    }
  });

  event.api.addPanel({
    id: "panel_materiallab",
    component: "materiallab",
    title: "MaterialLab",
    position: {
      referencePanel: "panel_inspector",
      direction: "within"
    }
  });

  event.api.addPanel({
    id: "panel_console",
    component: "console",
    title: "Console",
    position: {
      referencePanel: canvas,
      direction: "below"
    }
  });

  event.api.addPanel({
    id: "panel_export",
    component: "export",
    title: "Export",
    position: {
      referencePanel: "panel_console",
      direction: "within"
    }
  });

  event.api.addPanel({
    id: "panel_ai",
    component: "ai",
    title: "AI Builder",
    position: {
      referencePanel: "panel_console",
      direction: "within"
    }
  });

  event.api.addPanel({
    id: "panel_python",
    component: "python",
    title: "Python",
    position: {
      referencePanel: "panel_console",
      direction: "within"
    }
  });

  event.api.addPanel({
    id: "panel_versions",
    component: "versions",
    title: "Versions",
    position: {
      referencePanel: "panel_console",
      direction: "within"
    }
  });

  event.api.addPanel({
    id: "panel_performance",
    component: "performance",
    title: "Performance",
    position: {
      referencePanel: "panel_console",
      direction: "within"
    }
  });
}

function seedModelingLayout(event: DockviewReadyEvent): void {
  event.api.clear();
  const canvas = event.api.addPanel({ id: "panel_canvas", component: "canvas", title: "Viewport" });
  event.api.addPanel({
    id: "panel_assets",
    component: "assets",
    title: "Assets",
    position: { referencePanel: canvas, direction: "left" }
  });
  event.api.addPanel({
    id: "panel_inspector",
    component: "inspector",
    title: "Inspector",
    position: { referencePanel: canvas, direction: "right" }
  });
  event.api.addPanel({
    id: "panel_scene",
    component: "scene",
    title: "Scene",
    position: { referencePanel: "panel_assets", direction: "within" }
  });
  event.api.addPanel({
    id: "panel_materiallab",
    component: "materiallab",
    title: "MaterialLab",
    position: { referencePanel: "panel_inspector", direction: "within" }
  });
  event.api.addPanel({
    id: "panel_performance",
    component: "performance",
    title: "Performance",
    position: { referencePanel: "panel_inspector", direction: "within" }
  });
}

function seedAiLayout(event: DockviewReadyEvent): void {
  event.api.clear();
  const canvas = event.api.addPanel({ id: "panel_canvas", component: "canvas", title: "Viewport" });
  event.api.addPanel({
    id: "panel_ai",
    component: "ai",
    title: "AI Builder",
    position: { referencePanel: canvas, direction: "right" }
  });
  event.api.addPanel({
    id: "panel_assets",
    component: "assets",
    title: "Assets",
    position: { referencePanel: canvas, direction: "left" }
  });
  event.api.addPanel({
    id: "panel_materiallab",
    component: "materiallab",
    title: "MaterialLab",
    position: { referencePanel: "panel_ai", direction: "within" }
  });
  event.api.addPanel({
    id: "panel_console",
    component: "console",
    title: "Console",
    position: { referencePanel: canvas, direction: "below" }
  });
  event.api.addPanel({
    id: "panel_performance",
    component: "performance",
    title: "Performance",
    position: { referencePanel: "panel_console", direction: "within" }
  });
}

function seedScriptingLayout(event: DockviewReadyEvent): void {
  event.api.clear();
  const canvas = event.api.addPanel({ id: "panel_canvas", component: "canvas", title: "Viewport" });
  event.api.addPanel({
    id: "panel_python",
    component: "python",
    title: "Python",
    position: { referencePanel: canvas, direction: "right" }
  });
  event.api.addPanel({
    id: "panel_console",
    component: "console",
    title: "Console",
    position: { referencePanel: canvas, direction: "below" }
  });
  event.api.addPanel({
    id: "panel_performance",
    component: "performance",
    title: "Performance",
    position: { referencePanel: "panel_console", direction: "within" }
  });
}

function seedMinimalLayout(event: DockviewReadyEvent): void {
  event.api.clear();
  event.api.addPanel({ id: "panel_canvas", component: "canvas", title: "Viewport" });
}

export default function AppShell(): JSX.Element {
  const apiRef = useRef<DockviewReadyEvent | null>(null);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const isPlaying = useEditorStore((state) => state.play.isPlaying);
  const playSessionId = useEditorStore((state) => state.play.sessionId);
  const playBlockedCommands = useEditorStore((state) => state.play.blockedCommands);
  const lastStopReason = useEditorStore((state) => state.play.lastStopReason);
  const startPlaySession = useEditorStore((state) => state.startPlaySession);
  const stopPlaySession = useEditorStore((state) => state.stopPlaySession);
  const panicStopPlaySession = useEditorStore((state) => state.panicStopPlaySession);
  const hardResetPlaySession = useEditorStore((state) => state.hardResetPlaySession);
  const playPillClass = isPlaying ? "warn" : lastStopReason === "panic" ? "bad" : "ok";
  const playReasonLabel = isPlaying ? "playing" : lastStopReason ?? "idle";

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event;
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored) {
      try {
        event.api.fromJSON(JSON.parse(stored));
      } catch {
        seedDefaultLayout(event);
      }
    } else {
      seedDefaultLayout(event);
    }

    event.api.onDidLayoutChange(() => {
      const snapshot = event.api.toJSON();
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(snapshot));
    });
  }, []);

  const resetLayout = useCallback(() => {
    if (!apiRef.current) {
      return;
    }
    localStorage.removeItem(LAYOUT_KEY);
    seedDefaultLayout(apiRef.current);
  }, []);

  return (
    <div className="shell-root">
      <div className="toolbar">
        <button
          className="btn"
          disabled={isPlaying}
          onClick={() => {
            if (window.history.length > 1) {
              window.history.back();
              return;
            }
            window.location.href = "/app";
          }}
          type="button"
        >
          ← Back
        </button>
        <button className="btn" disabled={isPlaying} onClick={() => undo()} type="button">
          ↶ Undo
        </button>
        <button className="btn" disabled={isPlaying} onClick={() => redo()} type="button">
          ↷ Redo
        </button>
        <strong>PIE</strong>
        <button className="btn btn-primary" disabled={isPlaying} onClick={() => startPlaySession(DEFAULT_PLAY_SESSION_MS)} type="button">
          ▶ Play
        </button>
        <button className="btn" disabled={!isPlaying} onClick={() => stopPlaySession("user_stop")} type="button">
          ■ Stop
        </button>
        <button className="btn btn-danger" disabled={!isPlaying} onClick={() => panicStopPlaySession()} type="button">
          Panic
        </button>
        <button className="btn" disabled={!isPlaying} onClick={() => hardResetPlaySession()} type="button">
          Hard Reset
        </button>
        <span className={`pill ${playPillClass}`}>{playReasonLabel}</span>
        {playSessionId && <span className="mono">session {playSessionId}</span>}
        {playBlockedCommands > 0 && <span className="warning">blocked actions: {playBlockedCommands}</span>}
        <strong>ReyCAD Presets</strong>
        <button className="btn" onClick={() => apiRef.current && seedModelingLayout(apiRef.current)} type="button">
          Modeling
        </button>
        <button className="btn" onClick={() => apiRef.current && seedAiLayout(apiRef.current)} type="button">
          AI Builder
        </button>
        <button className="btn" onClick={() => apiRef.current && seedScriptingLayout(apiRef.current)} type="button">
          Scripting
        </button>
        <button className="btn" onClick={() => apiRef.current && seedMinimalLayout(apiRef.current)} type="button">
          Minimal
        </button>
        <button className="btn" onClick={resetLayout} type="button">
          Reset Layout
        </button>
        <strong>Quick Tools</strong>
        <button className="btn" disabled={isPlaying} onClick={() => engineApi.createPrimitive("box")} type="button">
          + Box
        </button>
        <button className="btn" disabled={isPlaying} onClick={() => engineApi.createPrimitive("cylinder")} type="button">
          + Cylinder
        </button>
        <button className="btn" disabled={isPlaying} onClick={() => engineApi.createPrimitive("text")} type="button">
          + Text
        </button>
        <button className="btn" disabled={isPlaying} onClick={() => engineApi.createPrimitive("terrain")} type="button">
          + Terrain
        </button>
      </div>
      <DockviewReact className="dockview-theme-abyss shell-dock" components={panelComponents} onReady={onReady} />
    </div>
  );
}
