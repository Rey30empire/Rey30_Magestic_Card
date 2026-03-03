import { useMemo, useState } from "react";
import { useQualityStore } from "../../engine/runtime/qualityStore";
import { useEditorStore } from "../../editor/state/editorStore";
import engineApi from "../../engine/api/engineApi";

const qualityModes = ["auto", "ultra", "high", "medium", "low"] as const;
const REYMESHY_PREF_KEY = "app.reymeshy.enabled";

function loadReyMeshyEnabledPreference(): boolean {
  const raw = localStorage.getItem(REYMESHY_PREF_KEY);
  if (raw === null) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export default function PerformancePanel(): JSX.Element {
  const mode = useQualityStore((state) => state.mode);
  const effectiveLevel = useQualityStore((state) => state.effectiveLevel);
  const profile = useQualityStore((state) => state.profile);
  const fps = useQualityStore((state) => state.fps);
  const frameMs = useQualityStore((state) => state.frameMs);
  const sampleCount = useQualityStore((state) => state.sampleCount);
  const transitions = useQualityStore((state) => state.transitions);
  const lastTransitionAt = useQualityStore((state) => state.lastTransitionAt);
  const reason = useQualityStore((state) => state.reason);
  const renderStats = useQualityStore((state) => state.renderStats);
  const assetStats = useQualityStore((state) => state.assetStats);
  const setMode = useQualityStore((state) => state.setMode);
  const resetMetrics = useQualityStore((state) => state.resetMetrics);
  const physics = useEditorStore((state) => state.data.project.physics);
  const nodes = useEditorStore((state) => state.data.project.nodes);
  const rootId = useEditorStore((state) => state.data.project.rootId);
  const selection = useEditorStore((state) => state.data.selection);
  const [constraintDraft, setConstraintDraft] = useState<{
    aId: string;
    bId: string;
    restLength: number;
    stiffness: number;
    damping: number;
  }>({
    aId: "",
    bId: "",
    restLength: 10,
    stiffness: 0.6,
    damping: 0.1
  });
  const [reymeshyBatchBusy, setReymeshyBatchBusy] = useState(false);
  const [reymeshyBatchResult, setReymeshyBatchResult] = useState("Sin ejecucion en lote.");
  const [reymeshyBatchFailures, setReymeshyBatchFailures] = useState<string[]>([]);
  const [benchmarkPreset, setBenchmarkPreset] = useState<"indoor" | "outdoor" | "large-world">("outdoor");
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [benchmarkResult, setBenchmarkResult] = useState("Sin benchmark generado.");

  const bodyNodes = useMemo(
    () =>
      Object.values(nodes).filter((node) => node.type !== "import" && node.rigidBody?.enabled).map((node) => ({ id: node.id, name: node.name })),
    [nodes]
  );
  const batchTargetIds = useMemo(
    () =>
      Array.from(new Set(selection))
        .filter((nodeId) => nodeId !== rootId)
        .filter((nodeId) => Boolean(nodes[nodeId])),
    [selection, rootId, nodes]
  );
  const reymeshyEnabled = loadReyMeshyEnabledPreference();

  const bodyNameById = useMemo(() => Object.fromEntries(bodyNodes.map((item) => [item.id, item.name])) as Record<string, string>, [bodyNodes]);
  const canCreateConstraint = bodyNodes.length >= 2;

  function createConstraint(): void {
    if (!canCreateConstraint) {
      return;
    }

    const fallbackA = bodyNodes[0]?.id ?? "";
    const fallbackB = bodyNodes.find((item) => item.id !== fallbackA)?.id ?? "";
    const aId = constraintDraft.aId || fallbackA;
    const bId = constraintDraft.bId || fallbackB;
    if (!aId || !bId || aId === bId) {
      return;
    }

    engineApi.addPhysicsConstraint({
      type: "distance",
      a: aId,
      b: bId,
      restLength: constraintDraft.restLength,
      stiffness: constraintDraft.stiffness,
      damping: constraintDraft.damping,
      enabled: true
    });
  }

  async function runReyMeshyBatchCleanup(): Promise<void> {
    if (batchTargetIds.length === 0) {
      setReymeshyBatchFailures([]);
      setReymeshyBatchResult("Selecciona al menos un nodo para cleanup en lote.");
      return;
    }

    setReymeshyBatchBusy(true);
    setReymeshyBatchFailures([]);
    setReymeshyBatchResult("Ejecutando cleanup en lote...");
    try {
      const report = await engineApi.cleanupSelectionWithReyMeshy(batchTargetIds);
      const failures = report.entries
        .filter((entry): entry is { nodeId: string; ok: false; error: string } => !entry.ok)
        .map((entry) => `${entry.nodeId}: ${entry.error}`);
      setReymeshyBatchFailures(failures);
      setReymeshyBatchResult(`Batch: ${report.ok}/${report.requested} OK, ${report.failed} fallos.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReymeshyBatchResult(`Error batch: ${message}`);
      setReymeshyBatchFailures([]);
    } finally {
      setReymeshyBatchBusy(false);
    }
  }

  function generateBenchmarkScene(): void {
    if (benchmarkBusy) {
      return;
    }
    setBenchmarkBusy(true);
    try {
      const result = engineApi.generateBenchmarkScene(benchmarkPreset);
      setBenchmarkResult(`Benchmark ${result.preset}: ${result.nodeCount} nodos.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBenchmarkResult(`Error benchmark: ${message}`);
    } finally {
      setBenchmarkBusy(false);
    }
  }

  return (
    <div className="panel stack-sm">
      <div className="panel-head">
        <h3>Performance</h3>
        <span className={`pill ${mode === "auto" ? "ok" : ""}`}>mode {mode}</span>
      </div>

      <div className="row wrap">
        {qualityModes.map((value) => (
          <button
            key={value}
            className={`btn ${mode === value ? "btn-primary" : ""}`}
            onClick={() => setMode(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>

      <div className="perm-card stack-xs">
        <span className="mono">effective: {effectiveLevel}</span>
        <span className="mono">fps: {fps.toFixed(2)}</span>
        <span className="mono">frame: {frameMs.toFixed(2)} ms</span>
        <span className="mono">samples: {sampleCount}</span>
        <span className="mono">dpr: {profile.dpr}</span>
        <span className="mono">shadows: {profile.shadows ? "on" : "off"}</span>
        <span className="mono">antialias: {profile.antialias ? "on" : "off"}</span>
        <span className="mono">csg detail: {profile.csgDetail}</span>
        <span className="mono">transitions: {transitions}</span>
        <span className="mono">draw calls: {renderStats.drawCalls}</span>
        <span className="mono">triangles: {renderStats.triangles}</span>
        <span className="mono">lines: {renderStats.lines}</span>
        <span className="mono">points: {renderStats.points}</span>
        <span className="mono">visible meshes: {renderStats.visibleMeshes}</span>
        <span className="mono">culled meshes: {renderStats.culledMeshes}</span>
        <span className="mono">instanced groups: {renderStats.instancedGroups}</span>
        <span className="mono">static batch groups: {renderStats.staticBatchGroups}</span>
        <span className="mono">static batch meshes: {renderStats.staticBatchMeshes}</span>
        <span className="mono">lod H/M/L: {renderStats.lodHigh}/{renderStats.lodMedium}/{renderStats.lodLow}</span>
        <span className="mono">scene profile: {renderStats.sceneProfile}</span>
        <span className="mono">scene radius: {renderStats.sceneRadius.toFixed(2)}</span>
        <span className="mono">scene nodes: {renderStats.sceneNodeCount}</span>
        <span className="mono">instancing threshold: {renderStats.instancingThreshold}</span>
        <span className="mono">cull margin: {renderStats.cullMargin.toFixed(3)}</span>
        <span className="mono">lod near/mid: {renderStats.lodNearDistance.toFixed(1)} / {renderStats.lodMidDistance.toFixed(1)}</span>
        {lastTransitionAt && <span className="mono">last: {new Date(lastTransitionAt).toLocaleTimeString()}</span>}
        {renderStats.updatedAt && <span className="mono">render stats: {new Date(renderStats.updatedAt).toLocaleTimeString()}</span>}
        <span className="mono">assets manifest/cache: {assetStats.manifestEntries}/{assetStats.cacheEntries}</span>
        <span className="mono">asset loads queued/active: {assetStats.queuedLoads}/{assetStats.activeLoads}</span>
        <span className="mono">asset hits/misses: {assetStats.hits}/{assetStats.misses}</span>
        <span className="mono">asset loads ok/fail: {assetStats.completedLoads}/{assetStats.failedLoads}</span>
        <span className="mono">asset evictions: {assetStats.evictions}</span>
        <span className="mono">
          asset memory: {(assetStats.bytesUsed / (1024 * 1024)).toFixed(1)}MB / {(assetStats.bytesBudget / (1024 * 1024)).toFixed(1)}MB
        </span>
        {assetStats.updatedAt && <span className="mono">asset stats: {new Date(assetStats.updatedAt).toLocaleTimeString()}</span>}
        {reason && <span className="mono">reason: {reason}</span>}
      </div>

      <button className="btn" onClick={() => resetMetrics()} type="button">
        Reset Metrics
      </button>

      <div className="perm-card stack-sm">
        <div className="panel-head">
          <h4>Benchmark Scene</h4>
          <span className="pill">runtime</span>
        </div>
        <label className="field">
          <span>Preset</span>
          <select
            className="input"
            value={benchmarkPreset}
            onChange={(event) => setBenchmarkPreset(event.target.value as "indoor" | "outdoor" | "large-world")}
          >
            <option value="indoor">indoor</option>
            <option value="outdoor">outdoor</option>
            <option value="large-world">large-world</option>
          </select>
        </label>
        <button className="btn btn-primary" disabled={benchmarkBusy} onClick={() => generateBenchmarkScene()} type="button">
          {benchmarkBusy ? "Generating..." : "Generate Benchmark Scene"}
        </button>
        <span className="mono">{benchmarkResult}</span>
      </div>

      <div className="perm-card stack-sm">
        <div className="panel-head">
          <h4>ReyMeshy Batch</h4>
          <span className={`pill ${reymeshyEnabled ? "ok" : "warn"}`}>{reymeshyEnabled ? "enabled" : "disabled"}</span>
        </div>
        <span className="muted">Seleccion actual: {batchTargetIds.length} nodo(s).</span>
        <button
          className="btn btn-primary"
          disabled={!reymeshyEnabled || reymeshyBatchBusy || batchTargetIds.length === 0}
          onClick={() => void runReyMeshyBatchCleanup()}
          type="button"
        >
          {reymeshyBatchBusy ? "Running batch..." : "Run Cleanup Batch"}
        </button>
        <span className="mono">{reymeshyBatchResult}</span>
        {reymeshyBatchFailures.length > 0 && (
          <ul className="list">
            {reymeshyBatchFailures.map((failure) => (
              <li key={failure} className="warning">
                {failure}
              </li>
            ))}
          </ul>
        )}
        {!reymeshyEnabled && <span className="muted">Activa ReyMeshy en Settings/Inspector para habilitar batch cleanup.</span>}
      </div>

      <div className="perm-card stack-sm">
        <div className="panel-head">
          <h4>Physics World</h4>
          <span className={`pill ${physics.enabled ? "ok" : ""}`}>
            {physics.enabled ? `${physics.runtimeMode}` : "off"}
          </span>
        </div>

        <label className="toggle">
          <input
            checked={physics.enabled}
            onChange={(event) => engineApi.setPhysicsSettings({ enabled: event.target.checked })}
            type="checkbox"
          />
          <span>Enable physics</span>
        </label>
        <label className="toggle">
          <input
            checked={physics.simulate}
            onChange={(event) => engineApi.setPhysicsSettings({ simulate: event.target.checked })}
            type="checkbox"
          />
          <span>Simulate</span>
        </label>

        <label className="field">
          <span>Runtime Mode</span>
          <select
            className="input"
            value={physics.runtimeMode}
            onChange={(event) =>
              engineApi.setPhysicsSettings({
                runtimeMode: event.target.value as "static" | "arena"
              })
            }
          >
            <option value="static">static (render only)</option>
            <option value="arena">arena (physics active)</option>
          </select>
        </label>

        <label className="field">
          <span>Backend</span>
          <select
            className="input"
            value={physics.backend}
            onChange={(event) =>
              engineApi.setPhysicsSettings({
                backend: event.target.value as "auto" | "lite" | "rapier"
              })
            }
          >
            <option value="auto">auto</option>
            <option value="lite">lite</option>
            <option value="rapier">rapier</option>
          </select>
        </label>

        <div className="stack-xs">
          <strong>Gravity</strong>
          <div className="row">
            {[0, 1, 2].map((index) => (
              <input
                key={`gravity-${index}`}
                className="input"
                step={0.1}
                type="number"
                value={physics.gravity[index]}
                onChange={(event) => {
                  const next = [...physics.gravity] as [number, number, number];
                  next[index] = Number(event.target.value);
                  engineApi.setPhysicsSettings({ gravity: next });
                }}
              />
            ))}
          </div>
        </div>

        <label className="field">
          <span>Floor Y</span>
          <input
            className="input"
            step={0.1}
            type="number"
            value={physics.floorY}
            onChange={(event) => engineApi.setPhysicsSettings({ floorY: Number(event.target.value) })}
          />
        </label>

        <div className="stack-sm">
          <div className="panel-head">
            <h4>Constraints (Distance)</h4>
            <span className={`pill ${physics.constraints.length > 0 ? "ok" : ""}`}>{physics.constraints.length}</span>
          </div>

          {!canCreateConstraint && <p className="muted">Enable rigidbody on at least two nodes to create constraints.</p>}

          <div className="stack-xs">
            <label className="field">
              <span>Body A</span>
              <select
                className="input"
                value={constraintDraft.aId}
                onChange={(event) => setConstraintDraft((current) => ({ ...current, aId: event.target.value }))}
              >
                <option value="">Select body</option>
                {bodyNodes.map((item) => (
                  <option key={`constraint-a-${item.id}`} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Body B</span>
              <select
                className="input"
                value={constraintDraft.bId}
                onChange={(event) => setConstraintDraft((current) => ({ ...current, bId: event.target.value }))}
              >
                <option value="">Select body</option>
                {bodyNodes.map((item) => (
                  <option key={`constraint-b-${item.id}`} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Rest Length</span>
              <input
                className="input"
                min={0.001}
                step={0.1}
                type="number"
                value={constraintDraft.restLength}
                onChange={(event) =>
                  setConstraintDraft((current) => ({
                    ...current,
                    restLength: Number(event.target.value)
                  }))
                }
              />
            </label>

            <label className="field">
              <span>Stiffness (0-1)</span>
              <input
                className="input"
                max={1}
                min={0}
                step={0.05}
                type="number"
                value={constraintDraft.stiffness}
                onChange={(event) =>
                  setConstraintDraft((current) => ({
                    ...current,
                    stiffness: Number(event.target.value)
                  }))
                }
              />
            </label>

            <label className="field">
              <span>Damping (0-1)</span>
              <input
                className="input"
                max={1}
                min={0}
                step={0.05}
                type="number"
                value={constraintDraft.damping}
                onChange={(event) =>
                  setConstraintDraft((current) => ({
                    ...current,
                    damping: Number(event.target.value)
                  }))
                }
              />
            </label>

            <button className="btn btn-primary" disabled={!canCreateConstraint} onClick={createConstraint} type="button">
              Add Constraint
            </button>
          </div>

          {physics.constraints.length === 0 ? (
            <p className="muted">No constraints.</p>
          ) : (
            <ul className="list">
              {physics.constraints.map((constraint) => (
                <li key={constraint.id} className="list-item">
                  <div className="stack-xs">
                    <strong>{constraint.id}</strong>
                    <span className="mono">
                      {(bodyNameById[constraint.a] ?? constraint.a)} - {(bodyNameById[constraint.b] ?? constraint.b)}
                    </span>
                    <label className="toggle">
                      <input
                        checked={constraint.enabled}
                        onChange={(event) =>
                          engineApi.updatePhysicsConstraint(constraint.id, {
                            enabled: event.target.checked
                          })
                        }
                        type="checkbox"
                      />
                      <span>Enabled</span>
                    </label>
                    <div className="row">
                      <input
                        className="input"
                        min={0.001}
                        step={0.1}
                        title="rest length"
                        type="number"
                        value={constraint.restLength}
                        onChange={(event) =>
                          engineApi.updatePhysicsConstraint(constraint.id, {
                            restLength: Number(event.target.value)
                          })
                        }
                      />
                      <input
                        className="input"
                        max={1}
                        min={0}
                        step={0.05}
                        title="stiffness"
                        type="number"
                        value={constraint.stiffness}
                        onChange={(event) =>
                          engineApi.updatePhysicsConstraint(constraint.id, {
                            stiffness: Number(event.target.value)
                          })
                        }
                      />
                      <input
                        className="input"
                        max={1}
                        min={0}
                        step={0.05}
                        title="damping"
                        type="number"
                        value={constraint.damping}
                        onChange={(event) =>
                          engineApi.updatePhysicsConstraint(constraint.id, {
                            damping: Number(event.target.value)
                          })
                        }
                      />
                    </div>
                    <button className="btn btn-danger" onClick={() => engineApi.removePhysicsConstraint(constraint.id)} type="button">
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
