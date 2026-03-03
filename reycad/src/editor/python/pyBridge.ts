import engineApi from "../../engine/api/engineApi";
import { createId } from "../../lib/ids";

type PythonWorkerRequest =
  | {
      id: string;
      type: "init";
    }
  | {
      id: string;
      type: "run";
      code: string;
      maxNodes: number;
      selection: string[];
      timeoutMs: number;
    };

type PythonWorkerResponse =
  | {
      id: string;
      ok: true;
      type: "init";
    }
  | {
      id: string;
      ok: true;
      type: "run";
      stdout: string;
      stderr: string;
      ops: Array<{ tool: string; args: Record<string, unknown> }>;
    }
  | {
      id: string;
      ok: false;
      type: "error";
      error: string;
    };

type PendingRequest = {
  resolve: (value: PythonWorkerResponse) => void;
  reject: (reason: unknown) => void;
};

type ExecutePythonOpsOptions = {
  signal?: AbortSignal;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
  onBatch?: (batchIndex: number, totalBatches: number, from: number, to: number) => void;
};

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
const pending = new Map<string, PendingRequest>();
const APPLY_YIELD_EVERY = 20;
let applyAbortController: AbortController | null = null;

function asVec3(value: unknown, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    return fallback;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  return [Number.isFinite(x) ? x : fallback[0], Number.isFinite(y) ? y : fallback[1], Number.isFinite(z) ? z : fallback[2]];
}

function seededRandomFactory(seed: number): () => number {
  let state = Math.max(1, seed | 0);
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return Math.abs(state % 10000) / 10000;
  };
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./pythonWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<PythonWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) {
      return;
    }
    pending.delete(event.data.id);
    if (!event.data.ok) {
      request.reject(new Error(event.data.error));
      return;
    }
    request.resolve(event.data);
  };
  worker.onerror = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  return worker;
}

function stopWorkerInternal(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  initPromise = null;
  pending.clear();
}

