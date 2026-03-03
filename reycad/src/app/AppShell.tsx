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
        <button className="btn" onClick={() => undo()} type="button">
          ↶ Undo
        </button>
        <button className="btn" onClick={() => redo()} type="button">
          ↷ Redo
        </button>
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
        <button className="btn" onClick={() => engineApi.createPrimitive("box")} type="button">
          + Box
        </button>
        <button className="btn" onClick={() => engineApi.createPrimitive("cylinder")} type="button">
          + Cylinder
        </button>
        <button className="btn" onClick={() => engineApi.createPrimitive("text")} type="button">
          + Text
        </button>
        <button className="btn" onClick={() => engineApi.createPrimitive("terrain")} type="button">
          + Terrain
        </button>
      </div>
      <DockviewReact className="dockview-theme-abyss shell-dock" components={panelComponents} onReady={onReady} />
    </div>
  );
}
