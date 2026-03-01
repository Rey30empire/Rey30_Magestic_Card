import { useEffect } from "react";
import { useEditorStore } from "./state/editorStore";
import { loadProjectAutosave } from "./persistence/storage";
import AppShell from "../app/AppShell";

export default function EditorRoot(): JSX.Element {
  const loadProject = useEditorStore((state) => state.loadProject);
  const addLog = useEditorStore((state) => state.addLog);

  useEffect(() => {
    let mounted = true;
    loadProjectAutosave()
      .then((snapshot) => {
        if (!mounted || !snapshot) {
          return;
        }
        loadProject(snapshot.project, snapshot.aiHistory);
        addLog("[autosave] restored");
      })
      .catch((error) => {
        addLog(`[autosave] restore failed ${String(error)}`);
      });

    return () => {
      mounted = false;
    };
  }, [addLog, loadProject]);

  return <AppShell />;
}
