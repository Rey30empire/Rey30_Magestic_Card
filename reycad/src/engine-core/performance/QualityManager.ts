export type QualityLevel = "low" | "medium" | "high" | "ultra";
export type QualityMode = QualityLevel | "auto";

export type QualityProfile = {
  dpr: number;
  shadows: boolean;
  antialias: boolean;
  powerPreference: "default" | "high-performance" | "low-power";
  csgDetail: "low" | "normal" | "high";
};

export type QualitySnapshot = {
  mode: QualityMode;
  effectiveLevel: QualityLevel;
  profile: QualityProfile;
  metrics: {
    fps: number;
    frameMs: number;
    sampleCount: number;
    transitions: number;
    lastTransitionAt: string | null;
    reason: string | null;
  };
};

export type QualityManagerConfig = {
  minSampleCount?: number;
  maxSampleCount?: number;
  transitionCooldownMs?: number;
};

const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    dpr: 0.7,
    shadows: false,
    antialias: false,
    powerPreference: "low-power",
    csgDetail: "low"
  },
  medium: {
    dpr: 0.85,
    shadows: false,
    antialias: true,
    powerPreference: "default",
    csgDetail: "normal"
  },
  high: {
    dpr: 1,
    shadows: true,
    antialias: true,
    powerPreference: "high-performance",
    csgDetail: "normal"
  },
  ultra: {
    dpr: 1.25,
    shadows: true,
    antialias: true,
    powerPreference: "high-performance",
    csgDetail: "high"
  }
};

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function estimateAutoLevel(fps: number): QualityLevel {
  if (fps < 30) {
    return "low";
  }
  if (fps < 45) {
    return "medium";
  }
  if (fps < 58) {
    return "high";
  }
  return "ultra";
}

export class QualityManager {
  private mode: QualityMode = "auto";
  private effectiveLevel: QualityLevel = "high";
  private sampleFrames: number[] = [];
  private avgFrameMs = 16.67;
  private avgFps = 60;
  private transitions = 0;
  private lastTransitionAt: string | null = null;
  private lastTransitionReason: string | null = null;
  private lastSwitchAtMs = 0;
  private readonly minSampleCount: number;
  private readonly maxSampleCount: number;
  private readonly transitionCooldownMs: number;

  constructor(config: QualityManagerConfig = {}) {
    this.minSampleCount = Math.max(4, Math.floor(config.minSampleCount ?? 36));
    this.maxSampleCount = Math.max(this.minSampleCount, Math.floor(config.maxSampleCount ?? 120));
    this.transitionCooldownMs = Math.max(0, config.transitionCooldownMs ?? 3500);
  }

  setMode(mode: QualityMode): QualitySnapshot {
    this.mode = mode;
    if (mode !== "auto") {
      this.setEffectiveLevel(mode, `manual:${mode}`);
    } else {
      const target = estimateAutoLevel(this.avgFps);
      this.setEffectiveLevel(target, `auto:${target}`);
    }
    return this.getSnapshot();
  }

  observeFrame(frameMs: number): QualitySnapshot {
    if (!Number.isFinite(frameMs) || frameMs <= 0) {
      return this.getSnapshot();
    }

    this.sampleFrames.push(frameMs);
    if (this.sampleFrames.length > this.maxSampleCount) {
      this.sampleFrames.shift();
    }

    const alpha = 0.12;
    this.avgFrameMs = this.avgFrameMs + (frameMs - this.avgFrameMs) * alpha;
    this.avgFps = this.avgFps + (1000 / Math.max(0.001, frameMs) - this.avgFps) * alpha;

    if (this.mode === "auto") {
      this.updateAutoLevel();
    }

    return this.getSnapshot();
  }

  resetMetrics(): QualitySnapshot {
    this.sampleFrames = [];
    this.avgFrameMs = 16.67;
    this.avgFps = 60;
    this.lastTransitionReason = null;
    this.lastTransitionAt = null;
    this.lastSwitchAtMs = 0;
    this.transitions = 0;
    if (this.mode === "auto") {
      this.setEffectiveLevel("high", "auto:reset");
    }
    return this.getSnapshot();
  }

  getSnapshot(): QualitySnapshot {
    return {
      mode: this.mode,
      effectiveLevel: this.effectiveLevel,
      profile: QUALITY_PROFILES[this.effectiveLevel],
      metrics: {
        fps: Number(this.avgFps.toFixed(2)),
        frameMs: Number(this.avgFrameMs.toFixed(2)),
        sampleCount: this.sampleFrames.length,
        transitions: this.transitions,
        lastTransitionAt: this.lastTransitionAt,
        reason: this.lastTransitionReason
      }
    };
  }

  private updateAutoLevel(): void {
    if (this.sampleFrames.length < this.minSampleCount) {
      return;
    }

    const elapsed = nowMs() - this.lastSwitchAtMs;
    if (elapsed < this.transitionCooldownMs) {
      return;
    }

    const avgFrame = this.sampleFrames.reduce((acc, value) => acc + value, 0) / this.sampleFrames.length;
    const avgFps = 1000 / Math.max(avgFrame, 0.001);
    const nextLevel = estimateAutoLevel(avgFps);
    if (nextLevel === this.effectiveLevel) {
      return;
    }
    this.setEffectiveLevel(nextLevel, `auto:${nextLevel} fps=${avgFps.toFixed(1)}`);
  }

  private setEffectiveLevel(level: QualityLevel, reason: string): void {
    if (this.effectiveLevel === level && this.lastTransitionReason === reason) {
      return;
    }

    this.effectiveLevel = level;
    this.transitions += 1;
    this.lastSwitchAtMs = nowMs();
    this.lastTransitionAt = new Date().toISOString();
    this.lastTransitionReason = reason;
  }
}
