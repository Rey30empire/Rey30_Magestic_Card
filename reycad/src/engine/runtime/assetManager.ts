import { SRGBColorSpace, Texture, TextureLoader } from "three";
import type { TextureAsset } from "../scenegraph/types";

export type RuntimeAssetKind = "texture";
export type RuntimeAssetPriority = "critical" | "high" | "normal" | "low";

export type AssetManifestEntry = {
  id: string;
  kind: RuntimeAssetKind;
  name: string;
  mimeType: string;
  hash: string;
  byteSize: number;
  version: number;
  createdAt: string;
  width?: number;
  height?: number;
};

export type AssetManagerSnapshot = {
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
};

type TextureLoaderLike = {
  loadAsync: (url: string) => Promise<Texture>;
};

type QueuedTextureLoad = {
  id: string;
  hash: string;
  version: number;
  asset: TextureAsset;
  priority: number;
  order: number;
  resolve: (texture: Texture | null) => void;
};

type CachedTexture = {
  texture: Texture;
  byteSize: number;
  version: number;
  lastUsedAt: number;
};

export type RuntimeAssetManagerConfig = {
  loader?: TextureLoaderLike;
  maxConcurrentLoads?: number;
  bytesBudget?: number;
};

const DEFAULT_BYTES_BUDGET = 96 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_LOADS = 2;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function priorityWeight(priority: RuntimeAssetPriority): number {
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

function hashStringFNV1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function extractBase64Payload(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0 || commaIndex >= dataUrl.length - 1) {
    return "";
  }
  return dataUrl.slice(commaIndex + 1);
}

export function estimateTextureByteSize(asset: Pick<TextureAsset, "dataUrl" | "width" | "height">): number {
  const pixels = Number.isFinite(asset.width) && Number.isFinite(asset.height) ? (asset.width as number) * (asset.height as number) * 4 : 0;
  const payload = extractBase64Payload(asset.dataUrl);
  if (payload.length === 0) {
    return Math.max(1024, pixels);
  }

  const base64Bytes = Math.floor((payload.length * 3) / 4);
  return Math.max(1024, Math.max(base64Bytes, pixels));
}

export function hashTextureDataUrl(dataUrl: string): string {
  return hashStringFNV1a(dataUrl);
}

export class RuntimeAssetManager {
  private readonly loader: TextureLoaderLike;
  private readonly maxConcurrentLoads: number;
  private readonly manifestById = new Map<string, AssetManifestEntry>();
  private readonly textureCache = new Map<string, CachedTexture>();
  private readonly queuedById = new Map<string, QueuedTextureLoad>();
  private readonly pendingById = new Map<string, Promise<Texture | null>>();
  private readonly queue: QueuedTextureLoad[] = [];
  private readonly pinnedTextureIds = new Set<string>();

  private orderCounter = 0;
  private activeLoads = 0;
  private bytesUsed = 0;
  private bytesBudget: number;
  private hits = 0;
  private misses = 0;
  private completedLoads = 0;
  private failedLoads = 0;
  private evictions = 0;
  private prefetchQueued = 0;

  constructor(config: RuntimeAssetManagerConfig = {}) {
    this.loader = config.loader ?? new TextureLoader();
    const configuredConcurrency = Number.isFinite(config.maxConcurrentLoads) ? (config.maxConcurrentLoads as number) : DEFAULT_MAX_CONCURRENT_LOADS;
    this.maxConcurrentLoads = Math.max(1, Math.floor(configuredConcurrency));
    const configuredBudget = Number.isFinite(config.bytesBudget) ? (config.bytesBudget as number) : DEFAULT_BYTES_BUDGET;
    this.bytesBudget = Math.max(2 * 1024 * 1024, Math.floor(configuredBudget));
  }

  setBytesBudget(nextBudget: number): void {
    if (!Number.isFinite(nextBudget)) {
      return;
    }
    this.bytesBudget = Math.max(2 * 1024 * 1024, Math.floor(nextBudget));
    this.pruneLRU();
  }

  getBytesBudget(): number {
    return this.bytesBudget;
  }

