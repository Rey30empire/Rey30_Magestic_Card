import { createId } from "../../lib/ids";
import type { GroupNode, MaterialDef, PrimitiveNode, PrimitiveType, Project, Transform } from "./types";

export const DEFAULT_TRANSFORM: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1]
};

export function createDefaultMaterials(): Record<string, MaterialDef> {
  const solidPalette: Array<{ id: string; name: string; color: string }> = [
    { id: "solid_sand", name: "Sand", color: "#d2b48c" },
    { id: "solid_ember", name: "Ember", color: "#c95138" },
    { id: "solid_steel", name: "Steel", color: "#8b95a2" },
    { id: "solid_moss", name: "Moss", color: "#54744e" },
    { id: "solid_ocean", name: "Ocean", color: "#3e74b8" },
    { id: "solid_ink", name: "Ink", color: "#1f2630" },
    { id: "solid_cream", name: "Cream", color: "#ece6d8" },
    { id: "solid_royal", name: "Royal", color: "#473ebf" },
    { id: "solid_coral", name: "Coral", color: "#e26f5f" },
    { id: "solid_forest", name: "Forest", color: "#2f5944" },
    { id: "solid_graphite", name: "Graphite", color: "#3f434a" },
    { id: "solid_gold", name: "Gold", color: "#c3a25b" }
  ];

  const pbrPresets: MaterialDef[] = [
    {
      id: "pbr_plastic_matte",
      name: "Plastic Matte",
      kind: "pbr",
      pbr: { metalness: 0.05, roughness: 0.85, baseColor: "#d8d8d8", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0, ior: 1.45 }
    },
    {
      id: "pbr_plastic_glossy",
      name: "Plastic Glossy",
      kind: "pbr",
      pbr: { metalness: 0.1, roughness: 0.28, baseColor: "#d6d6d6", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0, ior: 1.45 }
    },
    {
      id: "pbr_metal",
      name: "Metal",
      kind: "pbr",
      pbr: { metalness: 0.9, roughness: 0.22, baseColor: "#a7afb8", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0, ior: 1.45 }
    },
    {
      id: "pbr_rubber",
      name: "Rubber",
      kind: "pbr",
      pbr: { metalness: 0, roughness: 0.95, baseColor: "#1b1d22", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0, ior: 1.45 }
    },
    {
      id: "pbr_wood",
      name: "Wood",
      kind: "pbr",
      pbr: { metalness: 0, roughness: 0.72, baseColor: "#8f6236", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0, ior: 1.45 }
    },
    {
      id: "pbr_glassish",
      name: "Glass-ish",
      kind: "pbr",
      pbr: { metalness: 0, roughness: 0.02, baseColor: "#b8d6ed", emissiveColor: "#000000", emissiveIntensity: 0, transmission: 0.55, ior: 1.52 }
    }
  ];

  const entries: MaterialDef[] = [
    ...solidPalette.map((item) => ({ id: item.id, name: item.name, kind: "solidColor" as const, color: item.color })),
    ...pbrPresets
  ];

  return Object.fromEntries(entries.map((item) => [item.id, item]));
}

function primitiveDefaults(type: PrimitiveType): PrimitiveNode {
  const base = {
    id: createId(type),
    name: `${type[0].toUpperCase()}${type.slice(1)}`,
    type: "primitive" as const,
    primitive: type,
    transform: { ...DEFAULT_TRANSFORM },
    visible: true,
    locked: false,
    mode: "solid" as const
  };

  switch (type) {
    case "box":
      return { ...base, params: { w: 20, h: 20, d: 20 } };
    case "cylinder":
      return { ...base, params: { rTop: 8, rBottom: 8, h: 20, radialSegments: 32 } };
    case "sphere":
      return { ...base, params: { r: 10, widthSegments: 32, heightSegments: 16 } };
    case "cone":
      return { ...base, params: { r: 10, h: 20, radialSegments: 32 } };
    case "text":
      return { ...base, params: { text: "R33", size: 8, height: 2, fontId: "default" } };
    case "terrain":
      return { ...base, params: { w: 120, d: 120, segments: 48, heightSeed: 1337, heightScale: 8 } };
    default:
      return { ...base, params: { w: 20, h: 20, d: 20 } };
  }
}

export function createPrimitiveNode(type: PrimitiveType): PrimitiveNode {
  return primitiveDefaults(type);
}

export function createRootNode(): GroupNode {
  return {
    id: "root",
    name: "Scene Root",
    type: "group",
    transform: { ...DEFAULT_TRANSFORM },
    visible: true,
    locked: false,
    mode: "mixed",
    children: [],
    ops: []
  };
}

export function createProject(): Project {
  const root = createRootNode();
  return {
    version: 3,
    units: "mm",
    grid: {
      size: 400,
      snap: 1,
      angleSnap: 15
    },
    physics: {
      enabled: false,
      simulate: false,
      runtimeMode: "static",
      backend: "auto",
      gravity: [0, -9.81, 0],
      floorY: 0,
      constraints: []
    },
    rootId: root.id,
    nodes: {
      [root.id]: root
    },
    materials: createDefaultMaterials(),
    textures: {},
    templatesMeta: {}
  };
}
