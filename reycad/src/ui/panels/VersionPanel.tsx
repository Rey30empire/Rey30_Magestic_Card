import { useCallback, useEffect, useState } from "react";
import { useEditorStore } from "../../editor/state/editorStore";
import {
  createProjectVersion,
  deleteProjectVersion,
  listProjectVersions,
  loadProjectVersion,
  type ProjectVersionMeta
} from "../../editor/persistence/storage";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function VersionPanel(): JSX.Element {
  const project = useEditorStore((state) => state.data.project);
  const loadProject = useEditorStore((state) => state.loadProject);
  const addLog = useEditorStore((state) => state.addLog);
  const [versions, setVersions] = useState<ProjectVersionMeta[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshVersions = useCallback(async () => {
    const items = await listProjectVersions();
    setVersions(items);
  }, []);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions]);

  async function onCreateVersion(): Promise<void> {
    setBusy(true);
    try {
      const created = await createProjectVersion(project, label);
      addLog(`[versions] checkpoint saved ${created.id}`);
      setLabel("");
      await refreshVersions();
    } finally {
      setBusy(false);
    }
  }

  async function onRestoreVersion(versionId: string): Promise<void> {
    setBusy(true);
    try {
      const snapshot = await loadProjectVersion(versionId);
      if (!snapshot) {
        addLog(`[versions] checkpoint not found ${versionId}`);
        return;
      }
      loadProject(snapshot);
      addLog(`[versions] restored ${versionId}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteVersion(versionId: string): Promise<void> {
    setBusy(true);
    try {
      await deleteProjectVersion(versionId);
      addLog(`[versions] deleted ${versionId}`);
      await refreshVersions();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack-sm">
      <div className="panel-head">
        <h3>Versions</h3>
        <button className="btn" disabled={busy} onClick={() => void refreshVersions()} type="button">
          Refresh
        </button>
      </div>

      <label className="field">
        <span>Checkpoint label</span>
        <input
          className="input"
          disabled={busy}
          maxLength={120}
          placeholder="Before new lowcoding phase"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <button className="btn btn-primary" disabled={busy} onClick={() => void onCreateVersion()} type="button">
        Save Checkpoint
      </button>

      <ul className="list">
        {versions.map((item) => (
          <li key={item.id} className="stack-xs">
            <div className="list-item">
              <span>{item.label}</span>
              <span className="mono">{formatDate(item.createdAt)}</span>
            </div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void onRestoreVersion(item.id)} type="button">
                Restore
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => void onDeleteVersion(item.id)} type="button">
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
