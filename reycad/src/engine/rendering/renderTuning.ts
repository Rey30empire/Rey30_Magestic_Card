import type { QualityLevel } from "../../engine-core/performance/QualityManager";
import type { RenderPrimitive } from "../scenegraph/evaluator";
import type { GeometryLodLevel } from "./geometry";

export type SceneRenderProfile = "indoor" | "outdoor" | "large-world";

export type LodDistanceProfile = {
  near: number;
  mid: number;
};

export type SceneRuntimeProfile = {
  sceneProfile: SceneRenderProfile;
  sceneRadius: number;
  sceneNodeCount: number;
  lodDistances: LodDistanceProfile;
  cullBaseMargin: number;
  cullGraceMs: number;
  instancingThreshold: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveSceneProfile(sceneRadius: number, nodeCount: number): SceneRenderProfile {
  if (sceneRadius > 340 || nodeCount > 1100) {
    return "large-world";
  }
  if (sceneRadius > 130 || nodeCount > 260) {
    return "outdoor";
  }
  return "indoor";
}

export function resolveLodDistances(
  sceneProfile: SceneRenderProfile,
  qualityLevel: QualityLevel,
  sceneRadius: number,
  nodeCount: number
): LodDistanceProfile {
  const baseByScene: Record<SceneRenderProfile, Record<QualityLevel, LodDistanceProfile>> = {
    indoor: {
      low: { near: 18, mid: 48 },
      medium: { near: 24, mid: 62 },
      high: { near: 30, mid: 80 },
      ultra: { near: 38, mid: 98 }
    },
    outdoor: {
      low: { near: 38, mid: 98 },
      medium: { near: 52, mid: 132 },
      high: { near: 68, mid: 172 },
      ultra: { near: 84, mid: 214 }
    },
    "large-world": {
      low: { near: 72, mid: 186 },
      medium: { near: 96, mid: 246 },
      high: { near: 124, mid: 320 },
      ultra: { near: 156, mid: 396 }
    }
  };

  const referenceRadiusByScene: Record<SceneRenderProfile, number> = {
    indoor: 58,
    outdoor: 170,
    "large-world": 430
  };

  const densityScale = nodeCount > 1200 ? 0.72 : nodeCount > 700 ? 0.82 : nodeCount > 360 ? 0.9 : 1;
  const radiusScale = clamp(sceneRadius / referenceRadiusByScene[sceneProfile], 0.7, 1.85);

  const base = baseByScene[sceneProfile][qualityLevel];
  return {
    near: Number((base.near * radiusScale * densityScale).toFixed(2)),
    mid: Number((base.mid * radiusScale * densityScale).toFixed(2))
  };
}

export function resolveInstancingThreshold(sceneProfile: SceneRenderProfile, nodeCount: number): number {
  if (sceneProfile === "large-world") {
    return 2;
  }
  if (sceneProfile === "outdoor") {
    return nodeCount > 450 ? 2 : 3;
  }
  return nodeCount > 700 ? 2 : 3;
}

export function resolveCullBaseMargin(sceneProfile: SceneRenderProfile): number {
  if (sceneProfile === "indoor") {
    return 1.32;
  }
  if (sceneProfile === "outdoor") {
    return 1.2;
  }
  return 1.12;
}

export function resolveCullGraceMs(sceneProfile: SceneRenderProfile, qualityLevel: QualityLevel): number {
  const sceneBase: Record<SceneRenderProfile, number> = {
    indoor: 180,
    outdoor: 130,
    "large-world": 90
  };
  const qualityBonus: Record<QualityLevel, number> = {
    low: 70,
    medium: 45,
    high: 25,
    ultra: 10
  };

  return sceneBase[sceneProfile] + qualityBonus[qualityLevel];
}

export function resolveLodLevel(distance: number, lod: LodDistanceProfile): GeometryLodLevel {
  if (distance <= lod.near) {
    return "high";
  }
  if (distance <= lod.mid) {
    return "medium";
  }
  return "low";
}

function primitiveRadius(item: RenderPrimitive): number {
  switch (item.primitive) {
    case "box":
      return Math.hypot(item.params.w * 0.5, item.params.h * 0.5, item.params.d * 0.5);
    case "cylinder": {
      const radius = Math.max(item.params.rTop, item.params.rBottom);
      return Math.hypot(radius, item.params.h * 0.5);
    }
    case "sphere":
      return item.params.r;
    case "cone":
      return Math.hypot(item.params.r, item.params.h * 0.5);
    case "text":
      return Math.hypot(Math.max(2, item.params.text.length * item.params.size * 0.6) * 0.5, item.params.size * 0.5, Math.max(0.4, item.params.height) * 0.5);
    case "terrain":
      return Math.hypot(item.params.w * 0.5, Math.max(2, item.params.heightScale * 2) * 0.5, item.params.d * 0.5);
    default:
      return 8;
  }
}

export function primitiveScaleRadius(item: RenderPrimitive): number {
  const maxScale = Math.max(Math.abs(item.transform.scale[0]), Math.abs(item.transform.scale[1]), Math.abs(item.transform.scale[2]), 0.001);
  return primitiveRadius(item) * maxScale;
}

export function computeSceneRuntimeProfile(items: RenderPrimitive[], qualityLevel: QualityLevel): SceneRuntimeProfile {
  if (items.length === 0) {
    const sceneProfile: SceneRenderProfile = "indoor";
    return {
      sceneProfile,
      sceneRadius: 0,
      sceneNodeCount: 0,
      lodDistances: resolveLodDistances(sceneProfile, qualityLevel, 0, 0),
      cullBaseMargin: resolveCullBaseMargin(sceneProfile),
      cullGraceMs: resolveCullGraceMs(sceneProfile, qualityLevel),
      instancingThreshold: resolveInstancingThreshold(sceneProfile, 0)
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const radius = primitiveScaleRadius(item);
    const x = item.transform.position[0];
    const y = item.transform.position[1];
    const z = item.transform.position[2];

    minX = Math.min(minX, x - radius);
    minY = Math.min(minY, y - radius);
    minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius);
    maxY = Math.max(maxY, y + radius);
    maxZ = Math.max(maxZ, z + radius);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const sceneRadius = Number((Math.hypot(spanX, spanY, spanZ) * 0.5).toFixed(2));
  const sceneNodeCount = items.length;
  const sceneProfile = resolveSceneProfile(sceneRadius, sceneNodeCount);

  return {
    sceneProfile,
    sceneRadius,
    sceneNodeCount,
    lodDistances: resolveLodDistances(sceneProfile, qualityLevel, sceneRadius, sceneNodeCount),
    cullBaseMargin: resolveCullBaseMargin(sceneProfile),
    cullGraceMs: resolveCullGraceMs(sceneProfile, qualityLevel),
    instancingThreshold: resolveInstancingThreshold(sceneProfile, sceneNodeCount)
  };
}
