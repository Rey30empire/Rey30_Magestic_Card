import engineApi from "../../engine/api/engineApi";
import type { PrimitiveType } from "../../engine/scenegraph/types";

export type PythonBridge = {
  call: (tool: string, args: Record<string, unknown>) => unknown;
};

function asVec3(value: unknown, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    return fallback;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  return [Number.isFinite(x) ? x : fallback[0], Number.isFinite(y) ? y : fallback[1], Number.isFinite(z) ? z : fallback[2]];
}

export function createPythonBridge(): PythonBridge {
  return {
    call(tool, args) {
      if (tool === "create_primitive") {
        const primitive = (args.primitive as PrimitiveType | undefined) ?? "box";
        const params = (args.params as Record<string, unknown> | undefined) ?? {};
        const transform = (args.transform as { position?: [number, number, number] } | undefined) ?? {};
        const materialId = args.materialId as string | undefined;

        return engineApi.createPrimitive(primitive, params, transform, materialId);
      }

      if (tool === "set_grid") {
        const snap = args.snap as number | undefined;
        const angleSnap = args.angleSnap as number | undefined;
        const size = args.size as number | undefined;
        engineApi.setGrid({ snap, angleSnap, size });
        return true;
      }

      if (tool === "get_selection") {
        return engineApi.getSelection();
      }

      if (tool === "set_rigidbody") {
        engineApi.setNodeRigidBody(String(args.nodeId ?? ""), {
          enabled: args.enabled as boolean | undefined,
          mode: args.mode as "dynamic" | "kinematic" | "fixed" | undefined,
          mass: args.mass as number | undefined,
          gravityScale: args.gravityScale as number | undefined,
          lockRotation: args.lockRotation as boolean | undefined,
          linearVelocity: args.linearVelocity as [number, number, number] | undefined
        });
        return true;
      }

      if (tool === "set_collider") {
        engineApi.setNodeCollider(String(args.nodeId ?? ""), {
          enabled: args.enabled as boolean | undefined,
          shape: args.shape as "box" | "sphere" | "capsule" | "mesh" | undefined,
          isTrigger: args.isTrigger as boolean | undefined,
          size: args.size as [number, number, number] | undefined,
          radius: args.radius as number | undefined,
          height: args.height as number | undefined
        });
        return true;
      }

      if (tool === "set_physics_world") {
        engineApi.setPhysicsSettings({
          enabled: args.enabled as boolean | undefined,
          simulate: args.simulate as boolean | undefined,
          runtimeMode: args.runtimeMode as "static" | "arena" | undefined,
          backend: args.backend as "auto" | "lite" | "rapier" | undefined,
          gravity: args.gravity === undefined ? undefined : asVec3(args.gravity),
          floorY: args.floorY as number | undefined
        });
        return true;
      }

      if (tool === "apply_impulse") {
        const impulse = asVec3(args.impulse);
        return engineApi.applyPhysicsImpulse(String(args.nodeId ?? ""), impulse);
      }

      if (tool === "add_constraint") {
        const restLength = Number(args.restLength);
        const stiffness = Number(args.stiffness);
        const damping = Number(args.damping);
        return engineApi.addPhysicsConstraint({
          type: "distance",
          a: String(args.aId ?? ""),
          b: String(args.bId ?? ""),
          restLength: Number.isFinite(restLength) ? restLength : 10,
          stiffness: Number.isFinite(stiffness) ? stiffness : 0.6,
          damping: Number.isFinite(damping) ? damping : 0.1,
          enabled: typeof args.enabled === "boolean" ? args.enabled : true
        });
      }

      if (tool === "update_constraint") {
        engineApi.updatePhysicsConstraint(String(args.constraintId ?? ""), {
          a: args.aId as string | undefined,
          b: args.bId as string | undefined,
          restLength: args.restLength as number | undefined,
          stiffness: args.stiffness as number | undefined,
          damping: args.damping as number | undefined,
          enabled: args.enabled as boolean | undefined
        });
        return true;
      }

      if (tool === "remove_constraint") {
        engineApi.removePhysicsConstraint(String(args.constraintId ?? ""));
        return true;
      }

      if (tool === "list_constraints") {
        return engineApi.listPhysicsConstraints();
      }

      if (tool === "setup_battle_scene") {
        return engineApi.setupBattleScene();
      }

      if (tool === "play_battle_clash") {
        const impulse = typeof args.impulse === "number" ? args.impulse : undefined;
        return impulse === undefined ? engineApi.playBattleClash() : engineApi.playBattleClash(impulse);
      }

      if (tool === "stop_battle_scene") {
        engineApi.stopBattleScene();
        return true;
      }

      throw new Error(`Unsupported python tool: ${tool}`);
    }
  };
}
