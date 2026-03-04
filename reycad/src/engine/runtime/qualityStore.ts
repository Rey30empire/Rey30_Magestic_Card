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
  cpuFrameBudgetMs: number;
  cpuFrameUsedMs: number;
  cpuFrameRemainingMs: number;
  cpuPressure: number;
  gpuPressure: number;
  jobQueueDepth: number;
  jobsExecuted: number;
  jobsDeferred: number;
  jobsDropped: number;
  physicsBudgetMs: number;
  physicsUsedMs: number;
  physicsDeferred: number;
  cullingBudgetMs: number;
  cullingUsedMs: number;
  cullingDeferred: number;
  prefetchBudgetMs: number;
  prefetchUsedMs: number;
  prefetchDeferred: number;
  jobSystemBudgetMs: number;
  jobSystemUsedMs: number;
  jobSystemDeferred: number;
  miscBudgetMs: number;
  miscUsedMs: number;
  miscDeferred: number;
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
  cpuFrameBudgetMs: 0,
  cpuFrameUsedMs: 0,
  cpuFrameRemainingMs: 0,
  cpuPressure: 0,
  gpuPressure: 0,
  jobQueueDepth: 0,
  jobsExecuted: 0,
  jobsDeferred: 0,
  jobsDropped: 0,
  physicsBudgetMs: 0,
  physicsUsedMs: 0,
  physicsDeferred: 0,
  cullingBudgetMs: 0,
  cullingUsedMs: 0,
  cullingDeferred: 0,
  prefetchBudgetMs: 0,
  prefetchUsedMs: 0,
  prefetchDeferred: 0,
  jobSystemBudgetMs: 0,
  jobSystemUsedMs: 0,
  jobSystemDeferred: 0,
  miscBudgetMs: 0,
  miscUsedMs: 0,
  miscDeferred: 0,
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

export type QualityStore = {
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

export function createQualityStore(manager: QualityManager = new QualityManager()) {
  return create<QualityStore>((set) => ({
    ...applySnapshot(manager.getSnapshot()),
    renderStats: DEFAULT_RENDER_STATS,
    assetStats: DEFAULT_ASSET_STATS,
    setMode(mode) {
      const snapshot = manager.setMode(mode);
      set(applySnapshot(snapshot));
    },
    ingestFrameMs(frameMs) {
      const snapshot = manager.observeFrame(frameMs);
      set(applySnapshot(snapshot));
    },
    resetMetrics() {
      const snapshot = manager.resetMetrics();
      set({
        ...applySnapshot(snapshot),
        renderStats: DEFAULT_RENDER_STATS,
        assetStats: DEFAULT_ASSET_STATS
      });
    },
    setRenderStats(stats) {
      const budgetSnapshot = manager.observeBudgetAlert(stats.budgetAlert);
      const qualityState = applySnapshot(budgetSnapshot);

      set((state) => {
        const current = state.renderStats;
        const renderUnchanged =
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
          current.lodMidDistance === stats.lodMidDistance &&
          current.cpuFrameBudgetMs === stats.cpuFrameBudgetMs &&
          current.cpuFrameUsedMs === stats.cpuFrameUsedMs &&
          current.cpuFrameRemainingMs === stats.cpuFrameRemainingMs &&
          current.cpuPressure === stats.cpuPressure &&
          current.gpuPressure === stats.gpuPressure &&
          current.jobQueueDepth === stats.jobQueueDepth &&
          current.jobsExecuted === stats.jobsExecuted &&
          current.jobsDeferred === stats.jobsDeferred &&
          current.jobsDropped === stats.jobsDropped &&
          current.physicsBudgetMs === stats.physicsBudgetMs &&
          current.physicsUsedMs === stats.physicsUsedMs &&
          current.physicsDeferred === stats.physicsDeferred &&
          current.cullingBudgetMs === stats.cullingBudgetMs &&
          current.cullingUsedMs === stats.cullingUsedMs &&
          current.cullingDeferred === stats.cullingDeferred &&
          current.prefetchBudgetMs === stats.prefetchBudgetMs &&
          current.prefetchUsedMs === stats.prefetchUsedMs &&
          current.prefetchDeferred === stats.prefetchDeferred &&
          current.jobSystemBudgetMs === stats.jobSystemBudgetMs &&
          current.jobSystemUsedMs === stats.jobSystemUsedMs &&
          current.jobSystemDeferred === stats.jobSystemDeferred &&
          current.miscBudgetMs === stats.miscBudgetMs &&
          current.miscUsedMs === stats.miscUsedMs &&
          current.miscDeferred === stats.miscDeferred;

        const qualityUnchanged =
          state.mode === qualityState.mode &&
          state.effectiveLevel === qualityState.effectiveLevel &&
          state.profile.dpr === qualityState.profile.dpr &&
          state.profile.shadows === qualityState.profile.shadows &&
          state.profile.antialias === qualityState.profile.antialias &&
          state.profile.powerPreference === qualityState.profile.powerPreference &&
          state.profile.csgDetail === qualityState.profile.csgDetail &&
          state.fps === qualityState.fps &&
          state.frameMs === qualityState.frameMs &&
          state.sampleCount === qualityState.sampleCount &&
          state.transitions === qualityState.transitions &&
          state.lastTransitionAt === qualityState.lastTransitionAt &&
          state.reason === qualityState.reason;

        if (renderUnchanged && qualityUnchanged) {
          return state;
        }

        const nextState: Partial<QualityStore> = {};
        if (!qualityUnchanged) {
          Object.assign(nextState, qualityState);
        }
        if (!renderUnchanged) {
          nextState.renderStats = {
            ...stats,
            updatedAt: new Date().toISOString()
          };
        }
        return nextState;
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
}

const qualityManager = new QualityManager();
export const useQualityStore = createQualityStore(qualityManager);

export function getQualitySnapshot(): ReturnType<typeof applySnapshot> {
  return applySnapshot(qualityManager.getSnapshot());
}
