import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initPythonBridge, runPython, stopPythonExecution } from "./pyBridge";
import { useEditorStore } from "../state/editorStore";

const DEFAULT_SCRIPT = `import reycad as rc
box_id = rc.create.box(w=30, h=8, d=12, x=0, y=4, z=0)
print("created", box_id)
`;

const SNIPPETS: Array<{ label: string; code: string }> = [
  {
    label: "Array",
    code: `import reycad as rc
base = rc.create.box(w=10, h=10, d=10)
rc.duplicate(base, count=12, dx=12, dy=0, dz=0)
`
  },
  {
    label: "Scatter",
    code: `import reycad as rc
rc.scatter("tpl_token", count=40, area=(180, 180), seed=77)
`
  },
  {
    label: "Card Stand",
    code: `import reycad as rc
body = rc.create.box(w=60, h=6, d=80, y=3)
slot = rc.create.box(w=55, h=12, d=4, y=8, z=20)
rc.hole(slot)
rc.group([body, slot], mode="solid")
`
  },
  {
    label: "Terrain",
    code: `import reycad as rc
terrain = rc.create.terrain(w=180, d=180, segments=64, height_seed=99, height_scale=14)
rc.frame([terrain])
`
  },
  {
    label: "Physics Drop",
    code: `import reycad as rc
box = rc.create.box(w=12, h=12, d=12, y=40)
rc.physics.collider(box, shape="box", size=(12,12,12))
rc.physics.rigidbody(box, mode="dynamic", mass=1)
rc.physics.world(enabled=True, simulate=True, gravity=(0,-9.81,0), floor_y=0, backend="lite")
rc.frame([box])
`
  },
  {
    label: "Battle Clash",
    code: `import reycad as rc
rc.physics.battle_setup()
rc.physics.battle_clash(impulse=18)
# rc.physics.battle_stop()
`
  }
];

type PythonJob = {
  id: string;
  code: string;
  timeoutMs: number;
};

type BatchState = {
  batchIndex: number;
  totalBatches: number;
  from: number;
  to: number;
};

export default function PythonConsolePanel(): JSX.Element {
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [output, setOutput] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [queue, setQueue] = useState<PythonJob[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const addLog = useEditorStore((state) => state.addLog);
  const processingRef = useRef(false);

  const activeJob = running ? queue[0] ?? null : null;
  const pendingJobs = useMemo(() => (running ? queue.slice(1) : queue), [queue, running]);

  const reloadBridge = useCallback(() => {
    setReady(false);
    initPythonBridge()
      .then(() => {
        setReady(true);
        setOutput((current) => [...current, "Pyodide ready"]);
      })
      .catch((error) => {
        setOutput((current) => [...current, `Pyodide load failed: ${String(error)}`]);
      });
  }, []);

  useEffect(() => {
    let mounted = true;
    initPythonBridge()
      .then(() => {
        if (!mounted) {
          return;
        }
        setReady(true);
        setOutput((current) => [...current, "Pyodide ready"]);
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        setOutput((current) => [...current, `Pyodide load failed: ${String(error)}`]);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current || !ready) {
      return;
    }
    const job = queue[0];
    if (!job) {
      return;
    }

    processingRef.current = true;
    setRunning(true);
    setProgress({ done: 0, total: 0 });
    setBatch(null);
    setOutput((current) => [...current, `[queue] running ${job.id}`]);

    try {
      const result = await runPython(job.code, {
        timeoutMs: job.timeoutMs,
        maxNodes: 500,
        onApplyProgress: (done, total) => setProgress({ done, total }),
        onApplyBatch: (batchIndex, totalBatches, from, to) => setBatch({ batchIndex, totalBatches, from, to })
      });
      if (result.stdout.trim()) {
        setOutput((current) => [...current, result.stdout.trimEnd()]);
      } else {
        setOutput((current) => [...current, ">>> done"]);
      }
      if (result.stderr.trim()) {
        setOutput((current) => [...current, `[stderr] ${result.stderr.trimEnd()}`]);
      }
      addLog(`[python] script executed (${result.appliedOps} mutations)`);
    } catch (error) {
      setOutput((current) => [...current, `error: ${String(error)}`]);
      addLog(`[python] error ${String(error)}`);
    } finally {
      processingRef.current = false;
      setRunning(false);
      setProgress(null);
      setBatch(null);
      setQueue((current) => {
        if (current[0]?.id === job.id) {
          return current.slice(1);
        }
        return current.filter((item) => item.id !== job.id);
      });
    }
  }, [addLog, queue, ready]);

  useEffect(() => {
    void processQueue();
  }, [processQueue]);

  function onRun(event: FormEvent) {
    event.preventDefault();
    if (!ready) {
      return;
    }

    const script = code;
    const job: PythonJob = {
      id: crypto.randomUUID().slice(0, 8),
      code: script,
      timeoutMs
    };
    setQueue((current) => [...current, job]);
    setHistory((current) => {
      const next = [script, ...current.filter((item) => item !== script)];
      return next.slice(0, 12);
    });
    setOutput((current) => [...current, `[queue] added ${job.id}`]);
    addLog(`[python] queued script ${job.id}`);
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Python Console</h3>
        <span className={`pill ${ready ? "ok" : "warn"}`}>{ready ? "ready" : "loading"}</span>
      </div>

      <form className="stack-sm" onSubmit={onRun}>
        <div className="row wrap">
          {SNIPPETS.map((snippet) => (
            <button key={snippet.label} className="btn" type="button" onClick={() => setCode(snippet.code)}>
              {snippet.label}
            </button>
          ))}
        </div>

        <textarea className="input code-editor" rows={9} value={code} onChange={(event) => setCode(event.target.value)} />
        <label className="field">
          <span>Timeout (ms)</span>
          <input
            className="input"
            max={15000}
            min={200}
            step={100}
            type="number"
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
          />
        </label>
        <div className="row wrap">
          <button className="btn btn-primary" disabled={!ready} type="submit">
            Queue Run
          </button>
          <button
            className="btn btn-danger"
            disabled={!running}
            type="button"
            onClick={() => {
              stopPythonExecution();
              setOutput((current) => [...current, "[python] stop requested"]);
              setQueue([]);
              processingRef.current = false;
              setRunning(false);
              setProgress(null);
              setBatch(null);
              reloadBridge();
            }}
          >
            Stop current
          </button>
          <button
            className="btn"
            disabled={pendingJobs.length === 0}
            type="button"
            onClick={() => {
              setQueue((current) => (running ? current.slice(0, 1) : []));
              setOutput((current) => [...current, "[python] pending queue cleared"]);
            }}
          >
            Clear pending
          </button>
        </div>
      </form>

      <p className="muted">
        Queue: {pendingJobs.length} pending
        {activeJob ? `, running ${activeJob.id}` : ""}
      </p>
      {progress && (
        <p className="muted">
          Apply progress: {progress.done}/{progress.total}
        </p>
      )}
      {batch && (
        <p className="muted">
          Batch {batch.batchIndex}/{batch.totalBatches} (ops {batch.from}-{batch.to})
        </p>
      )}

      {pendingJobs.length > 0 && (
        <ul className="list">
          {pendingJobs.map((job) => (
            <li key={job.id} className="list-item">
              <span>Job {job.id}</span>
              <span className="mono">timeout {job.timeoutMs}ms</span>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <div className="stack-xs">
          <strong>History</strong>
          <div className="row wrap">
            {history.map((item, index) => (
              <button key={`${index}-${item.length}`} className="btn" type="button" onClick={() => setCode(item)}>
                Load #{index + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="console">
        {output.map((line, index) => (
          <div key={`${line}-${index}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}