async function postToWorker(payload: PythonWorkerRequest): Promise<PythonWorkerResponse> {
  const instance = ensureWorker();
  return await new Promise<PythonWorkerResponse>((resolve, reject) => {
    pending.set(payload.id, { resolve, reject });
    instance.postMessage(payload);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Python apply cancelled");
  }
}

async function executePythonOps(ops: Array<{ tool: string; args: Record<string, unknown> }>, options?: ExecutePythonOpsOptions): Promise<number> {
  let mutationCount = 0;
  const batchSize = Math.max(1, Math.min(50, options?.batchSize ?? 12));

  async function tick(): Promise<void> {
    mutationCount += 1;
    if (mutationCount % APPLY_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }

  const totalBatches = Math.ceil(ops.length / batchSize);
  let completedOps = 0;

  for (let batchStart = 0, batchIndex = 0; batchStart < ops.length; batchStart += batchSize, batchIndex += 1) {
    throwIfAborted(options?.signal);
    const batchEnd = Math.min(batchStart + batchSize, ops.length);
    options?.onBatch?.(batchIndex + 1, totalBatches, batchStart + 1, batchEnd);

    for (let index = batchStart; index < batchEnd; index += 1) {
      throwIfAborted(options?.signal);
      const op = ops[index];

      if (op.tool === "create_primitive") {
        engineApi.createPrimitive(
          (op.args.primitive as "box" | "cylinder" | "sphere" | "cone" | "text" | "terrain") ?? "box",
          (op.args.params as Record<string, unknown> | undefined) ?? {},
          (op.args.transform as { position?: [number, number, number] } | undefined) ?? {},
          op.args.materialId as string | undefined
        );
        await tick();
      } else if (op.tool === "group") {
        engineApi.createGroup((op.args.nodeIds as string[]) ?? [], (op.args.mode as "solid" | "hole" | "mixed") ?? "mixed");
        await tick();
      } else if (op.tool === "set_mode") {
        const nodeId = op.args.nodeId as string;
        const mode = op.args.mode as "solid" | "hole";
        const snapshot = engineApi.getProjectSnapshot().nodes[nodeId];
        if (snapshot && snapshot.type !== "import") {
          const currentMode = snapshot.mode ?? "solid";
          if (currentMode !== mode) {
            engineApi.toggleHole(nodeId);
            await tick();
          }
        }
      } else if (op.tool === "add_boolean") {
        engineApi.addBooleanOp(
          (op.args.op as "union" | "subtract" | "intersect") ?? "subtract",
          String(op.args.aId),
          String(op.args.bId)
        );
        await tick();
      } else if (op.tool === "set_grid") {
        engineApi.setGrid({
          snap: op.args.snap as number | undefined,
          angleSnap: op.args.angleSnap as number | undefined,
          size: op.args.size as number | undefined
        });
        await tick();
      } else if (op.tool === "set_rigidbody") {
        engineApi.setNodeRigidBody(String(op.args.nodeId ?? ""), {
          enabled: op.args.enabled as boolean | undefined,
          mode: op.args.mode as "dynamic" | "kinematic" | "fixed" | undefined,
          mass: op.args.mass as number | undefined,
          gravityScale: op.args.gravityScale as number | undefined,
          lockRotation: op.args.lockRotation as boolean | undefined,
          linearVelocity: op.args.linearVelocity as [number, number, number] | undefined
        });
        await tick();
      } else if (op.tool === "set_collider") {
        engineApi.setNodeCollider(String(op.args.nodeId ?? ""), {
          enabled: op.args.enabled as boolean | undefined,
          shape: op.args.shape as "box" | "sphere" | "capsule" | "mesh" | undefined,
          isTrigger: op.args.isTrigger as boolean | undefined,
          size: op.args.size as [number, number, number] | undefined,
          radius: op.args.radius as number | undefined,
          height: op.args.height as number | undefined
        });
        await tick();
      } else if (op.tool === "set_physics_world") {
        engineApi.setPhysicsSettings({
          enabled: op.args.enabled as boolean | undefined,
          simulate: op.args.simulate as boolean | undefined,
          runtimeMode: op.args.runtimeMode as "static" | "arena" | undefined,
          backend: op.args.backend as "auto" | "lite" | "rapier" | undefined,
          gravity: op.args.gravity === undefined ? undefined : asVec3(op.args.gravity),
          floorY: op.args.floorY as number | undefined
        });
        await tick();
      } else if (op.tool === "apply_impulse") {
        const impulse = asVec3(op.args.impulse);
        engineApi.applyPhysicsImpulse(String(op.args.nodeId ?? ""), impulse);
        await tick();
      } else if (op.tool === "setup_battle_scene") {
        engineApi.setupBattleScene();
        await tick();
      } else if (op.tool === "play_battle_clash") {
        const impulse = typeof op.args.impulse === "number" ? op.args.impulse : undefined;
        if (impulse === undefined) {
          engineApi.playBattleClash();
        } else {
          engineApi.playBattleClash(impulse);
        }
        await tick();
      } else if (op.tool === "stop_battle_scene") {
        engineApi.stopBattleScene();
        await tick();
      } else if (op.tool === "add_constraint") {
        const restLength = Number(op.args.restLength);
        const stiffness = Number(op.args.stiffness);
        const damping = Number(op.args.damping);
        engineApi.addPhysicsConstraint({
          type: "distance",
          a: String(op.args.aId ?? ""),
          b: String(op.args.bId ?? ""),
          restLength: Number.isFinite(restLength) ? restLength : 10,
          stiffness: Number.isFinite(stiffness) ? stiffness : 0.6,
          damping: Number.isFinite(damping) ? damping : 0.1,
          enabled: typeof op.args.enabled === "boolean" ? op.args.enabled : true
        });
        await tick();
      } else if (op.tool === "update_constraint") {
        engineApi.updatePhysicsConstraint(String(op.args.constraintId ?? ""), {
          a: op.args.aId as string | undefined,
          b: op.args.bId as string | undefined,
          restLength: op.args.restLength as number | undefined,
          stiffness: op.args.stiffness as number | undefined,
          damping: op.args.damping as number | undefined,
          enabled: op.args.enabled as boolean | undefined
        });
        await tick();
      } else if (op.tool === "remove_constraint") {
        engineApi.removePhysicsConstraint(String(op.args.constraintId ?? ""));
        await tick();
      } else if (op.tool === "selection_set") {
        engineApi.setSelection((op.args.nodeIds as string[]) ?? []);
        await tick();
      } else if (op.tool === "frame") {
        engineApi.frameSelection((op.args.nodeIds as string[]) ?? []);
        await tick();
      } else if (op.tool === "duplicate_pattern") {
        const nodeId = String(op.args.nodeId ?? "");
        const count = Math.max(0, Math.min(500, Number(op.args.count ?? 0)));
        const dx = Number(op.args.dx ?? 0);
        const dy = Number(op.args.dy ?? 0);
        const dz = Number(op.args.dz ?? 0);
        const base = engineApi.getProjectSnapshot().nodes[nodeId];
        if (base) {
          for (let duplicateIndex = 1; duplicateIndex <= count; duplicateIndex += 1) {
            throwIfAborted(options?.signal);
            const [newId] = engineApi.duplicateNodes([nodeId]);
            if (!newId) {
              continue;
            }
            await tick();
            engineApi.setNodeTransform(newId, {
              position: [
                base.transform.position[0] + dx * duplicateIndex,
                base.transform.position[1] + dy * duplicateIndex,
                base.transform.position[2] + dz * duplicateIndex
              ]
            });
            await tick();
          }
        }
      } else if (op.tool === "scatter_template") {
        const count = Math.max(0, Math.min(500, Number(op.args.count ?? 0)));
        const width = Number(op.args.width ?? 100);
        const depth = Number(op.args.depth ?? 100);
        const templateId = String(op.args.templateId ?? "");
        const seed = Number(op.args.seed ?? 123);
        const random = seededRandomFactory(seed);
        for (let scatterIndex = 0; scatterIndex < count; scatterIndex += 1) {
          throwIfAborted(options?.signal);
          const inserted = engineApi.insertTemplate(templateId);
          const nodeId = inserted[0];
          if (!nodeId) {
            continue;
          }
          await tick();
          const x = (random() - 0.5) * width;
          const z = (random() - 0.5) * depth;
          engineApi.setNodeTransform(nodeId, {
            position: [x, 0, z]
          });
          await tick();
        }
      }

      completedOps += 1;
      options?.onProgress?.(completedOps, ops.length);
    }

    if (batchEnd < ops.length) {
      await yieldToEventLoop();
    }
  }

  return mutationCount;
}

type RunPythonOptions = {
  timeoutMs?: number;
  maxNodes?: number;
  onApplyProgress?: (done: number, total: number) => void;
  onApplyBatch?: (batchIndex: number, totalBatches: number, from: number, to: number) => void;
};

export async function initPythonBridge(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const id = createId("py_init");
    await postToWorker({ id, type: "init" });
  })();

  return initPromise;
}

