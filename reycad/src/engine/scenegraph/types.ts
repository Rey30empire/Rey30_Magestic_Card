export type Vec3 = [number, number, number];

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
  mode?: "solid" | "hole";
  parentId?: string;
};

export type PrimitiveType = "box" | "cylinder" | "sphere" | "cone" | "text";

export type PrimitiveParams = {
  box: { w: number; h: number; d: number; bevel?: number };
  cylinder: { rTop: number; rBottom: number; h: number; radialSegments: number };
  sphere: { r: number; widthSegments: number; heightSegments: number };
  cone: { r: number; h: number; radialSegments: number };
  text: { text: string; size: number; height: number; fontId: string };
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
  };
};

export type Project = {
  version: number;
  units: "mm" | "cm" | "in";
  grid: {
    size: number;
    snap: number;
    angleSnap: number;
  };
  rootId: string;
  nodes: Record<string, Node>;
  materials: Record<string, MaterialDef>;
  templatesMeta: Record<string, { tags: string[]; name: string }>;
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
