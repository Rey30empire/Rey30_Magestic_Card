import engineApi from "../../engine/api/engineApi";
import { useEditorStore } from "../../editor/state/editorStore";

function vecInput(label: string, value: [number, number, number], onChange: (next: [number, number, number]) => void): JSX.Element {
  return (
    <div className="stack-xs">
      <strong>{label}</strong>
      <div className="row">
        {[0, 1, 2].map((index) => (
          <input
            key={`${label}-${index}`}
            className="input"
            step={0.1}
            type="number"
            value={value[index]}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function InspectorPanel(): JSX.Element {
  const selection = useEditorStore((state) => state.data.selection);
  const project = useEditorStore((state) => state.data.project);
  const materials = Object.values(project.materials);

  if (selection.length !== 1) {
    return (
      <div className="panel">
        <h3>Inspector</h3>
        <p className="muted">Select one node to edit.</p>
      </div>
    );
  }

  const node = project.nodes[selection[0]];
  if (!node) {
    return (
      <div className="panel">
        <h3>Inspector</h3>
        <p className="muted">Node not found.</p>
      </div>
    );
  }

  return (
    <div className="panel stack-sm">
      <div className="panel-head">
        <h3>Inspector</h3>
        <span className="pill">{node.type}</span>
      </div>

      <label className="field">
        <span>Name</span>
        <input className="input" readOnly value={node.name} />
      </label>

      <label className="field">
        <span>Material</span>
        <select
          className="input"
          value={node.materialId ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            engineApi.setNodeMaterial(node.id, value.length > 0 ? value : undefined);
          }}
        >
          <option value="">Default</option>
          {materials.map((material) => (
            <option key={material.id} value={material.id}>
              {material.name} ({material.kind})
            </option>
          ))}
        </select>
      </label>

      {vecInput("Position", node.transform.position, (position) => {
        engineApi.setNodeTransform(node.id, { position });
      })}
      {vecInput("Rotation", node.transform.rotation, (rotation) => {
        engineApi.setNodeTransform(node.id, { rotation });
      })}
      {vecInput("Scale", node.transform.scale, (scale) => {
        engineApi.setNodeTransform(node.id, { scale });
      })}

      <div className="row">
        <button className="btn" onClick={() => engineApi.toggleHole(node.id)} type="button">
          Toggle Hole
        </button>
        <button className="btn btn-danger" onClick={() => engineApi.deleteNodes([node.id])} type="button">
          Delete
        </button>
      </div>
    </div>
  );
}
