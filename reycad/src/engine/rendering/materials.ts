import { Color, MeshPhysicalMaterial, MeshStandardMaterial, SRGBColorSpace, Texture, TextureLoader } from "three";
import type { MaterialDef, TextureAsset } from "../scenegraph/types";

const materialCache = new Map<string, MeshStandardMaterial>();
const textureCache = new Map<string, Texture>();
const textureLoader = new TextureLoader();

function resolveTexture(assetId: string | undefined, getTextureAsset?: (id: string) => TextureAsset | undefined): Texture | null {
  if (!assetId || !getTextureAsset) {
    return null;
  }
  const asset = getTextureAsset(assetId);
  if (!asset) {
    return null;
  }
  const cacheKey = `${asset.id}:${asset.dataUrl}`;
  const cached = textureCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const texture = textureLoader.load(asset.dataUrl);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    textureCache.set(cacheKey, texture);
    return texture;
  } catch {
    return null;
  }
}

export function buildThreeMaterial(materialDef?: MaterialDef, getTextureAsset?: (id: string) => TextureAsset | undefined): MeshStandardMaterial {
  const mapData = materialDef?.pbr?.baseColorMapId ? getTextureAsset?.(materialDef.pbr.baseColorMapId)?.dataUrl ?? "" : "";
  const mapKey = mapData.length > 0 ? `${mapData.length}:${mapData.slice(0, 64)}` : "none";
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
    const baseColorMap = resolveTexture(pbr.baseColorMapId, getTextureAsset);
    if (baseColorMap) {
      material.map = baseColorMap;
      material.needsUpdate = true;
    }
  }

  materialCache.set(key, material);
  return material;
}
