import type { AiPermissionKey, AiPermissions, AiToolCall } from "./aiSchema";

export const AI_PERMISSIONS_STORAGE_KEY = "reycad.ai.permissions.v1";

const TOOL_PERMISSION_REQUIREMENTS: Record<AiToolCall["tool"], AiPermissionKey[]> = {
  get_scene: ["readScene"],
  list_assets: ["readScene"],
  create_primitive: ["createGeometry"],
  set_transform: ["editGeometry"],
  set_params: ["editGeometry"],
  group: ["editGeometry"],
  duplicate: ["editGeometry"],
  toggle_hole: ["booleans"],
  add_boolean: ["booleans"],
  assign_material: ["materials"],
  assign_material_batch: ["materials"],
  create_material: ["materials"],
  create_material_batch: ["materials"],
  update_material: ["materials"],
  update_material_batch: ["materials"],
  insert_template: ["templates"],
  delete_nodes: ["delete"],
  create_card_draft: ["cards"],
  create_agent: ["agents"],
  assign_agent_tools: ["agents"],
  assign_agent_skills: ["skills"],
  frame: ["grid"],
  set_grid: ["grid"],
  set_rigidbody: ["engineControl"],
  set_collider: ["engineControl"],
  set_physics_world: ["engineControl"],
  add_constraint: ["engineControl"],
  update_constraint: ["engineControl"],
  remove_constraint: ["engineControl"],
  list_constraints: ["engineControl"],
  raycast_physics: ["engineControl"],
  get_physics_events: ["engineControl"],
  clear_physics_events: ["engineControl"],
  setup_battle_scene: ["engineControl"],
  play_battle_clash: ["engineControl"],
  stop_battle_scene: ["engineControl"],
  apply_impulse: ["engineControl"],
  set_quality: ["engineControl"],
  get_engine_status: ["engineControl"],
  generate_terrain: ["createGeometry"],
  export_stl: ["export"],
  export_glb: ["export"]
};

export const AI_PERMISSION_DEFINITIONS: Array<{ key: AiPermissionKey; label: string; description: string }> = [
  { key: "readScene", label: "Read Scene", description: "Permite leer nodos, selección y assets." },
  { key: "createGeometry", label: "Create Geometry", description: "Permite crear primitivas 3D." },
  { key: "editGeometry", label: "Edit Geometry", description: "Permite transformar, agrupar y duplicar objetos." },
  { key: "materials", label: "Materials", description: "Permite crear/editar/asignar materiales." },
  { key: "booleans", label: "Booleans", description: "Permite operaciones Solid/Hole y CSG." },
  { key: "templates", label: "Templates", description: "Permite insertar plantillas." },
  { key: "delete", label: "Delete", description: "Permite borrar nodos." },
  { key: "cards", label: "Cards", description: "Permite crear drafts de cartas vía API." },
  { key: "agents", label: "Agents", description: "Permite crear agentes y asignar herramientas." },
  { key: "skills", label: "Skills", description: "Permite asignar skills a agentes." },
  { key: "grid", label: "Grid/Frame", description: "Permite set_grid y frame de cámara." },
  { key: "export", label: "Export", description: "Permite exportar STL/GLB desde tools AI." },
  { key: "engineControl", label: "Engine Control", description: "Permite estado/calidad del motor y configuración de física." }
];

export function createDefaultAiPermissions(): AiPermissions {
  return {
    readScene: false,
    createGeometry: false,
    editGeometry: false,
    materials: false,
    booleans: false,
    templates: false,
    delete: false,
    cards: false,
    agents: false,
    skills: false,
    grid: false,
    export: false,
    engineControl: false
  };
}

export function mergeAiPermissions(base: AiPermissions, patch: Partial<AiPermissions>): AiPermissions {
  return {
    ...base,
    ...patch
  };
}

export function loadAiPermissionsLocal(): AiPermissions {
  const fallback = createDefaultAiPermissions();
  try {
    const raw = localStorage.getItem(AI_PERMISSIONS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<AiPermissions>;
    return mergeAiPermissions(fallback, parsed);
  } catch {
    return fallback;
  }
}

export function saveAiPermissionsLocal(permissions: AiPermissions): void {
  localStorage.setItem(AI_PERMISSIONS_STORAGE_KEY, JSON.stringify(permissions));
}

export function isToolAllowedByPermissions(toolCall: AiToolCall, permissions: AiPermissions): boolean {
  const required = TOOL_PERMISSION_REQUIREMENTS[toolCall.tool] ?? [];
  return required.every((key) => permissions[key]);
}

export function blockedPermissionReasons(toolCall: AiToolCall, permissions: AiPermissions): string[] {
  const required = TOOL_PERMISSION_REQUIREMENTS[toolCall.tool] ?? [];
  return required.filter((key) => !permissions[key]);
}

export function listAllowedToolsByPermissions(permissions: AiPermissions): string[] {
  const result: string[] = [];
  for (const [tool, required] of Object.entries(TOOL_PERMISSION_REQUIREMENTS)) {
    if (required.every((key) => permissions[key])) {
      result.push(tool);
    }
  }
  return result.sort();
}
