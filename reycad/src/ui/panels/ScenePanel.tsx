import engineApi from "../../engine/api/engineApi";
import { useEditorStore } from "../../editor/state/editorStore";
import type { PrimitiveType } from "../../engine/scenegraph/types";

const primitiveButtons: PrimitiveType[] = ["box", "cylinder", "sphere", "cone", "text", "terrain"];

export default function ScenePanel(): JSX.Element {
  const nodes = useEditorStore((state) => state.data.project.nodes);
  const selection = useEditorStore((state) => state.data.selection);
  const setSelection = useEditorStore((state) => state.setSelection);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Scene</h3>
        <div className="row">
          <button className="btn" onClick={() => undo()} type="button">
            Undo
          </button>
          <button className="btn" onClick={() => redo()} type="button">
            Redo
          </button>
        </div>
      </div>

      <div className="stack-sm">
        <p className="muted">Quick primitives</p>
        <div className="row wrap">
          {primitiveButtons.map((primitive) => (
            <button key={primitive} className="btn btn-primary" onClick={() => engineApi.createPrimitive(primitive)} type="button">
              Add {primitive}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <button
            className="btn"
            onClick={() => {
              if (selection.length >= 2) {
                engineApi.group(selection);
              }
            }}
            type="button"
          >
            Group Selection
          </button>
          <button
            className="btn"
            onClick={() => {
              if (selection.length === 1) {
                const node = nodes[selection[0]];
                if (node && node.type === "group") {
                  engineApi.ungroup(node.id);
                }
              }
            }}
            type="button"
          >
            Ungroup
          </button>
          <button
            className="btn"
            onClick={() => {
              if (selection.length === 2) {
                engineApi.addBooleanOp("subtract", selection[0], selection[1]);
              }
            }}
            type="button"
          >
            Boolean Subtract A-B
          </button>
        </div>

        <p className="muted">Phase 4 - Mannequin + Texture Prep</p>
        <div className="row wrap">
          <button className="btn" onClick={() => engineApi.loadMannequin("humanoid")} type="button">
            Mannequin Humanoid
          </button>
          <button className="btn" onClick={() => engineApi.loadMannequin("creature")} type="button">
            Mannequin Creature
          </button>
          <button className="btn" onClick={() => engineApi.loadMannequin("pet")} type="button">
            Mannequin Pet
          </button>
          <button className="btn" onClick={() => engineApi.loadMannequin("floatingCard")} type="button">
            Mannequin Card
          </button>
        </div>

        <p className="muted">Phase 5 - Arena Generator</p>
        <div className="row wrap">
          <button className="btn btn-primary" onClick={() => engineApi.generateArena()} type="button">
            Generate Arena
          </button>
        </div>

        <p className="muted">Phase 6 - Battle Integration</p>
        <div className="row wrap">
          <button className="btn" onClick={() => engineApi.setupBattleScene()} type="button">
            Setup Battle
          </button>
          <button className="btn btn-primary" onClick={() => engineApi.playBattleClash(16)} type="button">
            Play Clash
          </button>
          <button className="btn btn-danger" onClick={() => engineApi.stopBattleScene()} type="button">
            Stop Battle
          </button>
        </div>
      </div>

      <ul className="list">
        {Object.values(nodes).map((node) => (
          <li key={node.id}>
            <button
              className={`list-item ${selection.includes(node.id) ? "selected" : ""}`}
              onClick={() => setSelection([node.id])}
              type="button"
            >
              <span>{node.name}</span>
              <span className="mono">{node.type}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
