import type { MaterialDef, Project } from "../../engine/scenegraph/types";

export type PlaySessionManifest = {
  schema: 1;
  kind: "reycad_play_session_manifest_v1";
  generatedAt: string;
  preset: string;
  source: string;
  summary: {
    nodeCount: number;
    primitiveCount: number;
    groupCount: number;
    importCount: number;
    materialCount: number;
    textureCount: number;
    textureBytesApprox: number;
  };
  physics: Project["physics"];
  materials: Array<{
    id: string;
    name: string;
    kind: MaterialDef["kind"];
    textureRefs: string[];
  }>;
  textures: Array<{
    id: string;
    name: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    bytesApprox: number;
  }>;
  files: {
    project: string;
  };
};

export type PlaySessionPackage = {
  manifest: PlaySessionManifest;
  project: Project;
};

export type BuildPlaySessionPackageOptions = {
  preset?: string;
  source?: string;
  generatedAt?: string;
  projectFileName?: string;
};

function cloneProject(project: Project): Project {
  if (typeof structuredClone === "function") {
    return structuredClone(project);
  }
  return JSON.parse(JSON.stringify(project)) as Project;
}

function collectMaterialTextureRefs(material: MaterialDef): string[] {
  if (material.kind !== "pbr" || !material.pbr) {
    return [];
  }
  const ids = [
    material.pbr.baseColorMapId,
    material.pbr.normalMapId,
    material.pbr.aoMapId,
    material.pbr.roughnessMapId,
    material.pbr.metalnessMapId,
    material.pbr.emissiveMapId
  ];
  return ids.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return dataUrl.length;
  }
  const head = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (head.includes(";base64")) {
    let padding = 0;
    if (payload.endsWith("==")) {
      padding = 2;
    } else if (payload.endsWith("=")) {
      padding = 1;
    }
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }
  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
}

export function buildPlaySessionPackage(project: Project, options?: BuildPlaySessionPackageOptions): PlaySessionPackage {
  const projectSnapshot = cloneProject(project);
  let primitiveCount = 0;
  let groupCount = 0;
  let importCount = 0;
  for (const node of Object.values(projectSnapshot.nodes)) {
    if (node.type === "primitive") {
      primitiveCount += 1;
      continue;
    }
    if (node.type === "group") {
      groupCount += 1;
      continue;
    }
    importCount += 1;
  }

  const materials = Object.values(projectSnapshot.materials)
    .map((material) => ({
      id: material.id,
      name: material.name,
      kind: material.kind,
      textureRefs: collectMaterialTextureRefs(material)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const textures = Object.values(projectSnapshot.textures)
    .map((texture) => ({
      id: texture.id,
      name: texture.name,
      mimeType: texture.mimeType,
      width: typeof texture.width === "number" ? texture.width : null,
      height: typeof texture.height === "number" ? texture.height : null,
      bytesApprox: estimateDataUrlBytes(texture.dataUrl)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const manifest: PlaySessionManifest = {
    schema: 1,
    kind: "reycad_play_session_manifest_v1",
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    preset: options?.preset ?? "custom",
    source: options?.source ?? "editor",
    summary: {
      nodeCount: Object.keys(projectSnapshot.nodes).length,
      primitiveCount,
      groupCount,
      importCount,
      materialCount: materials.length,
      textureCount: textures.length,
      textureBytesApprox: textures.reduce((acc, item) => acc + item.bytesApprox, 0)
    },
    physics: {
      ...projectSnapshot.physics,
      gravity: [...projectSnapshot.physics.gravity] as [number, number, number],
      constraints: projectSnapshot.physics.constraints.map((constraint) => ({ ...constraint }))
    },
    materials,
    textures,
    files: {
      project: options?.projectFileName ?? "scene.project.json"
    }
  };

  return {
    manifest,
    project: projectSnapshot
  };
}
