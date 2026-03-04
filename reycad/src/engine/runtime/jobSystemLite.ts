export type RuntimeJobPriority = "critical" | "high" | "normal" | "low";
export type RuntimeJobSubsystem = "physics" | "culling" | "prefetch" | "jobs" | "misc";

export type RuntimeJobSpec = {
  id: string;
  subsystem: RuntimeJobSubsystem;
  priority?: RuntimeJobPriority;
  estimatedMs?: number;
  run: () => void;
};

type QueuedRuntimeJob = {
  id: string;
  subsystem: RuntimeJobSubsystem;
  priorityWeight: number;
  estimatedMs: number;
  run: () => void;
  order: number;
  enqueuedAtMs: number;
};

export type RuntimeJobSystemConfig = {
  maxQueueSize?: number;
};

export type RuntimeJobDrainSummary = {
  executed: number;
  deferred: number;
  dropped: number;
  durationMs: number;
  queueDepth: number;
};

export type RuntimeJobQueueSnapshot = {
  queueDepth: number;
  droppedPending: number;
  byPriority: Record<RuntimeJobPriority, number>;
  bySubsystem: Record<RuntimeJobSubsystem, number>;
};

const DEFAULT_MAX_QUEUE_SIZE = 320;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function clampEstimateMs(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0.25;
  }
  return Math.max(0.01, Math.min(8, value as number));
}

function priorityWeight(priority: RuntimeJobPriority | undefined): number {
  if (priority === "critical") {
    return 4;
  }
  if (priority === "high") {
    return 3;
  }
  if (priority === "normal") {
    return 2;
  }
  return 1;
}

function createPriorityCounter(): Record<RuntimeJobPriority, number> {
  return {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0
  };
}

function createSubsystemCounter(): Record<RuntimeJobSubsystem, number> {
  return {
    physics: 0,
    culling: 0,
    prefetch: 0,
    jobs: 0,
    misc: 0
  };
}

function priorityFromWeight(weight: number): RuntimeJobPriority {
  if (weight >= 4) {
    return "critical";
  }
  if (weight >= 3) {
    return "high";
  }
  if (weight >= 2) {
    return "normal";
  }
  return "low";
}

export class RuntimeJobSystemLite {
  private readonly maxQueueSize: number;
  private readonly queue: QueuedRuntimeJob[] = [];
  private readonly byId = new Map<string, QueuedRuntimeJob>();
  private orderCounter = 0;
  private droppedSinceLastDrain = 0;

  constructor(config: RuntimeJobSystemConfig = {}) {
    const configuredMax = Number.isFinite(config.maxQueueSize) ? (config.maxQueueSize as number) : DEFAULT_MAX_QUEUE_SIZE;
    this.maxQueueSize = Math.max(2, Math.floor(configuredMax));
  }

  enqueue(spec: RuntimeJobSpec): void {
    if (!spec || typeof spec.run !== "function") {
      return;
    }
    const id = typeof spec.id === "string" ? spec.id.trim() : "";
    if (id.length === 0) {
      return;
    }

    const existing = this.byId.get(id);
    if (existing) {
      existing.subsystem = spec.subsystem;
      existing.priorityWeight = Math.max(existing.priorityWeight, priorityWeight(spec.priority));
      existing.estimatedMs = clampEstimateMs(spec.estimatedMs);
      existing.run = spec.run;
      return;
    }

    const queued: QueuedRuntimeJob = {
      id,
      subsystem: spec.subsystem,
      priorityWeight: priorityWeight(spec.priority),
      estimatedMs: clampEstimateMs(spec.estimatedMs),
      run: spec.run,
      order: this.orderCounter++,
      enqueuedAtMs: nowMs()
    };

    this.queue.push(queued);
    this.byId.set(id, queued);
    this.trimQueueToBudget();
  }

  clear(): void {
    this.queue.length = 0;
    this.byId.clear();
    this.droppedSinceLastDrain = 0;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getSnapshot(): RuntimeJobQueueSnapshot {
    const byPriority = createPriorityCounter();
    const bySubsystem = createSubsystemCounter();
    for (const job of this.queue) {
      byPriority[priorityFromWeight(job.priorityWeight)] += 1;
      bySubsystem[job.subsystem] += 1;
    }
    return {
      queueDepth: this.queue.length,
      droppedPending: this.droppedSinceLastDrain,
      byPriority,
      bySubsystem
    };
  }

  drain(maxDurationMs: number): RuntimeJobDrainSummary {
    const budgetMs = Number.isFinite(maxDurationMs) ? Math.max(0, maxDurationMs) : 0;
    if (this.queue.length === 0 || budgetMs <= 0) {
      const dropped = this.droppedSinceLastDrain;
      this.droppedSinceLastDrain = 0;
      return {
        executed: 0,
        deferred: this.queue.length,
        dropped,
        durationMs: 0,
        queueDepth: this.queue.length
      };
    }

    this.queue.sort((a, b) => {
      if (a.priorityWeight !== b.priorityWeight) {
        return b.priorityWeight - a.priorityWeight;
      }
      return a.order - b.order;
    });

    const startedAt = nowMs();
    let executed = 0;

    while (this.queue.length > 0) {
      const elapsed = nowMs() - startedAt;
      if (elapsed >= budgetMs) {
        break;
      }

      const job = this.queue.shift();
      if (!job) {
        break;
      }
      this.byId.delete(job.id);
      try {
        job.run();
      } catch (error) {
        console.warn(`[job-system] ${job.id} failed: ${String(error)}`);
      }
      executed += 1;
    }

    const dropped = this.droppedSinceLastDrain;
    this.droppedSinceLastDrain = 0;
    const durationMs = Math.max(0, nowMs() - startedAt);
    return {
      executed,
      deferred: this.queue.length,
      dropped,
      durationMs: Number(durationMs.toFixed(3)),
      queueDepth: this.queue.length
    };
  }

  private trimQueueToBudget(): void {
    while (this.queue.length > this.maxQueueSize) {
      let dropIndex = 0;
      for (let index = 1; index < this.queue.length; index += 1) {
        const current = this.queue[index];
        const candidate = this.queue[dropIndex];
        if (current.priorityWeight < candidate.priorityWeight) {
          dropIndex = index;
          continue;
        }
        if (current.priorityWeight === candidate.priorityWeight && current.order < candidate.order) {
          dropIndex = index;
        }
      }
      const dropped = this.queue.splice(dropIndex, 1)[0];
      if (dropped) {
        this.byId.delete(dropped.id);
        this.droppedSinceLastDrain += 1;
      }
    }
  }
}
