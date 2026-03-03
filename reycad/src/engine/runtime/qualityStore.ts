import { create } from "zustand";
import { QualityManager, type QualityMode, type QualityLevel, type QualitySnapshot, type QualityProfile } from "../../engine-core/performance/QualityManager";

export type RenderStatsSnapshot = {
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  visibleMeshes: number;
  culledMeshes: number;
  instancedGroups: number;
  lodHigh: number;
  lodMedium: number;
  lodLow: number;
  sceneProfile: "indoor" | "outdoor" | "large-world";
  sceneRadius: number;
  sceneNodeCount: number;
  instancingThreshold: number;
  cullMargin: number;
  lodNearDistance: number;
  lodMidDistance: number;
  updatedAt: string | null;
};

const DEFAULT_RENDER_STATS: RenderStatsSnapshot = {
  drawCalls: 0,
  triangles: 0,
  lines: 0,
  points: 0,
  visibleMeshes: 0,
  culledMeshes: 0,
  instancedGroups: 0,
  lodHigh: 0,
  lodMedium: 0,
  lodLow: 0,
  sceneProfile: "indoor",
  sceneRadius: 0,
  sceneNodeCount: 0,
  instancingThreshold: 3,
  cullMargin: 1.2,
  lodNearDistance: 0,
  lodMidDistance: 0,
  updatedAt: null
};

export type RenderStatsInput = Omit<RenderStatsSnapshot, "updatedAt">;

type QualityStore = {
  mode: QualityMode;
  effectiveLevel: QualityLevel;
  profile: QualityProfile;
  fps: number;
  frameMs: number;
  sampleCount: number;
  transitions: number;
  lastTransitionAt: string | null;
  reason: string | null;
  renderStats: RenderStatsSnapshot;
  setMode: (mode: QualityMode) => void;
  ingestFrameMs: (frameMs: number) => void;
  resetMetrics: () => void;
  setRenderStats: (stats: RenderStatsInput) => void;
};

const qualityManager = new QualityManager();

type QualitySnapshotState = {
  mode: QualityMode;
  effectiveLevel: QualityLevel;
  profile: QualityProfile;
  fps: number;
  frameMs: number;
  sampleCount: number;
  transitions: number;
  lastTransitionAt: string | null;
  reason: string | null;
};

function applySnapshot(snapshot: QualitySnapshot): QualitySnapshotState {
  return {
    mode: snapshot.mode,
    effectiveLevel: snapshot.effectiveLevel,
    profile: snapshot.profile,
    fps: snapshot.metrics.fps,
    frameMs: snapshot.metrics.frameMs,
    sampleCount: snapshot.metrics.sampleCount,
    transitions: snapshot.metrics.transitions,
    lastTransitionAt: snapshot.metrics.lastTransitionAt,
    reason: snapshot.metrics.reason
  };
}

export const useQualityStore = create<QualityStore>((set) => ({
  ...applySnapshot(qualityManager.getSnapshot()),
  renderStats: DEFAULT_RENDER_STATS,
  setMode(mode) {
    const snapshot = qualityManager.setMode(mode);
    set(applySnapshot(snapshot));
  },
  ingestFrameMs(frameMs) {
    const snapshot = qualityManager.observeFrame(frameMs);
    set(applySnapshot(snapshot));
  },
  resetMetrics() {
    const snapshot = qualityManager.resetMetrics();
    set({
      ...applySnapshot(snapshot),
      renderStats: DEFAULT_RENDER_STATS
    });
  },
  setRenderStats(stats) {
    set((state) => {
      const current = state.renderStats;
      if (
        current.drawCalls === stats.drawCalls &&
        current.triangles === stats.triangles &&
        current.lines === stats.lines &&
        current.points === stats.points &&
        current.visibleMeshes === stats.visibleMeshes &&
        current.culledMeshes === stats.culledMeshes &&
        current.instancedGroups === stats.instancedGroups &&
        current.lodHigh === stats.lodHigh &&
        current.lodMedium === stats.lodMedium &&
        current.lodLow === stats.lodLow &&
        current.sceneProfile === stats.sceneProfile &&
        current.sceneRadius === stats.sceneRadius &&
        current.sceneNodeCount === stats.sceneNodeCount &&
        current.instancingThreshold === stats.instancingThreshold &&
        current.cullMargin === stats.cullMargin &&
        current.lodNearDistance === stats.lodNearDistance &&
        current.lodMidDistance === stats.lodMidDistance
      ) {
        return state;
      }

      return {
        renderStats: {
          ...stats,
          updatedAt: new Date().toISOString()
        }
      };
    });
  }
}));

export function getQualitySnapshot(): ReturnType<typeof applySnapshot> {
  return applySnapshot(qualityManager.getSnapshot());
}
