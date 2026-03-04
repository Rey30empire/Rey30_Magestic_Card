export type FrameBudgetSubsystem = "physics" | "culling" | "prefetch" | "jobs" | "misc";

export type FrameBudgetReserve = {
  granted: boolean;
  allowanceMs: number;
};

export type FrameBudgetSubsystemSnapshot = {
  budgetMs: number;
  usedMs: number;
  remainingMs: number;
  deferred: number;
  overBudget: boolean;
};

export type FrameBudgetSnapshot = {
  frameBudgetMs: number;
  frameUsedMs: number;
  frameRemainingMs: number;
  cpuPressure: number;
  gpuPressure: number;
  subsystems: Record<FrameBudgetSubsystem, FrameBudgetSubsystemSnapshot>;
};

export type FrameBudgetSchedulerConfig = {
  minFrameBudgetMs?: number;
  maxFrameBudgetMs?: number;
  weights?: Partial<Record<FrameBudgetSubsystem, number>>;
};

type SubsystemMap = Record<FrameBudgetSubsystem, number>;

const DEFAULT_WEIGHTS: SubsystemMap = {
  physics: 0.31,
  culling: 0.27,
  prefetch: 0.12,
  jobs: 0.2,
  misc: 0.1
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createSubsystemMap(seed = 0): SubsystemMap {
  return {
    physics: seed,
    culling: seed,
    prefetch: seed,
    jobs: seed,
    misc: seed
  };
}

function normalizeWeights(input: SubsystemMap): SubsystemMap {
  const sum = input.physics + input.culling + input.prefetch + input.jobs + input.misc;
  if (!Number.isFinite(sum) || sum <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  return {
    physics: input.physics / sum,
    culling: input.culling / sum,
    prefetch: input.prefetch / sum,
    jobs: input.jobs / sum,
    misc: input.misc / sum
  };
}

export class FrameBudgetScheduler {
  private readonly minFrameBudgetMs: number;
  private readonly maxFrameBudgetMs: number;
  private readonly weights: SubsystemMap;
  private readonly budgets = createSubsystemMap();
  private readonly used = createSubsystemMap();
  private readonly deferred = createSubsystemMap();
  private frameBudgetMs = 16.67;
  private gpuPressure = 1;

  constructor(config: FrameBudgetSchedulerConfig = {}) {
    const minFrameBudgetMs = Number.isFinite(config.minFrameBudgetMs) ? (config.minFrameBudgetMs as number) : 8;
    const maxFrameBudgetMs = Number.isFinite(config.maxFrameBudgetMs) ? (config.maxFrameBudgetMs as number) : 33.34;
    this.minFrameBudgetMs = Math.max(2, minFrameBudgetMs);
    this.maxFrameBudgetMs = Math.max(this.minFrameBudgetMs, maxFrameBudgetMs);

    const mergedWeights: SubsystemMap = {
      physics: config.weights?.physics ?? DEFAULT_WEIGHTS.physics,
      culling: config.weights?.culling ?? DEFAULT_WEIGHTS.culling,
      prefetch: config.weights?.prefetch ?? DEFAULT_WEIGHTS.prefetch,
      jobs: config.weights?.jobs ?? DEFAULT_WEIGHTS.jobs,
      misc: config.weights?.misc ?? DEFAULT_WEIGHTS.misc
    };
    this.weights = normalizeWeights(mergedWeights);
  }

  beginFrame(frameBudgetMs: number, gpuPressure = 1): void {
    const nextFrameBudget = Number.isFinite(frameBudgetMs) ? (frameBudgetMs as number) : this.frameBudgetMs;
    this.frameBudgetMs = clamp(nextFrameBudget, this.minFrameBudgetMs, this.maxFrameBudgetMs);
    this.gpuPressure = clamp(Number.isFinite(gpuPressure) ? gpuPressure : 1, 0.25, 3);

    this.used.physics = 0;
    this.used.culling = 0;
    this.used.prefetch = 0;
    this.used.jobs = 0;
    this.used.misc = 0;

    this.deferred.physics = 0;
    this.deferred.culling = 0;
    this.deferred.prefetch = 0;
    this.deferred.jobs = 0;
    this.deferred.misc = 0;

    const opportunisticScale = clamp(1.2 - (this.gpuPressure - 1) * 0.6, 0.35, 1.15);
    this.budgets.physics = Number((this.frameBudgetMs * this.weights.physics).toFixed(3));
    this.budgets.culling = Number((this.frameBudgetMs * this.weights.culling).toFixed(3));
    this.budgets.prefetch = Number((this.frameBudgetMs * this.weights.prefetch * opportunisticScale).toFixed(3));
    this.budgets.jobs = Number((this.frameBudgetMs * this.weights.jobs * opportunisticScale).toFixed(3));
    this.budgets.misc = Number((this.frameBudgetMs * this.weights.misc * opportunisticScale).toFixed(3));
  }

  reserve(subsystem: FrameBudgetSubsystem, estimatedMs = 0.25): FrameBudgetReserve {
    const estimate = Number.isFinite(estimatedMs) ? Math.max(0.01, estimatedMs) : 0.25;
    const subsystemRemaining = this.budgets[subsystem] - this.used[subsystem];
    const frameRemaining = this.frameBudgetMs - this.totalUsedMs();
    const allowance = Math.max(0, Math.min(subsystemRemaining, frameRemaining));
    if (allowance <= 0 || allowance + 1e-6 < estimate) {
      this.deferred[subsystem] += 1;
      return { granted: false, allowanceMs: Number(allowance.toFixed(3)) };
    }
    return { granted: true, allowanceMs: Number(allowance.toFixed(3)) };
  }

  recordUsage(subsystem: FrameBudgetSubsystem, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    this.used[subsystem] += durationMs;
  }

  markDeferred(subsystem: FrameBudgetSubsystem, count = 1): void {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }
    this.deferred[subsystem] += Math.floor(count);
  }

  getSnapshot(): FrameBudgetSnapshot {
    const frameUsedMs = this.totalUsedMs();
    const frameRemainingMs = Math.max(0, this.frameBudgetMs - frameUsedMs);
    return {
      frameBudgetMs: Number(this.frameBudgetMs.toFixed(3)),
      frameUsedMs: Number(frameUsedMs.toFixed(3)),
      frameRemainingMs: Number(frameRemainingMs.toFixed(3)),
      cpuPressure: Number((frameUsedMs / Math.max(0.001, this.frameBudgetMs)).toFixed(3)),
      gpuPressure: Number(this.gpuPressure.toFixed(3)),
      subsystems: {
        physics: this.snapshotFor("physics"),
        culling: this.snapshotFor("culling"),
        prefetch: this.snapshotFor("prefetch"),
        jobs: this.snapshotFor("jobs"),
        misc: this.snapshotFor("misc")
      }
    };
  }

  private snapshotFor(subsystem: FrameBudgetSubsystem): FrameBudgetSubsystemSnapshot {
    const budgetMs = Number(this.budgets[subsystem].toFixed(3));
    const usedMs = Number(this.used[subsystem].toFixed(3));
    const remainingMs = Number(Math.max(0, budgetMs - usedMs).toFixed(3));
    return {
      budgetMs,
      usedMs,
      remainingMs,
      deferred: this.deferred[subsystem],
      overBudget: usedMs > budgetMs + 1e-3
    };
  }

  private totalUsedMs(): number {
    return this.used.physics + this.used.culling + this.used.prefetch + this.used.jobs + this.used.misc;
  }
}
