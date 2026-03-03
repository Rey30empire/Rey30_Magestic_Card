import { useState } from "react";
import engineApi from "../../engine/api/engineApi";
import { useEditorStore } from "../../editor/state/editorStore";

const REYMESHY_PREF_KEY = "app.reymeshy.enabled";

function loadReyMeshyEnabledPreference(): boolean {
  const raw = localStorage.getItem(REYMESHY_PREF_KEY);
  if (raw === null) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

function persistReyMeshyEnabledPreference(enabled: boolean): void {
  localStorage.setItem(REYMESHY_PREF_KEY, enabled ? "1" : "0");
}

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
  const [impulse, setImpulse] = useState<[number, number, number]>([0, 5, 0]);
  const [reymeshyEnabled, setReymeshyEnabled] = useState<boolean>(() => loadReyMeshyEnabledPreference());
  const [reymeshyBusy, setReymeshyBusy] = useState(false);
  const [reymeshyResult, setReymeshyResult] = useState("Sin ejecucion.");

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

  const rigidBody = node.rigidBody;
  const collider = node.collider;
  const physicsReady = project.physics.enabled && project.physics.simulate && project.physics.runtimeMode === "arena";
  const reymeshyHistory = engineApi.listReyMeshyHistory(node.id, 8);

  async function runReyMeshyCleanup(): Promise<void> {
    if (!reymeshyEnabled) {
      setReymeshyResult("Activa ReyMeshy para ejecutar cleanup.");
      return;
    }

    setReymeshyBusy(true);
    setReymeshyResult("Ejecutando cleanup...");
    try {
      const report = await engineApi.cleanupNodeWithReyMeshy(node.id);
      const patchSummary = report.patchApplied ? ` | patch ${JSON.stringify(report.patch)}` : "";
      setReymeshyResult(`OK ${report.inputTriangles} -> ${report.outputTriangles} tris${patchSummary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReymeshyResult(`Error: ${message}`);
    } finally {
      setReymeshyBusy(false);
    }
  }

  function clearReyMeshyNodeHistory(): void {
    const removed = engineApi.clearReyMeshyHistory(node.id);
    setReymeshyResult(removed > 0 ? `Historial limpiado (${removed}).` : "No habia historial para este nodo.");
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

      {node.type !== "import" && (
        <div className="perm-card stack-sm">
          <div className="panel-head">
            <h4>Physics Node</h4>
            <span className="pill">{rigidBody ? "rb on" : "rb off"}</span>
          </div>

          <div className="row wrap">
            <button
              className={`btn ${rigidBody ? "" : "btn-primary"}`}
              onClick={() => {
                if (rigidBody) {
                  engineApi.setNodeRigidBody(node.id, { enabled: false });
                } else {
                  engineApi.setNodeRigidBody(node.id, { enabled: true });
                }
              }}
              type="button"
            >
              {rigidBody ? "Disable RigidBody" : "Enable RigidBody"}
            </button>

            <button
              className={`btn ${collider ? "" : "btn-primary"}`}
              onClick={() => {
                if (collider) {
                  engineApi.setNodeCollider(node.id, { enabled: false });
                } else {
                  engineApi.setNodeCollider(node.id, { enabled: true, shape: "box", size: [10, 10, 10] });
                }
              }}
              type="button"
            >
              {collider ? "Disable Collider" : "Enable Collider"}
            </button>
          </div>

          {rigidBody && (
            <div className="stack-sm">
              <label className="field">
                <span>RigidBody Mode</span>
                <select
                  className="input"
                  value={rigidBody.mode}
                  onChange={(event) =>
                    engineApi.setNodeRigidBody(node.id, {
                      mode: event.target.value as "dynamic" | "kinematic" | "fixed"
                    })
                  }
                >
                  <option value="dynamic">dynamic</option>
                  <option value="kinematic">kinematic</option>
                  <option value="fixed">fixed</option>
                </select>
              </label>

              <label className="field">
                <span>Mass</span>
                <input
                  className="input"
                  min={0.01}
                  step={0.1}
                  type="number"
                  value={rigidBody.mass}
                  onChange={(event) => engineApi.setNodeRigidBody(node.id, { mass: Number(event.target.value) })}
                />
              </label>

              <label className="field">
                <span>Gravity Scale</span>
                <input
                  className="input"
                  step={0.1}
                  type="number"
                  value={rigidBody.gravityScale}
                  onChange={(event) => engineApi.setNodeRigidBody(node.id, { gravityScale: Number(event.target.value) })}
                />
              </label>

              <label className="toggle">
                <input
                  checked={rigidBody.lockRotation}
                  onChange={(event) => engineApi.setNodeRigidBody(node.id, { lockRotation: event.target.checked })}
                  type="checkbox"
                />
                <span>Lock rotation</span>
              </label>

              <div className="stack-xs">
                <strong>Impulse Force</strong>
                <div className="row">
                  {[0, 1, 2].map((index) => (
                    <input
                      key={`impulse-${index}`}
                      className="input"
                      step={0.1}
                      type="number"
                      value={impulse[index]}
                      onChange={(event) => {
                        const next = [...impulse] as [number, number, number];
                        next[index] = Number(event.target.value);
                        setImpulse(next);
                      }}
                    />
                  ))}
                </div>
                <button
                  className="btn"
                  disabled={rigidBody.mode !== "dynamic" || !physicsReady}
                  onClick={() => {
                    engineApi.applyPhysicsImpulse(node.id, impulse);
                  }}
                  type="button"
                >
                  Apply Impulse
                </button>
                {rigidBody.mode !== "dynamic" && <span className="muted">Impulse only applies to dynamic rigidbodies.</span>}
                {rigidBody.mode === "dynamic" && !physicsReady && (
                  <span className="muted">Enable physics simulate in arena mode to apply impulses.</span>
                )}
              </div>
            </div>
          )}

          {collider && (
            <div className="stack-sm">
              <label className="field">
                <span>Collider Shape</span>
                <select
                  className="input"
                  value={collider.shape}
                  onChange={(event) =>
                    engineApi.setNodeCollider(node.id, {
                      shape: event.target.value as "box" | "sphere" | "capsule" | "mesh"
                    })
                  }
                >
                  <option value="box">box</option>
                  <option value="sphere">sphere</option>
                  <option value="capsule">capsule</option>
                  <option value="mesh">mesh</option>
                </select>
              </label>

              <label className="toggle">
                <input
                  checked={collider.isTrigger}
                  onChange={(event) => engineApi.setNodeCollider(node.id, { isTrigger: event.target.checked })}
                  type="checkbox"
                />
                <span>Is trigger</span>
              </label>

              {(collider.shape === "box" || collider.shape === "mesh") && (
                <div className="stack-xs">
                  <strong>Size</strong>
                  <div className="row">
                    {[0, 1, 2].map((index) => (
                      <input
                        key={`col-size-${index}`}
                        className="input"
                        min={0.001}
                        step={0.1}
                        type="number"
                        value={collider.size?.[index] ?? 1}
                        onChange={(event) => {
                          const next: [number, number, number] = [...(collider.size ?? [1, 1, 1])] as [number, number, number];
                          next[index] = Number(event.target.value);
                          engineApi.setNodeCollider(node.id, { size: next });
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {(collider.shape === "sphere" || collider.shape === "capsule") && (
                <label className="field">
                  <span>Radius</span>
                  <input
                    className="input"
                    min={0.001}
                    step={0.1}
                    type="number"
                    value={collider.radius ?? 0.5}
                    onChange={(event) => engineApi.setNodeCollider(node.id, { radius: Number(event.target.value) })}
                  />
                </label>
              )}

              {collider.shape === "capsule" && (
                <label className="field">
                  <span>Height</span>
                  <input
                    className="input"
                    min={0.001}
                    step={0.1}
                    type="number"
                    value={collider.height ?? 1}
                    onChange={(event) => engineApi.setNodeCollider(node.id, { height: Number(event.target.value) })}
                  />
                </label>
              )}
            </div>
          )}
        </div>
      )}

      <div className="perm-card stack-sm">
        <div className="panel-head">
          <h4>ReyMeshy Cleanup</h4>
          <span className={`pill ${reymeshyEnabled ? "ok" : ""}`}>{reymeshyEnabled ? "on" : "off"}</span>
        </div>

        <label className="toggle">
          <input
            checked={reymeshyEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setReymeshyEnabled(enabled);
              persistReyMeshyEnabledPreference(enabled);
            }}
            type="checkbox"
          />
          <span>Activar ReyMeshy en esta app</span>
        </label>

        <button className="btn btn-primary" disabled={!reymeshyEnabled || reymeshyBusy} onClick={() => void runReyMeshyCleanup()} type="button">
          {reymeshyBusy ? "Running..." : "Run Cleanup"}
        </button>
        <span className="mono">{reymeshyResult}</span>
        <div className="row">
          <span className="muted">Historial nodo: {reymeshyHistory.length}</span>
          <button className="btn" disabled={reymeshyHistory.length === 0} onClick={clearReyMeshyNodeHistory} type="button">
            Limpiar historial
          </button>
        </div>
        {reymeshyHistory.length > 0 ? (
          <ul className="list">
            {reymeshyHistory.map((entry) => (
              <li key={entry.id} className="perm-card stack-xs">
                <div className="panel-head">
                  <span className={`pill ${entry.status === "ok" ? "ok" : "warn"}`}>{entry.status}</span>
                  <span className="mono">{new Date(entry.at).toLocaleString()}</span>
                </div>
                {entry.status === "ok" ? (
                  <span className="mono">
                    tris {entry.inputTriangles ?? "-"} -&gt; {entry.outputTriangles ?? "-"}
                    {entry.patchApplied ? ` | patch ${JSON.stringify(entry.patch)}` : ""}
                  </span>
                ) : (
                  <span className="muted">{entry.message ?? "cleanup failed"}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">Sin historial para este nodo.</span>
        )}
        {!reymeshyEnabled && <span className="muted">Activa el toggle para usar el pipeline AI -&gt; Mesh -&gt; Cleanup.</span>}
      </div>

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