  upsertTextureAsset(asset: TextureAsset): AssetManifestEntry {
    const hash = hashTextureDataUrl(asset.dataUrl);
    const byteSize = estimateTextureByteSize(asset);
    const existing = this.manifestById.get(asset.id);
    const version = existing ? (existing.hash === hash ? existing.version : existing.version + 1) : 1;

    const next: AssetManifestEntry = {
      id: asset.id,
      kind: "texture",
      name: asset.name,
      mimeType: asset.mimeType,
      hash,
      byteSize,
      version,
      createdAt: asset.createdAt,
      width: Number.isFinite(asset.width) ? (asset.width as number) : undefined,
      height: Number.isFinite(asset.height) ? (asset.height as number) : undefined
    };

    this.manifestById.set(asset.id, next);

    if (existing && existing.hash !== hash) {
      const cached = this.textureCache.get(asset.id);
      if (cached) {
        cached.texture.dispose();
        this.textureCache.delete(asset.id);
        this.bytesUsed = Math.max(0, this.bytesUsed - cached.byteSize);
      }
      this.removeQueuedTask(asset.id);
    }

    return next;
  }

  syncTextureAssets(textures: Record<string, TextureAsset>): void {
    const nextIds = new Set<string>();
    for (const [id, asset] of Object.entries(textures)) {
      nextIds.add(id);
      this.upsertTextureAsset(asset);
    }

    for (const id of [...this.manifestById.keys()]) {
      if (!nextIds.has(id)) {
        this.removeAsset(id);
      }
    }
    for (const id of [...this.textureCache.keys()]) {
      if (!nextIds.has(id)) {
        this.removeAsset(id);
      }
    }
    for (const id of [...this.queuedById.keys()]) {
      if (!nextIds.has(id)) {
        this.removeQueuedTask(id);
      }
    }
    for (const id of [...this.pinnedTextureIds]) {
      if (!nextIds.has(id)) {
        this.pinnedTextureIds.delete(id);
      }
    }
  }

  setPinnedTextureIds(ids: readonly string[]): void {
    this.pinnedTextureIds.clear();
    for (const id of ids) {
      this.pinnedTextureIds.add(id);
    }
  }

  getCachedTexture(textureId: string): Texture | null {
    const cached = this.textureCache.get(textureId);
    if (!cached) {
      return null;
    }
    cached.lastUsedAt = nowMs();
    return cached.texture;
  }

  loadTextureAsset(asset: TextureAsset, priority: RuntimeAssetPriority = "normal"): Promise<Texture | null> {
    const manifest = this.upsertTextureAsset(asset);
    const cached = this.textureCache.get(asset.id);
    if (cached && cached.version === manifest.version) {
      this.hits += 1;
      cached.lastUsedAt = nowMs();
      return Promise.resolve(cached.texture);
    }

    const existingPending = this.pendingById.get(asset.id);
    if (existingPending) {
      const queued = this.queuedById.get(asset.id);
      if (queued) {
        queued.priority = Math.max(queued.priority, priorityWeight(priority));
      }
      return existingPending;
    }

    this.misses += 1;
    const deferred = {} as {
      promise: Promise<Texture | null>;
      resolve: (texture: Texture | null) => void;
    };
    deferred.promise = new Promise<Texture | null>((resolve) => {
      deferred.resolve = resolve;
    });

    const queued: QueuedTextureLoad = {
      id: asset.id,
      hash: manifest.hash,
      version: manifest.version,
      asset,
      priority: priorityWeight(priority),
      order: this.orderCounter++,
      resolve: deferred.resolve
    };

    this.queue.push(queued);
    this.queuedById.set(asset.id, queued);
    this.pendingById.set(asset.id, deferred.promise);
    this.pumpQueue();
    return deferred.promise;
  }

  prefetchTextureAssets(assets: TextureAsset[], priority: RuntimeAssetPriority = "low"): number {
    let queuedCount = 0;
    for (const asset of assets) {
      const manifest = this.upsertTextureAsset(asset);
      const cached = this.textureCache.get(asset.id);
      if (cached && cached.version === manifest.version) {
        continue;
      }
      if (this.pendingById.has(asset.id)) {
        const queued = this.queuedById.get(asset.id);
        if (queued) {
          queued.priority = Math.max(queued.priority, priorityWeight(priority));
        }
        continue;
      }
      queuedCount += 1;
      this.prefetchQueued += 1;
      void this.loadTextureAsset(asset, priority);
    }
    return queuedCount;
  }

