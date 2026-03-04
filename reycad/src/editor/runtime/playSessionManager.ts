import { createId } from "../../lib/ids";
import type { EditorData } from "../state/types";

export type PlayStopReason = "user_stop" | "panic" | "max_duration" | "project_reload";

type ActivePlaySession = {
  id: string;
  startedAt: string;
  startedAtMs: number;
  maxDurationMs: number;
  blockedCommands: number;
  snapshot: EditorData;
};

export type PlaySessionState = {
  isPlaying: boolean;
  sessionId: string | null;
  startedAt: string | null;
  elapsedMs: number;
  maxDurationMs: number;
  blockedCommands: number;
};

export type PlaySessionStartResult = {
  sessionId: string;
  startedAt: string;
  maxDurationMs: number;
  playData: EditorData;
};

export type PlaySessionStopResult = {
  sessionId: string;
  reason: PlayStopReason;
  elapsedMs: number;
  blockedCommands: number;
  restoredData: EditorData;
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
type NowProvider = () => number;
type IsoTimestampProvider = () => string;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function cloneData(data: EditorData): EditorData {
  if (typeof structuredClone === "function") {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data)) as EditorData;
}

function withLog(data: EditorData, message: string): EditorData {
  return {
    ...data,
    logs: [...data.logs, message]
  };
}

export class PlaySessionManager {
  private active: ActivePlaySession | null = null;
  private readonly defaultMaxDurationMs: number;
  private readonly nowProvider: NowProvider;
  private readonly timestampProvider: IsoTimestampProvider;

  constructor(
    defaultMaxDurationMs = DEFAULT_MAX_DURATION_MS,
    nowProvider: NowProvider = nowMs,
    timestampProvider: IsoTimestampProvider = () => new Date().toISOString()
  ) {
    this.defaultMaxDurationMs = Math.max(10_000, Math.floor(defaultMaxDurationMs));
    this.nowProvider = nowProvider;
    this.timestampProvider = timestampProvider;
  }

  private buildPlayData(data: EditorData, logMessage: string): EditorData {
    const playData = cloneData(data);
    playData.project.physics = {
      ...playData.project.physics,
      enabled: true,
      simulate: true,
      runtimeMode: "arena"
    };
    return withLog(playData, logMessage);
  }

  start(data: EditorData, maxDurationMs?: number): PlaySessionStartResult | null {
    if (this.active) {
      return null;
    }

    const startedAtMs = this.nowProvider();
    const startedAt = this.timestampProvider();
    const sessionId = createId("play");
    const resolvedMaxDurationMs = Number.isFinite(maxDurationMs) ? Math.max(10_000, Math.floor(maxDurationMs as number)) : this.defaultMaxDurationMs;
    const snapshot = cloneData(data);
    const playData = this.buildPlayData(data, `[play] started session=${sessionId}`);

    this.active = {
      id: sessionId,
      startedAt,
      startedAtMs,
      maxDurationMs: resolvedMaxDurationMs,
      blockedCommands: 0,
      snapshot
    };

    return {
      sessionId,
      startedAt,
      maxDurationMs: resolvedMaxDurationMs,
      playData
    };
  }

  stop(reason: PlayStopReason): PlaySessionStopResult | null {
    const session = this.active;
    if (!session) {
      return null;
    }

    const elapsedMs = Math.max(0, this.nowProvider() - session.startedAtMs);
    const restored = withLog(cloneData(session.snapshot), `[play] stopped reason=${reason} elapsedMs=${elapsedMs.toFixed(0)} blocked=${session.blockedCommands}`);
    this.active = null;

    return {
      sessionId: session.id,
      reason,
      elapsedMs,
      blockedCommands: session.blockedCommands,
      restoredData: restored
    };
  }

  tick(): { elapsedMs: number; shouldAutoStop: boolean } {
    const session = this.active;
    if (!session) {
      return { elapsedMs: 0, shouldAutoStop: false };
    }

    const elapsedMs = Math.max(0, this.nowProvider() - session.startedAtMs);
    return {
      elapsedMs,
      shouldAutoStop: elapsedMs >= session.maxDurationMs
    };
  }

  hardResetScene(): EditorData | null {
    const session = this.active;
    if (!session) {
      return null;
    }
    return this.buildPlayData(session.snapshot, `[play] hard-reset session=${session.id}`);
  }

  incrementBlockedCommands(): number {
    if (!this.active) {
      return 0;
    }
    this.active.blockedCommands += 1;
    return this.active.blockedCommands;
  }

  getState(): PlaySessionState {
    const session = this.active;
    if (!session) {
      return {
        isPlaying: false,
        sessionId: null,
        startedAt: null,
        elapsedMs: 0,
        maxDurationMs: this.defaultMaxDurationMs,
        blockedCommands: 0
      };
    }
    const elapsedMs = Math.max(0, this.nowProvider() - session.startedAtMs);
    return {
      isPlaying: true,
      sessionId: session.id,
      startedAt: session.startedAt,
      elapsedMs,
      maxDurationMs: session.maxDurationMs,
      blockedCommands: session.blockedCommands
    };
  }

  reset(): void {
    this.active = null;
  }
}
