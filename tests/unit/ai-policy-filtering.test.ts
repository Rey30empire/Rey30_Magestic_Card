import assert from "node:assert/strict";
import test from "node:test";
import { blockedPermissionReasons, createDefaultAiPermissions, isToolAllowedByPermissions, listAllowedToolsByPermissions } from "../../reycad/src/editor/ai/aiPermissions";
import type { AiPermissions, AiToolCall } from "../../reycad/src/editor/ai/aiSchema";

function modelingPermissions(): AiPermissions {
  return {
    ...createDefaultAiPermissions(),
    readScene: true,
    createGeometry: true,
    editGeometry: true,
    materials: true,
    booleans: true,
    templates: true,
    grid: true
  };
}

function fullPermissions(): AiPermissions {
  return {
    readScene: true,
    createGeometry: true,
    editGeometry: true,
    materials: true,
    booleans: true,
    templates: true,
    delete: true,
    cards: true,
    agents: true,
    skills: true,
    grid: true,
    export: true
  };
}

test("default policy blocks geometry and export tools", () => {
  const permissions = createDefaultAiPermissions();
  const createPrimitive: AiToolCall = { tool: "create_primitive", args: { primitive: "box" } };
  const exportStl: AiToolCall = { tool: "export_stl", args: {} };

  assert.equal(isToolAllowedByPermissions(createPrimitive, permissions), false);
  assert.equal(isToolAllowedByPermissions(exportStl, permissions), false);
  assert.deepEqual(blockedPermissionReasons(createPrimitive, permissions), ["createGeometry"]);
  assert.deepEqual(blockedPermissionReasons(exportStl, permissions), ["export"]);
});

test("modeling profile allows geometry/material tools and blocks agents/export/delete", () => {
  const permissions = modelingPermissions();

  const allowedCalls: AiToolCall[] = [
    { tool: "create_primitive", args: { primitive: "cylinder" } },
    { tool: "create_material_batch", args: { materials: [{ kind: "solidColor", color: "#aabbcc" }] } },
    { tool: "assign_material_batch", args: { nodeIds: ["n1", "n2"], materialId: "mat_1" } },
    { tool: "add_boolean", args: { op: "subtract", aId: "a", bId: "b" } }
  ];

  const blockedCalls: AiToolCall[] = [
    { tool: "assign_agent_skills", args: { agentId: "00000000-0000-0000-0000-000000000000", updates: [{ skillId: "11111111-1111-1111-1111-111111111111", enabled: true }] } },
    { tool: "delete_nodes", args: { nodeIds: ["n1"] } },
    { tool: "export_glb", args: {} }
  ];

  for (const call of allowedCalls) {
    assert.equal(isToolAllowedByPermissions(call, permissions), true, `Expected allowed: ${call.tool}`);
  }

  for (const call of blockedCalls) {
    assert.equal(isToolAllowedByPermissions(call, permissions), false, `Expected blocked: ${call.tool}`);
  }

  assert.deepEqual(blockedPermissionReasons(blockedCalls[0], permissions), ["skills"]);
  assert.deepEqual(blockedPermissionReasons(blockedCalls[1], permissions), ["delete"]);
  assert.deepEqual(blockedPermissionReasons(blockedCalls[2], permissions), ["export"]);
});

test("full policy lists newly added tools as allowed", () => {
  const allowedTools = listAllowedToolsByPermissions(fullPermissions());

  assert.ok(allowedTools.includes("create_material_batch"));
  assert.ok(allowedTools.includes("update_material_batch"));
  assert.ok(allowedTools.includes("assign_material_batch"));
  assert.ok(allowedTools.includes("export_stl"));
  assert.ok(allowedTools.includes("export_glb"));
});