export async function runPython(
  code: string,
  options?: RunPythonOptions
): Promise<{
  stdout: string;
  stderr: string;
  appliedOps: number;
}> {
  await initPythonBridge();

  const timeoutMs = Math.max(200, Math.min(15_000, options?.timeoutMs ?? 2_000));
  const maxNodes = Math.max(1, Math.min(2_000, options?.maxNodes ?? 500));
  const id = createId("py_run");

  const runPromise = postToWorker({
    id,
    type: "run",
    code,
    maxNodes,
    selection: engineApi.getSelection(),
    timeoutMs
  });

  const timeoutPromise = new Promise<PythonWorkerResponse>((_, reject) => {
    const timer = window.setTimeout(() => {
      stopWorkerInternal();
      reject(new Error(`Python execution timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    runPromise.finally(() => {
      window.clearTimeout(timer);
    });
  });

  const response = (await Promise.race([runPromise, timeoutPromise])) as PythonWorkerResponse;
  if (!response.ok || response.type !== "run") {
    throw new Error(response.ok ? "Unexpected python response" : response.error);
  }

  applyAbortController = new AbortController();
  try {
    const appliedOps = await executePythonOps(response.ops, {
      signal: applyAbortController.signal,
      onProgress: options?.onApplyProgress,
      onBatch: options?.onApplyBatch
    });
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      appliedOps
    };
  } finally {
    applyAbortController = null;
  }
}

export function stopPythonExecution(): void {
  applyAbortController?.abort();
  stopWorkerInternal();
}
