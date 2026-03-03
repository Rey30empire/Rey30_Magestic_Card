import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, PlaneGeometry, Shape, SphereGeometry } from "three";
import type { RenderPrimitive } from "../scenegraph/evaluator";

export type GeometryLodLevel = "high" | "medium" | "low";

const geometryCache = new Map<string, BufferGeometry>();

function fract(value: number): number {
  return value - Math.floor(value);
}

function hash2(x: number, y: number, seed: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return fract(value);
}

function smoothNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fract(x);
  const ty = fract(y);

  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);

  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function terrainHeight(x: number, z: number, seed: number): number {
  let amplitude = 1;
  let frequency = 0.02;
  let total = 0;
  let totalAmplitude = 0;

  for (let octave = 0; octave < 4; octave += 1) {
    const sample = smoothNoise(x * frequency, z * frequency, seed + octave * 47);
    total += (sample * 2 - 1) * amplitude;
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return totalAmplitude > 0 ? total / totalAmplitude : 0;
}

function lodFactor(level: GeometryLodLevel): number {
  if (level === "low") {
    return 0.35;
  }
  if (level === "medium") {
    return 0.65;
  }
  return 1;
}

function lodSegments(value: number, level: GeometryLodLevel, minValue = 3): number {
  const base = Number.isFinite(value) ? Math.floor(value) : minValue;
  return Math.max(minValue, Math.floor(base * lodFactor(level)));
}

function buildTerrainGeometry(item: RenderPrimitive, level: GeometryLodLevel): PlaneGeometry {
  const params = item.params as { w: number; d: number; segments: number; heightSeed: number; heightScale: number };
  const width = Math.max(10, params.w ?? 120);
  const depth = Math.max(10, params.d ?? 120);
  const segments = Math.max(4, Math.min(256, lodSegments(params.segments ?? 48, level, 4)));
  const seed = Number.isFinite(params.heightSeed) ? params.heightSeed : 1337;
  const heightScale = Math.max(0, params.heightScale ?? 8);

  const geometry = new PlaneGeometry(width, depth, segments, segments);
  const position = geometry.attributes.position;

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const noise = terrainHeight(x, y, seed);
    position.setZ(index, noise * heightScale);
  }

  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function buildGeometry(item: RenderPrimitive, level: GeometryLodLevel): BufferGeometry {
  switch (item.primitive) {
    case "box":
      return new BoxGeometry(item.params.w, item.params.h, item.params.d);
    case "cylinder":
      return new CylinderGeometry(item.params.rTop, item.params.rBottom, item.params.h, lodSegments(item.params.radialSegments, level, 6));
    case "sphere":
      return new SphereGeometry(item.params.r, lodSegments(item.params.widthSegments, level, 8), lodSegments(item.params.heightSegments, level, 6));
    case "cone":
      return new ConeGeometry(item.params.r, item.params.h, lodSegments(item.params.radialSegments, level, 6));
    case "text": {
      const width = Math.max(2, item.params.text.length * item.params.size * 0.6);
      const height = Math.max(1, item.params.size);
      const shape = new Shape();
      shape.moveTo(-width / 2, -height / 2);
      shape.lineTo(width / 2, -height / 2);
      shape.lineTo(width / 2, height / 2);
      shape.lineTo(-width / 2, height / 2);
      shape.lineTo(-width / 2, -height / 2);
      return new ExtrudeGeometry(shape, {
        depth: Math.max(0.3, item.params.height * (level === "low" ? 0.7 : level === "medium" ? 0.85 : 1)),
        bevelEnabled: false
      });
    }
    case "terrain":
      return buildTerrainGeometry(item, level);
    default:
      return new BoxGeometry(10, 10, 10);
  }
}

export function buildGeometryFromPrimitive(item: RenderPrimitive, level: GeometryLodLevel = "high"): BufferGeometry {
  const cacheKey = `${item.primitive}:${level}:${JSON.stringify(item.params)}`;
  const cached = geometryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const geometry = buildGeometry(item, level);
  if (!geometry.boundingSphere) {
    geometry.computeBoundingSphere();
  }
  geometryCache.set(cacheKey, geometry);
  return geometry;
}
