import assert from "node:assert/strict";
import test from "node:test";
import type { RenderPrimitive } from "../../reycad/src/engine/scenegraph/evaluator";
import {
  computeSceneRuntimeProfile,
  primitiveScaleRadius,
  resolveLodLevel,
  resolveSceneProfile,
  type LodDistanceProfile
} from "../../reycad/src/engine/rendering/renderTuning";

function makeBox(id: string, x: number, y: number, z: number, size = 10, scale = 1): RenderPrimitive {
  return {
    nodeId: id,
    primitive: "box",
    params: {
      w: size,
      h: size,
      d: size,
      bevel: 0
    },
    materialId: undefined,
    transform: {
      position: [x, y, z],
      rotation: [0, 0, 0],
      scale: [scale, scale, scale]
    },
    mode: "solid"
  };
}

function makeGrid(prefix: string, nx: number, nz: number, spacing: number): RenderPrimitive[] {
  const items: RenderPrimitive[] = [];
  const offsetX = ((nx - 1) * spacing) / 2;
  const offsetZ = ((nz - 1) * spacing) / 2;
  let index = 0;
  for (let ix = 0; ix < nx; ix += 1) {
    for (let iz = 0; iz < nz; iz += 1) {
      const x = ix * spacing - offsetX;
      const z = iz * spacing - offsetZ;
      items.push(makeBox(`${prefix}_${index}`, x, 0, z));
      index += 1;
    }
  }
  return items;
}

test("render tuning profiles indoor/outdoor/large-world from realistic scene scales", () => {
  const indoor = makeGrid("indoor", 8, 8, 6);
  const outdoor = makeGrid("outdoor", 18, 18, 18);
  const largeWorld = makeGrid("large", 40, 40, 24);

  const indoorProfile = computeSceneRuntimeProfile(indoor, "high");
  const outdoorProfile = computeSceneRuntimeProfile(outdoor, "high");
  const largeWorldProfile = computeSceneRuntimeProfile(largeWorld, "high");

  assert.equal(indoorProfile.sceneProfile, "indoor");
  assert.equal(outdoorProfile.sceneProfile, "outdoor");
  assert.equal(largeWorldProfile.sceneProfile, "large-world");

  assert.ok(indoorProfile.sceneRadius < outdoorProfile.sceneRadius);
  assert.ok(outdoorProfile.sceneRadius < largeWorldProfile.sceneRadius);
});

test("render tuning chooses practical instancing threshold and cull policy by scene", () => {
  const indoor = makeGrid("indoor", 8, 8, 6);
  const outdoor = makeGrid("outdoor", 18, 18, 18);
  const largeWorld = makeGrid("large", 40, 40, 24);

  const indoorProfile = computeSceneRuntimeProfile(indoor, "high");
  const outdoorProfile = computeSceneRuntimeProfile(outdoor, "high");
  const largeWorldProfile = computeSceneRuntimeProfile(largeWorld, "high");

  assert.equal(indoorProfile.instancingThreshold, 3);
  assert.equal(outdoorProfile.instancingThreshold, 3);
  assert.equal(largeWorldProfile.instancingThreshold, 2);

  assert.ok(indoorProfile.cullBaseMargin > outdoorProfile.cullBaseMargin);
  assert.ok(outdoorProfile.cullBaseMargin > largeWorldProfile.cullBaseMargin);
});

test("render tuning scales LOD distances with quality and keeps sane ordering", () => {
  const outdoor = makeGrid("outdoor", 18, 18, 18);
  const low = computeSceneRuntimeProfile(outdoor, "low");
  const high = computeSceneRuntimeProfile(outdoor, "high");
  const ultra = computeSceneRuntimeProfile(outdoor, "ultra");

  assert.ok(low.lodDistances.near < high.lodDistances.near);
  assert.ok(high.lodDistances.near < ultra.lodDistances.near);
  assert.ok(low.lodDistances.mid < high.lodDistances.mid);
  assert.ok(high.lodDistances.mid < ultra.lodDistances.mid);

  assert.ok(low.lodDistances.near < low.lodDistances.mid);
  assert.ok(high.lodDistances.near < high.lodDistances.mid);
  assert.ok(ultra.lodDistances.near < ultra.lodDistances.mid);
});

test("resolveLodLevel maps distance bands correctly", () => {
  const lod: LodDistanceProfile = { near: 12, mid: 32 };
  assert.equal(resolveLodLevel(1, lod), "high");
  assert.equal(resolveLodLevel(12, lod), "high");
  assert.equal(resolveLodLevel(20, lod), "medium");
  assert.equal(resolveLodLevel(32, lod), "medium");
  assert.equal(resolveLodLevel(64, lod), "low");
});

test("primitiveScaleRadius respects object scale for culling bounds", () => {
  const base = makeBox("box_a", 0, 0, 0, 10, 1);
  const scaled = makeBox("box_b", 0, 0, 0, 10, 2.5);

  const baseRadius = primitiveScaleRadius(base);
  const scaledRadius = primitiveScaleRadius(scaled);
  assert.ok(scaledRadius > baseRadius * 2.4);
});

test("resolveSceneProfile keeps empty and small scenes as indoor", () => {
  assert.equal(resolveSceneProfile(0, 0), "indoor");
  assert.equal(resolveSceneProfile(45, 30), "indoor");
  assert.equal(resolveSceneProfile(180, 120), "outdoor");
  assert.equal(resolveSceneProfile(450, 200), "large-world");
});
