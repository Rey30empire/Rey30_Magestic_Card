import { Color, MeshPhysicalMaterial, MeshStandardMaterial } from "three";
import type { MaterialDef } from "../scenegraph/types";

const materialCache = new Map<string, MeshStandardMaterial>();

export function buildThreeMaterial(materialDef?: MaterialDef): MeshStandardMaterial {
  const key = materialDef ? JSON.stringify(materialDef) : "default";
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
    material = new MeshPhysicalMaterial({
      color: new Color(materialDef.pbr?.baseColor ?? "#cccccc"),
      roughness: materialDef.pbr?.roughness ?? 0.5,
      metalness: materialDef.pbr?.metalness ?? 0.3,
      transmission: materialDef.id.includes("glass") ? 0.45 : 0
    });
  }

  materialCache.set(key, material);
  return material;
}
