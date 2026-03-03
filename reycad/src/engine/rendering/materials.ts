import { Color, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from "three";
import type { MaterialDef, TextureAsset } from "../scenegraph/types";
import { runtimeAssetManager } from "../runtime/assetManager";

const materialCache = new Map<string, MeshStandardMaterial>();

function resolveTexture(
  assetId: string | undefined,
  getTextureAsset?: (id: string) => TextureAsset | undefined
): { texture: Texture | null; mapKey: string } {
  if (!assetId || !getTextureAsset) {
    return { texture: null, mapKey: "none" };
  }
  const asset = getTextureAsset(assetId);
  if (!asset) {
    return { texture: null, mapKey: `${assetId}:missing` };
  }
  const manifest = runtimeAssetManager.upsertTextureAsset(asset);
  const cached = runtimeAssetManager.getCachedTexture(asset.id);
  if (cached) {
    return {
      texture: cached,
      mapKey: `${manifest.id}:${manifest.version}:ready`
    };
  }

  void runtimeAssetManager.loadTextureAsset(asset, "high");
  return {
    texture: null,
    mapKey: `${manifest.id}:${manifest.version}:pending`
  };
}

export function buildThreeMaterial(materialDef?: MaterialDef, getTextureAsset?: (id: string) => TextureAsset | undefined): MeshStandardMaterial {
  const textureState = resolveTexture(materialDef?.pbr?.baseColorMapId, getTextureAsset);
  const mapKey = textureState.mapKey;
  const key = materialDef ? `${JSON.stringify(materialDef)}::map:${mapKey}` : "default";
  const cached = materialCache.get(key);
  if (cached) {
    return cached;
  }

  let material: MeshStandardMaterial;
  if (!materialDef) {
    material = new MeshStandardMaterial({ color: "#8b95a2", roughness: 0.62, metalness: 0.1 });
  } else if (materialDef.kind === "solidColor") {
    material = new MeshStandardMaterial({ color: new Color(materialDef.color ?? "#8b95a2"), roughness: 0.65, metalness: 0.08 });
  } else {
    const pbr = materialDef.pbr ?? {
      metalness: 0.3,
      roughness: 0.5,
      baseColor: "#cccccc",
      emissiveColor: "#000000",
      emissiveIntensity: 0,
      transmission: 0,
      ior: 1.45
    };
    material = new MeshPhysicalMaterial({
      color: new Color(pbr.baseColor),
      roughness: pbr.roughness,
      metalness: pbr.metalness,
      emissive: new Color(pbr.emissiveColor ?? "#000000"),
      emissiveIntensity: pbr.emissiveIntensity ?? 0,
      transmission: pbr.transmission ?? (materialDef.id.includes("glass") ? 0.45 : 0),
      ior: pbr.ior ?? 1.45
    });
    const baseColorMap = textureState.texture;
    if (baseColorMap) {
      material.map = baseColorMap;
      material.needsUpdate = true;
    }
  }

  materialCache.set(key, material);
  return material;
}
