import assert from "node:assert/strict";
import test from "node:test";
import type { Texture } from "three";
import { RuntimeAssetManager, estimateTextureByteSize, hashTextureDataUrl } from "../../reycad/src/engine/runtime/assetManager";
import type { TextureAsset } from "../../reycad/src/engine/scenegraph/types";

type FakeTexture = Texture & { __id: string; disposed: boolean };

function makeAsset(id: string, payload: string, width = 16, height = 16): TextureAsset {
  return {
    id,
    name: id,
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${payload}`,
    createdAt: "2026-03-03T00:00:00.000Z",
    width,
    height
  };
}

function createFakeTexture(id: string): FakeTexture {
  const fake = {
    __id: id,
    disposed: false,
    dispose() {
      fake.disposed = true;
    }
  } as unknown as FakeTexture;
  return fake;
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("asset manager manifest increments version when texture payload changes", () => {
  const manager = new RuntimeAssetManager({
    loader: {
      loadAsync: async (url: string) => createFakeTexture(url)
    }
  });

  const first = manager.upsertTextureAsset(makeAsset("tex_1", "AAAA"));
  const second = manager.upsertTextureAsset(makeAsset("tex_1", "AAAA"));
  const third = manager.upsertTextureAsset(makeAsset("tex_1", "BBBB"));

  assert.equal(first.version, 1);
  assert.equal(second.version, 1);
  assert.equal(third.version, 2);
  assert.notEqual(first.hash, third.hash);
});

test("asset manager loads queued textures by priority", async () => {
  const started: string[] = [];
  const resolvers: Array<() => void> = [];

  const manager = new RuntimeAssetManager({
    maxConcurrentLoads: 1,
    loader: {
      loadAsync: (url: string) =>
        new Promise<Texture>((resolve) => {
          started.push(url);
          resolvers.push(() => resolve(createFakeTexture(url)));
        })
    }
  });

  const assetA = makeAsset("tex_a", "AA");
  const assetB = makeAsset("tex_b", "BB");
  const assetC = makeAsset("tex_c", "CC");

  const pa = manager.loadTextureAsset(assetA, "normal");
  const pb = manager.loadTextureAsset(assetB, "low");
  const pc = manager.loadTextureAsset(assetC, "high");

  assert.equal(started.length, 1);
  resolvers.shift()?.();
  await pa;
  await waitFor(() => started.length === 2);

  assert.equal(started.length, 2);
  assert.equal(started[1], assetC.dataUrl);
  resolvers.shift()?.();
  await pc;
  await waitFor(() => started.length === 3);

  assert.equal(started.length, 3);
  assert.equal(started[2], assetB.dataUrl);
  resolvers.shift()?.();
  await pb;
});

test("asset manager prunes least recently used textures under memory budget", async () => {
  const manager = new RuntimeAssetManager({
    bytesBudget: 2 * 1024 * 1024,
    loader: {
      loadAsync: async (url: string) => createFakeTexture(url)
    }
  });

  const assetA = makeAsset("tex_a", "A".repeat(2000), 1024, 1024);
  const assetB = makeAsset("tex_b", "B".repeat(2000), 1024, 1024);

  await manager.loadTextureAsset(assetA, "normal");
  await manager.loadTextureAsset(assetB, "normal");

  const snapshot = manager.getSnapshot();
  assert.ok(snapshot.evictions >= 1, `expected at least one eviction, got ${snapshot.evictions}`);
  assert.ok(snapshot.cacheEntries <= 1, `expected <= 1 cache entries, got ${snapshot.cacheEntries}`);
});

test("asset manager prefetchTextureRequests deduplicates and keeps highest priority", async () => {
  const started: string[] = [];
  const resolvers: Array<() => void> = [];

  const manager = new RuntimeAssetManager({
    maxConcurrentLoads: 1,
    loader: {
      loadAsync: (url: string) =>
        new Promise<Texture>((resolve) => {
          started.push(url);
          resolvers.push(() => resolve(createFakeTexture(url)));
        })
    }
  });

  const low = makeAsset("tex_low", "LOW");
  const high = makeAsset("tex_high", "HIGH");
  manager.prefetchTextureRequests([
    { asset: low, priority: "low" },
    { asset: high, priority: "high" },
    { asset: high, priority: "critical" }
  ]);

  assert.equal(started.length, 1);
  resolvers.shift()?.();
  await waitFor(() => started.length === 2);

  assert.equal(started[1], high.dataUrl);
});

test("asset helpers compute deterministic hash and practical byte estimate", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const hashA = hashTextureDataUrl(dataUrl);
  const hashB = hashTextureDataUrl(dataUrl);
  assert.equal(hashA, hashB);

  const bytes = estimateTextureByteSize({
    dataUrl,
    width: 8,
    height: 8
  });
  assert.ok(bytes >= 256);
});
