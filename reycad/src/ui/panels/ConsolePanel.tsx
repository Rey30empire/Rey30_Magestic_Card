import { useEditorStore } from "../../editor/state/editorStore";

export default function ConsolePanel(): JSX.Element {
  const logs = useEditorStore((state) => state.data.logs);
  return (
    <div className="panel">
      <h3>Console</h3>
      <div className="console">
        {logs.slice(-80).map((line, index) => (
          <div key={`${line}-${index}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}
