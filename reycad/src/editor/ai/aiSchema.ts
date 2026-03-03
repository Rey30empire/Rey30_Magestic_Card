export type AiPermissionKey =
  | "readScene"
  | "createGeometry"
  | "editGeometry"
  | "materials"
  | "booleans"
  | "templates"
  | "delete"
  | "cards"
  | "agents"
  | "skills"
  | "grid"
  | "export"
  | "engineControl";

export type AiPermissions = Record<AiPermissionKey, boolean>;

export type AiToolCall =
  | { tool: "get_scene"; args: {} }
  | {
      tool: "list_assets";
      args: {
        kind: "templates" | "materials";
      };
    }
  | {
      tool: "create_card_draft";
      args: {
        name: string;
        rarity: "common" | "rare" | "epic" | "legendary";
        cardClass: string;
        abilities: string[];
        summonCost: number;
        energy: number;
        baseStats: { attack: number; defense: number; speed: number };
      };
    }
  | {
      tool: "create_material";
      args: {
        kind: "solidColor" | "pbr";
        name?: string;
        color?: string;
        pbr?: {
          metalness?: number;
          roughness?: number;
          baseColor?: string;
        };
      };
    }
  | {
      tool: "update_material";
      args: {
        materialId: string;
        patch: {
          name?: string;
          color?: string;
          pbr?: {
            metalness?: number;
            roughness?: number;
            baseColor?: string;
          };
        };
      };
    }
  | {
      tool: "create_material_batch";
      args: {
        materials: Array<{
          kind: "solidColor" | "pbr";
          name?: string;
          color?: string;
          pbr?: {
            metalness?: number;
            roughness?: number;
            baseColor?: string;
          };
        }>;
      };
    }
  | {
      tool: "update_material_batch";
      args: {
        updates: Array<{
          materialId: string;
          patch: {
            name?: string;
            color?: string;
            pbr?: {
              metalness?: number;
              roughness?: number;
              baseColor?: string;
            };
          };
        }>;
      };
    }
  | {
      tool: "create_agent";
      args: {
        name: string;
        role: string;
        detail?: string;
        personality?: string;
        lore?: string;
        memoryScope?: "private" | "project" | "public";
      };
    }
  | {
      tool: "assign_agent_tools";
      args: {
        agentId: string;
        updates: Array<{
          toolKey: string;
          allowed: boolean;
          config?: Record<string, string | number | boolean>;
        }>;
      };
    }
  | {
      tool: "assign_agent_skills";
      args: {
        agentId: string;
        updates: Array<{
          skillId: string;
          enabled?: boolean;
          remove?: boolean;
          config?: Record<string, unknown>;
        }>;
      };
    }
  | {
      tool: "set_transform";
      args: {
        nodeId: string;
        transformPatch: {
          position?: [number, number, number];
          rotation?: [number, number, number];
          scale?: [number, number, number];
        };
      };
    }
  | {
      tool: "set_params";
      args: {
        nodeId: string;
        paramsPatch: Record<string, unknown>;
      };
    }
  | {
      tool: "group";
      args: {
        nodeIds: string[];
        mode?: "solid" | "hole" | "mixed";
      };
    }
  | {
      tool: "toggle_hole";
      args: {
        nodeId: string;
      };
    }
  | {
      tool: "assign_material";
      args: {
        nodeId: string;
        materialId: string;
      };
    }
  | {
      tool: "assign_material_batch";
      args: {
        nodeIds: string[];
        materialId: string;
      };
    }
  | {
      tool: "insert_template";
      args: {
        templateId: string;
        parentId?: string;
      };
    }
  | {
      tool: "delete_nodes";
      args: {
        nodeIds: string[];
      };
    }
  | {
      tool: "duplicate";
      args: {
        nodeIds: string[];
      };
    }
  | {
      tool: "add_boolean";
      args: {
        op: "union" | "subtract" | "intersect";
        aId: string;
        bId: string;
      };
    }
  | {
      tool: "frame";
      args: {
        nodeIds: string[];
      };
    }
  | {
      tool: "set_grid";
      args: {
        snap?: number;
        angleSnap?: number;
        size?: number;
      };
    }
  | {
      tool: "set_rigidbody";
      args: {
        nodeId: string;
        enabled?: boolean;
        mode?: "dynamic" | "kinematic" | "fixed";
        mass?: number;
        gravityScale?: number;
        lockRotation?: boolean;
        linearVelocity?: [number, number, number];
      };
    }
  | {
      tool: "set_collider";
      args: {
        nodeId: string;
        enabled?: boolean;
        shape?: "box" | "sphere" | "capsule" | "mesh";
        isTrigger?: boolean;
        size?: [number, number, number];
        radius?: number;
        height?: number;
      };
    }
  | {
      tool: "set_physics_world";
      args: {
        enabled?: boolean;
        simulate?: boolean;
        runtimeMode?: "static" | "arena";
        backend?: "auto" | "lite" | "rapier";
        gravity?: [number, number, number];
        floorY?: number;
      };
    }
  | {
      tool: "add_constraint";
      args: {
        type?: "distance";
        aId: string;
        bId: string;
        restLength?: number;
        stiffness?: number;
        damping?: number;
        enabled?: boolean;
      };
    }
  | {
      tool: "update_constraint";
      args: {
        constraintId: string;
        patch: {
          aId?: string;
          bId?: string;
          restLength?: number;
          stiffness?: number;
          damping?: number;
          enabled?: boolean;
        };
      };
    }
  | {
      tool: "remove_constraint";
      args: {
        constraintId: string;
      };
    }
  | {
      tool: "list_constraints";
      args: {};
    }
  | {
      tool: "raycast_physics";
      args: {
        origin: [number, number, number];
        direction: [number, number, number];
        maxDistance?: number;
      };
    }
  | {
      tool: "get_physics_events";
      args: {
        limit?: number;
      };
    }
  | {
      tool: "clear_physics_events";
      args: {};
    }
  | {
      tool: "setup_battle_scene";
      args: {};
    }
  | {
      tool: "play_battle_clash";
      args: {
        impulse?: number;
      };
    }
  | {
      tool: "stop_battle_scene";
      args: {};
    }
  | {
      tool: "apply_impulse";
      args: {
        nodeId: string;
        impulse: [number, number, number];
      };
    }
  | {
      tool: "set_quality";
      args: {
        mode: "auto" | "ultra" | "high" | "medium" | "low";
      };
    }
  | {
      tool: "get_engine_status";
      args: {};
    }
  | {
      tool: "generate_terrain";
      args: {
        params?: {
          w?: number;
          d?: number;
          segments?: number;
          heightSeed?: number;
          heightScale?: number;
        };
        transform?: {
          position?: [number, number, number];
          rotation?: [number, number, number];
          scale?: [number, number, number];
        };
        materialId?: string;
      };
    }
  | {
      tool: "create_primitive";
      args: {
        primitive: "box" | "cylinder" | "sphere" | "cone" | "text" | "terrain";
        params?: Record<string, unknown>;
        transform?: {
          position?: [number, number, number];
          rotation?: [number, number, number];
          scale?: [number, number, number];
        };
        materialId?: string;
      };
    }
  | {
      tool: "export_stl";
      args: {
        selectionIds?: string[];
        filename?: string;
      };
    }
  | {
      tool: "export_glb";
      args: {
        selectionIds?: string[];
        filename?: string;
      };
    };

export type AiExecutionResult = {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
};