  getManifestEntries(): AssetManifestEntry[] {
    return [...this.manifestById.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  getManifestEntry(textureId: string): AssetManifestEntry | null {
    return this.manifestById.get(textureId) ?? null;
  }

  getSnapshot(): AssetManagerSnapshot {
    return {
      manifestEntries: this.manifestById.size,
      cacheEntries: this.textureCache.size,
      queuedLoads: this.queue.length,
      activeLoads: this.activeLoads,
      bytesUsed: this.bytesUsed,
      bytesBudget: this.bytesBudget,
      hits: this.hits,
      misses: this.misses,
      completedLoads: this.completedLoads,
      failedLoads: this.failedLoads,
      evictions: this.evictions,
      prefetchQueued: this.prefetchQueued
    };
  }

  private removeAsset(textureId: string): void {
    this.manifestById.delete(textureId);
    this.removeQueuedTask(textureId);
    const cached = this.textureCache.get(textureId);
    if (cached) {
      cached.texture.dispose();
      this.textureCache.delete(textureId);
      this.bytesUsed = Math.max(0, this.bytesUsed - cached.byteSize);
    }
    this.pinnedTextureIds.delete(textureId);
  }

  private removeQueuedTask(textureId: string): void {
    const queued = this.queuedById.get(textureId);
    if (!queued) {
      return;
    }
    const index = this.queue.indexOf(queued);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.queuedById.delete(textureId);
  }

  private pickNextTaskIndex(): number {
    if (this.queue.length === 0) {
      return -1;
    }

    let bestIndex = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      const best = this.queue[bestIndex];
      if (candidate.priority > best.priority || (candidate.priority === best.priority && candidate.order < best.order)) {
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private pumpQueue(): void {
    while (this.activeLoads < this.maxConcurrentLoads && this.queue.length > 0) {
      const nextIndex = this.pickNextTaskIndex();
      if (nextIndex < 0) {
        return;
      }

      const task = this.queue.splice(nextIndex, 1)[0];
      this.queuedById.delete(task.id);
      this.activeLoads += 1;

      const activeManifest = this.manifestById.get(task.id);
      if (!activeManifest || activeManifest.hash !== task.hash || activeManifest.version !== task.version) {
        this.pendingById.delete(task.id);
        this.activeLoads -= 1;
        task.resolve(null);
        continue;
      }

      this.loader
        .loadAsync(task.asset.dataUrl)
        .then((texture) => {
          const latest = this.manifestById.get(task.id);
          if (!latest || latest.hash !== task.hash || latest.version !== task.version) {
            texture.dispose();
            task.resolve(null);
            return;
          }

          texture.colorSpace = SRGBColorSpace;
          texture.needsUpdate = true;

          const cached = this.textureCache.get(task.id);
          if (cached) {
            cached.texture.dispose();
            this.bytesUsed = Math.max(0, this.bytesUsed - cached.byteSize);
          }

          const byteSize = latest.byteSize;
          this.textureCache.set(task.id, {
            texture,
            byteSize,
            version: latest.version,
            lastUsedAt: nowMs()
          });
          this.bytesUsed += byteSize;
          this.completedLoads += 1;
          this.pruneLRU();
          task.resolve(texture);
        })
        .catch(() => {
          this.failedLoads += 1;
          task.resolve(null);
        })
        .finally(() => {
          this.pendingById.delete(task.id);
          this.activeLoads = Math.max(0, this.activeLoads - 1);
          this.pumpQueue();
        });
    }
  }

  private pruneLRU(): void {
    while (this.bytesUsed > this.bytesBudget && this.textureCache.size > 0) {
      let candidateId: string | null = null;
      let candidateTimestamp = Number.POSITIVE_INFINITY;

      for (const [id, entry] of this.textureCache.entries()) {
        if (this.pinnedTextureIds.has(id)) {
          continue;
        }
        if (entry.lastUsedAt < candidateTimestamp) {
          candidateTimestamp = entry.lastUsedAt;
          candidateId = id;
        }
      }

      if (!candidateId) {
        break;
      }

      const candidate = this.textureCache.get(candidateId);
      if (!candidate) {
        break;
      }
      candidate.texture.dispose();
      this.textureCache.delete(candidateId);
      this.bytesUsed = Math.max(0, this.bytesUsed - candidate.byteSize);
      this.evictions += 1;
    }
  }
}

export const runtimeAssetManager = new RuntimeAssetManager();
