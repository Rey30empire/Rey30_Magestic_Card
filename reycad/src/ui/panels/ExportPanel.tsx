import { useState } from "react";
import engineApi from "../../engine/api/engineApi";
import { evaluateProject } from "../../engine/scenegraph/evaluator";
import { useEditorStore } from "../../editor/state/editorStore";
import { buildPlaySessionPackage } from "../../editor/runtime/playSessionExport";

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ExportPanel(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const project = useEditorStore((state) => state.data.project);
  const selection = useEditorStore((state) => state.data.selection);
  const evalResult = evaluateProject(project);

  async function exportStl() {
    setBusy(true);
    try {
      const blob = await engineApi.exportSTL(selection.length > 0 ? selection : undefined);
      downloadBlob(blob, "reycad-model.stl");
    } finally {
      setBusy(false);
    }
  }

  async function exportGlb() {
    setBusy(true);
    try {
      const blob = await engineApi.exportGLB(selection.length > 0 ? selection : undefined);
      downloadBlob(blob, "reycad-model.glb");
    } finally {
      setBusy(false);
    }
  }

  function exportPlaySession() {
    setBusy(true);
    try {
      const bundle = buildPlaySessionPackage(project, {
        preset: "editor-live",
        source: "editor-ui",
        projectFileName: "reycad-play-scene.project.json"
      });
      downloadBlob(new Blob([JSON.stringify(bundle.manifest, null, 2)], { type: "application/json" }), "reycad-play-session.manifest.json");
      downloadBlob(new Blob([JSON.stringify(bundle.project, null, 2)], { type: "application/json" }), "reycad-play-scene.project.json");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack-sm">
      <h3>Export</h3>
      <p className="muted">
        Objects: {evalResult.items.length} | Selection: {selection.length || "all"}
      </p>
      <div className="row">
        <button className="btn btn-primary" disabled={busy} onClick={() => void exportStl()} type="button">
          Export STL
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void exportGlb()} type="button">
          Export GLB
        </button>
        <button className="btn" disabled={busy} onClick={() => exportPlaySession()} type="button">
          Export Play Session
        </button>
      </div>
      {evalResult.warnings.length > 0 && (
        <ul className="list">
          {evalResult.warnings.map((warning) => (
            <li key={warning} className="warning">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
