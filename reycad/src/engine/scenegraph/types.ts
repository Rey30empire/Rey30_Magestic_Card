export type Vec3 = [number, number, number];
export type MannequinType = "humanoid" | "creature" | "pet" | "floatingCard";

export type Transform = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type BooleanOp = {
  id: string;
  op: "union" | "subtract" | "intersect";
  a: string;
  b: string;
};

export type NodeBase = {
  id: string;
  name: string;
  type: "group" | "primitive" | "import";
  transform: Transform;
  visible: boolean;
  locked: boolean;
  materialId?: string;
  mode?: "solid" | "hole" | "mixed";
  parentId?: string;
  rigidBody?: NodeRigidBody;
  collider?: NodeCollider;
};

export type NodeRigidBody = {
  enabled: true;
  mode: "dynamic" | "kinematic" | "fixed";
  mass: number;
  gravityScale: number;
  lockRotation: boolean;
  linearVelocity?: Vec3;
};

export type NodeCollider = {
  enabled: true;
  shape: "box" | "sphere" | "capsule" | "mesh";
  isTrigger: boolean;
  size?: Vec3;
  radius?: number;
  height?: number;
};

export type PrimitiveType = "box" | "cylinder" | "sphere" | "cone" | "text" | "terrain";

export type PrimitiveParams = {
  box: { w: number; h: number; d: number; bevel?: number };
  cylinder: { rTop: number; rBottom: number; h: number; radialSegments: number };
  sphere: { r: number; widthSegments: number; heightSegments: number };
  cone: { r: number; h: number; radialSegments: number };
  text: { text: string; size: number; height: number; fontId: string };
  terrain: { w: number; d: number; segments: number; heightSeed: number; heightScale: number };
};

export type PrimitiveNode<T extends PrimitiveType = PrimitiveType> = NodeBase & {
  type: "primitive";
  primitive: T;
  params: PrimitiveParams[T];
};

export type GroupNode = NodeBase & {
  type: "group";
  children: string[];
  mode: "solid" | "hole" | "mixed";
  ops?: BooleanOp[];
};

export type ImportNode = NodeBase & {
  type: "import";
  source: string;
};

export type Node = PrimitiveNode | GroupNode | ImportNode;

export type MaterialDef = {
  id: string;
  name: string;
  kind: "solidColor" | "pbr";
  color?: string;
  pbr?: {
    metalness: number;
    roughness: number;
    baseColor: string;
    emissiveColor?: string;
    emissiveIntensity?: number;
    transmission?: number;
    ior?: number;
    baseColorMapId?: string;
    normalMapId?: string;
    aoMapId?: string;
    roughnessMapId?: string;
    metalnessMapId?: string;
    emissiveMapId?: string;
  };
};

export type TextureAsset = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  createdAt: string;
  width?: number;
  height?: number;
};

export type Project = {
  version: number;
  units: "mm" | "cm" | "in";
  grid: {
    size: number;
    snap: number;
    angleSnap: number;
  };
  physics: PhysicsSettings;
  rootId: string;
  nodes: Record<string, Node>;
  materials: Record<string, MaterialDef>;
  textures: Record<string, TextureAsset>;
  templatesMeta: Record<string, { tags: string[]; name: string }>;
};

export type PhysicsSettings = {
  enabled: boolean;
  simulate: boolean;
  runtimeMode: "static" | "arena";
  backend: "auto" | "lite" | "rapier";
  gravity: Vec3;
  floorY: number;
  constraints: PhysicsConstraint[];
};

export type PhysicsConstraint = {
  id: string;
  type: "distance";
  a: string;
  b: string;
  restLength: number;
  stiffness: number;
  damping: number;
  enabled: boolean;
};

export type Template = {
  id: string;
  name: string;
  tags: string[];
  thumb?: string;
  projectFragment: {
    rootNode: Node;
    nodes: Node[];
  };
};
