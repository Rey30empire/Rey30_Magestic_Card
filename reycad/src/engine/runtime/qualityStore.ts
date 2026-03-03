import { create } from "zustand";
import { QualityManager, type QualityMode, type QualityLevel, type QualitySnapshot, type QualityProfile } from "../../engine-core/performance/QualityManager";

export type RenderStatsSnapshot = {
  drawCalls: number;
  triangles: number;
  budgetDrawCallsTarget: number;
  budgetTrianglesTarget: number;
  budgetDrawCallUsage: number;
  budgetTriangleUsage: number;
  budgetAlert: "ok" | "warn" | "critical";
  lines: number;
  points: number;
  visibleMeshes: number;
  culledMeshes: number;
  instancedGroups: number;
  staticBatchGroups: number;
  staticBatchMeshes: number;
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
  budgetDrawCallsTarget: 0,
  budgetTrianglesTarget: 0,
  budgetDrawCallUsage: 0,
  budgetTriangleUsage: 0,
  budgetAlert: "ok",
  lines: 0,
  points: 0,
  visibleMeshes: 0,
  culledMeshes: 0,
  instancedGroups: 0,
  staticBatchGroups: 0,
  staticBatchMeshes: 0,
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

export type AssetStatsSnapshot = {
  manifestEntries: number;
  cacheEntries: number;
  queuedLoads: number;
  activeLoads: number;
  bytesUsed: number;
  bytesBudget: number;
  hits: number;
  misses: number;
  completedLoads: number;
  failedLoads: number;
  evictions: number;
  prefetchQueued: number;
  updatedAt: string | null;
};

export type AssetStatsInput = Omit<AssetStatsSnapshot, "updatedAt">;

const DEFAULT_ASSET_STATS: AssetStatsSnapshot = {
  manifestEntries: 0,
  cacheEntries: 0,
  queuedLoads: 0,
  activeLoads: 0,
  bytesUsed: 0,
  bytesBudget: 0,
  hits: 0,
  misses: 0,
  completedLoads: 0,
  failedLoads: 0,
  evictions: 0,
  prefetchQueued: 0,
  updatedAt: null
};

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
  assetStats: AssetStatsSnapshot;
  setMode: (mode: QualityMode) => void;
  ingestFrameMs: (frameMs: number) => void;
  resetMetrics: () => void;
  setRenderStats: (stats: RenderStatsInput) => void;
  setAssetStats: (stats: AssetStatsInput) => void;
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
  assetStats: DEFAULT_ASSET_STATS,
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
      renderStats: DEFAULT_RENDER_STATS,
      assetStats: DEFAULT_ASSET_STATS
    });
  },
  setRenderStats(stats) {
    set((state) => {
      const current = state.renderStats;
      if (
        current.drawCalls === stats.drawCalls &&
        current.triangles === stats.triangles &&
        current.budgetDrawCallsTarget === stats.budgetDrawCallsTarget &&
        current.budgetTrianglesTarget === stats.budgetTrianglesTarget &&
        current.budgetDrawCallUsage === stats.budgetDrawCallUsage &&
        current.budgetTriangleUsage === stats.budgetTriangleUsage &&
        current.budgetAlert === stats.budgetAlert &&
        current.lines === stats.lines &&
        current.points === stats.points &&
        current.visibleMeshes === stats.visibleMeshes &&
        current.culledMeshes === stats.culledMeshes &&
        current.instancedGroups === stats.instancedGroups &&
        current.staticBatchGroups === stats.staticBatchGroups &&
        current.staticBatchMeshes === stats.staticBatchMeshes &&
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
  },
  setAssetStats(stats) {
    set((state) => {
      const current = state.assetStats;
      if (
        current.manifestEntries === stats.manifestEntries &&
        current.cacheEntries === stats.cacheEntries &&
        current.queuedLoads === stats.queuedLoads &&
        current.activeLoads === stats.activeLoads &&
        current.bytesUsed === stats.bytesUsed &&
        current.bytesBudget === stats.bytesBudget &&
        current.hits === stats.hits &&
        current.misses === stats.misses &&
        current.completedLoads === stats.completedLoads &&
        current.failedLoads === stats.failedLoads &&
        current.evictions === stats.evictions &&
        current.prefetchQueued === stats.prefetchQueued
      ) {
        return state;
      }

      return {
        assetStats: {
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
