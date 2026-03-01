import engineApi from "../../engine/api/engineApi";
import { parseSimpleDsl } from "../../engine/api/dsl";
import { isToolAllowedByPermissions, loadAiPermissionsLocal, blockedPermissionReasons } from "./aiPermissions";
import type { AiExecutionResult, AiPermissions, AiToolCall } from "./aiSchema";

const MAX_TOOLCALLS_PER_REQUEST = 80;
const MAX_NODES_PER_REQUEST = 200;
const MAX_BOOLEAN_OPS_PER_REQUEST = 50;
const MAX_MATERIAL_MUTATIONS_PER_REQUEST = 80;
const MAX_AGENT_MUTATIONS_PER_REQUEST = 50;
const FRONT_TOKEN_KEY = "rey30_frontend_token";
const DEFAULT_YIELD_EVERY = 6;
const POLICY_STATS_KEY = "reycad.ai.policy.stats.v1";

export type AiPolicyStats = {
  blockedCount: number;
  blockedByTool: Record<string, number>;
  lastBlockedAt: string | null;
};

export type AiPlanMeta = {
  source: "remote" | "local" | "local-fallback";
  reason: string;
  at: string;
};

export type ExecuteToolCallsOptions = {
  yieldEvery?: number;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onBatch?: (batchIndex: number, totalBatches: number, from: number, to: number) => void;
  permissions?: AiPermissions;
};

let lastPlanMeta: AiPlanMeta = {
  source: "local",
  reason: "init",
  at: new Date().toISOString()
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function readPolicyStats(): AiPolicyStats {
  try {
    const raw = localStorage.getItem(POLICY_STATS_KEY);
    if (!raw) {
      return { blockedCount: 0, blockedByTool: {}, lastBlockedAt: null };
    }
    const parsed = JSON.parse(raw) as Partial<AiPolicyStats>;
    return {
      blockedCount: typeof parsed.blockedCount === "number" ? parsed.blockedCount : 0,
      blockedByTool: parsed.blockedByTool && typeof parsed.blockedByTool === "object" ? parsed.blockedByTool : {},
      lastBlockedAt: typeof parsed.lastBlockedAt === "string" ? parsed.lastBlockedAt : null
    };
  } catch {
    return { blockedCount: 0, blockedByTool: {}, lastBlockedAt: null };
  }
}

function writePolicyStats(stats: AiPolicyStats): void {
  localStorage.setItem(POLICY_STATS_KEY, JSON.stringify(stats));
}

function incrementPolicyBlocked(tool: string): AiPolicyStats {
  const current = readPolicyStats();
  const next: AiPolicyStats = {
    blockedCount: current.blockedCount + 1,
    blockedByTool: {
      ...current.blockedByTool,
      [tool]: (current.blockedByTool[tool] ?? 0) + 1
    },
    lastBlockedAt: new Date().toISOString()
  };
  writePolicyStats(next);
  return next;
}

async function reportPolicyEvent(tool: string, reason: string, source: "editor" | "remote-plan" | "unknown"): Promise<void> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    return;
  }

  try {
    await fetch("/api/me/ai-config/policy-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      },
      body: JSON.stringify({
        event: source === "remote-plan" ? "blocked_remote_plan" : "blocked_tool",
        tool,
        reason,
        source
      })
    });
  } catch {
    // Ignore telemetry errors.
  }
}

export function getAiPolicyStats(): AiPolicyStats {
  return readPolicyStats();
}

export function resetAiPolicyStats(): void {
  writePolicyStats({
    blockedCount: 0,
    blockedByTool: {},
    lastBlockedAt: null
  });
}

export function getLastAiPlanMeta(): AiPlanMeta {
  return lastPlanMeta;
}

export function isDestructiveToolCall(toolCall: AiToolCall): boolean {
  return toolCall.tool === "delete_nodes";
}

export function hasDestructiveToolCalls(toolCalls: AiToolCall[]): boolean {
  return toolCalls.some((toolCall) => isDestructiveToolCall(toolCall));
}

function countRequestedNodes(toolCalls: AiToolCall[]): number {
  return toolCalls.reduce((acc, toolCall) => {
    if (toolCall.tool === "create_primitive") {
      return acc + 1;
    }
    if (toolCall.tool === "insert_template") {
      return acc + 1;
    }
    if (toolCall.tool === "duplicate") {
      return acc + toolCall.args.nodeIds.length;
    }
    return acc;
  }, 0);
}

function countBooleanOps(toolCalls: AiToolCall[]): number {
  return toolCalls.reduce((acc, toolCall) => (toolCall.tool === "add_boolean" ? acc + 1 : acc), 0);
}

function validateToolCall(toolCall: AiToolCall): string | null {
  if (toolCall.tool === "create_primitive" && !toolCall.args.primitive) {
    return "create_primitive requires primitive";
  }

  if (toolCall.tool === "group" && toolCall.args.nodeIds.length < 2) {
    return "group requires at least 2 node ids";
  }

  if (toolCall.tool === "delete_nodes" && toolCall.args.nodeIds.length === 0) {
    return "delete_nodes requires at least 1 node id";
  }

  if (toolCall.tool === "assign_material_batch") {
    if (toolCall.args.nodeIds.length === 0) {
      return "assign_material_batch requires at least 1 node id";
    }
    if (toolCall.args.nodeIds.length > MAX_NODES_PER_REQUEST) {
      return `assign_material_batch exceeds max nodes (${MAX_NODES_PER_REQUEST})`;
    }
  }

  if (toolCall.tool === "create_material_batch") {
    if (toolCall.args.materials.length === 0) {
      return "create_material_batch requires at least 1 material";
    }
    if (toolCall.args.materials.length > MAX_MATERIAL_MUTATIONS_PER_REQUEST) {
      return `create_material_batch exceeds max materials (${MAX_MATERIAL_MUTATIONS_PER_REQUEST})`;
    }
  }

  if (toolCall.tool === "update_material_batch") {
    if (toolCall.args.updates.length === 0) {
      return "update_material_batch requires at least 1 update";
    }
    if (toolCall.args.updates.length > MAX_MATERIAL_MUTATIONS_PER_REQUEST) {
      return `update_material_batch exceeds max updates (${MAX_MATERIAL_MUTATIONS_PER_REQUEST})`;
    }
  }

  if (toolCall.tool === "assign_agent_tools" && toolCall.args.updates.length === 0) {
    return "assign_agent_tools requires at least 1 update";
  }
  if (toolCall.tool === "assign_agent_tools" && toolCall.args.updates.length > MAX_AGENT_MUTATIONS_PER_REQUEST) {
    return `assign_agent_tools exceeds max updates (${MAX_AGENT_MUTATIONS_PER_REQUEST})`;
  }

  if (toolCall.tool === "assign_agent_skills" && toolCall.args.updates.length === 0) {
    return "assign_agent_skills requires at least 1 update";
  }
  if (toolCall.tool === "assign_agent_skills" && toolCall.args.updates.length > MAX_AGENT_MUTATIONS_PER_REQUEST) {
    return `assign_agent_skills exceeds max updates (${MAX_AGENT_MUTATIONS_PER_REQUEST})`;
  }

  if ((toolCall.tool === "export_stl" || toolCall.tool === "export_glb") && toolCall.args.selectionIds && toolCall.args.selectionIds.length > MAX_NODES_PER_REQUEST) {
    return `export selection exceeds max nodes (${MAX_NODES_PER_REQUEST})`;
  }

  return null;
}

async function executeAuthedApi(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<{ ok: boolean; body: unknown; status: number }> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    return { ok: false, body: { error: "No session token. Login first in /app." }, status: 401 };
  }

  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const parsedBody = (await response.json().catch(() => ({}))) as unknown;
  return {
    ok: response.ok,
    body: parsedBody,
    status: response.status
  };
}

async function executeCreateCardDraft(toolCall: Extract<AiToolCall, { tool: "create_card_draft" }>): Promise<AiExecutionResult> {
  const response = await executeAuthedApi("/api/cards/drafts", "POST", toolCall.args);
  if (!response.ok) {
    return {
      ok: false,
      tool: toolCall.tool,
      error: `HTTP ${response.status}: ${JSON.stringify(response.body)}`
    };
  }

  return {
    ok: true,
    tool: toolCall.tool,
    result: response.body
  };
}

async function executeCreateAgent(toolCall: Extract<AiToolCall, { tool: "create_agent" }>): Promise<AiExecutionResult> {
  const response = await executeAuthedApi("/api/agents", "POST", {
    name: toolCall.args.name,
    role: toolCall.args.role,
    detail: toolCall.args.detail,
    personality: toolCall.args.personality,
    lore: toolCall.args.lore,
    memoryScope: toolCall.args.memoryScope ?? "private"
  });

  if (!response.ok) {
    return {
      ok: false,
      tool: toolCall.tool,
      error: `HTTP ${response.status}: ${JSON.stringify(response.body)}`
    };
  }

  return {
    ok: true,
    tool: toolCall.tool,
    result: response.body
  };
}

async function executeAssignAgentTools(toolCall: Extract<AiToolCall, { tool: "assign_agent_tools" }>): Promise<AiExecutionResult> {
  const response = await executeAuthedApi(`/api/agents/${toolCall.args.agentId}/tools`, "POST", {
    updates: toolCall.args.updates
  });

  if (!response.ok) {
    return {
      ok: false,
      tool: toolCall.tool,
      error: `HTTP ${response.status}: ${JSON.stringify(response.body)}`
    };
  }

  return {
    ok: true,
    tool: toolCall.tool,
    result: response.body
  };
}

async function executeAssignAgentSkills(toolCall: Extract<AiToolCall, { tool: "assign_agent_skills" }>): Promise<AiExecutionResult> {
  const response = await executeAuthedApi(`/api/agents/${toolCall.args.agentId}/skills`, "POST", {
    updates: toolCall.args.updates.map((item) => ({
      skillId: item.skillId,
      enabled: item.enabled ?? true,
      remove: item.remove ?? false,
      config: item.config ?? {}
    }))
  });

  if (!response.ok) {
    return {
      ok: false,
      tool: toolCall.tool,
      error: `HTTP ${response.status}: ${JSON.stringify(response.body)}`
    };
  }

  return {
    ok: true,
    tool: toolCall.tool,
    result: response.body
  };
}

function normalizeExportFilename(filename: string | undefined, fallbackBase: string, extension: "stl" | "glb"): string {
  const fallback = `${fallbackBase}.${extension}`;
  const trimmed = (filename ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.toLowerCase().endsWith(`.${extension}`) ? trimmed : `${trimmed}.${extension}`;
}

function triggerBlobDownload(blob: Blob, filename: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return false;
  }

  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}

async function executeLocalTool(
  toolCall: Exclude<AiToolCall, { tool: "create_card_draft" | "create_agent" | "assign_agent_tools" | "assign_agent_skills" }>
): Promise<AiExecutionResult> {
  if (toolCall.tool === "get_scene") {
    const snapshot = engineApi.getProjectSnapshot();
    return {
      ok: true,
      tool: toolCall.tool,
      result: {
        nodes: Object.values(snapshot.nodes),
        selection: engineApi.getSelection(),
        units: snapshot.units,
        grid: snapshot.grid
      }
    };
  }

  if (toolCall.tool === "list_assets") {
    if (toolCall.args.kind === "materials") {
      return {
        ok: true,
        tool: toolCall.tool,
        result: engineApi.listMaterials()
      };
    }
    return {
      ok: true,
      tool: toolCall.tool,
      result: engineApi.listTemplates()
    };
  }

  if (toolCall.tool === "create_primitive") {
    const nodeId = engineApi.createPrimitive(
      toolCall.args.primitive,
      toolCall.args.params,
      toolCall.args.transform,
      toolCall.args.materialId
    );
    return {
      ok: true,
      tool: toolCall.tool,
      result: { nodeId }
    };
  }

  if (toolCall.tool === "set_transform") {
    engineApi.setNodeTransform(toolCall.args.nodeId, toolCall.args.transformPatch);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "set_params") {
    engineApi.setNodeParams(toolCall.args.nodeId, toolCall.args.paramsPatch);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "group") {
    const groupId = toolCall.args.mode
      ? engineApi.createGroup(toolCall.args.nodeIds, toolCall.args.mode)
      : engineApi.group(toolCall.args.nodeIds);
    return { ok: true, tool: toolCall.tool, result: { groupId } };
  }

  if (toolCall.tool === "toggle_hole") {
    engineApi.toggleHole(toolCall.args.nodeId);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "assign_material") {
    engineApi.setNodeMaterial(toolCall.args.nodeId, toolCall.args.materialId);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "assign_material_batch") {
    let assigned = 0;
    for (const nodeId of toolCall.args.nodeIds) {
      engineApi.setNodeMaterial(nodeId, toolCall.args.materialId);
      assigned += 1;
    }
    return { ok: true, tool: toolCall.tool, result: { assigned } };
  }

  if (toolCall.tool === "create_material") {
    const materialId = engineApi.createMaterial(toolCall.args.kind, {
      name: toolCall.args.name,
      color: toolCall.args.color,
      pbr: toolCall.args.pbr
    });
    return { ok: true, tool: toolCall.tool, result: { materialId } };
  }

  if (toolCall.tool === "create_material_batch") {
    const materialIds: string[] = [];
    for (const seed of toolCall.args.materials) {
      const materialId = engineApi.createMaterial(seed.kind, {
        name: seed.name,
        color: seed.color,
        pbr: seed.pbr
      });
      materialIds.push(materialId);
    }
    return { ok: true, tool: toolCall.tool, result: { materialIds, created: materialIds.length } };
  }

  if (toolCall.tool === "update_material") {
    engineApi.updateMaterial(toolCall.args.materialId, toolCall.args.patch);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "update_material_batch") {
    let updated = 0;
    for (const update of toolCall.args.updates) {
      engineApi.updateMaterial(update.materialId, update.patch);
      updated += 1;
    }
    return { ok: true, tool: toolCall.tool, result: { updated } };
  }

  if (toolCall.tool === "insert_template") {
    const insertedRootIds = engineApi.insertTemplate(toolCall.args.templateId, toolCall.args.parentId);
    return { ok: true, tool: toolCall.tool, result: { insertedRootIds } };
  }

  if (toolCall.tool === "delete_nodes") {
    const totalNodes = Object.keys(engineApi.getProjectSnapshot().nodes).length;
    if (toolCall.args.nodeIds.length >= totalNodes - 1) {
      return { ok: false, tool: toolCall.tool, error: "Refusing delete_nodes for entire scene." };
    }
    engineApi.deleteNodes(toolCall.args.nodeIds);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "duplicate") {
    const newIds = engineApi.duplicateNodes(toolCall.args.nodeIds);
    return { ok: true, tool: toolCall.tool, result: { newIds } };
  }

  if (toolCall.tool === "add_boolean") {
    const opId = engineApi.addBooleanOp(toolCall.args.op, toolCall.args.aId, toolCall.args.bId);
    return { ok: true, tool: toolCall.tool, result: { opId } };
  }

  if (toolCall.tool === "frame") {
    engineApi.frameSelection(toolCall.args.nodeIds);
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "set_grid") {
    engineApi.setGrid({
      size: toolCall.args.size,
      snap: toolCall.args.snap,
      angleSnap: toolCall.args.angleSnap
    });
    return { ok: true, tool: toolCall.tool };
  }

  if (toolCall.tool === "export_stl") {
    const blob = await engineApi.exportSTL(toolCall.args.selectionIds);
    const filename = normalizeExportFilename(toolCall.args.filename, "reycad-export", "stl");
    const downloaded = triggerBlobDownload(blob, filename);
    return {
      ok: true,
      tool: toolCall.tool,
      result: {
        filename,
        bytes: blob.size,
        downloaded
      }
    };
  }

  if (toolCall.tool === "export_glb") {
    const blob = await engineApi.exportGLB(toolCall.args.selectionIds);
    const filename = normalizeExportFilename(toolCall.args.filename, "reycad-export", "glb");
    const downloaded = triggerBlobDownload(blob, filename);
    return {
      ok: true,
      tool: toolCall.tool,
      result: {
        filename,
        bytes: blob.size,
        downloaded
      }
    };
  }

  return { ok: false, tool: "unknown", error: "Unsupported tool call" };
}

export async function executeToolCalls(toolCalls: AiToolCall[], options?: ExecuteToolCallsOptions): Promise<AiExecutionResult[]> {
  const bounded = toolCalls.slice(0, MAX_TOOLCALLS_PER_REQUEST);
  const yieldEvery = Math.max(1, Math.min(50, options?.yieldEvery ?? DEFAULT_YIELD_EVERY));
  const batchSize = Math.max(1, Math.min(40, options?.batchSize ?? 10));
  const permissions = options?.permissions ?? loadAiPermissionsLocal();
  const requestedNodes = countRequestedNodes(bounded);
  if (requestedNodes > MAX_NODES_PER_REQUEST) {
    return [
      {
        ok: false,
        tool: "request",
        error: `Node limit exceeded: ${requestedNodes} > ${MAX_NODES_PER_REQUEST}`
      }
    ];
  }

  const requestedBooleanOps = countBooleanOps(bounded);
  if (requestedBooleanOps > MAX_BOOLEAN_OPS_PER_REQUEST) {
    return [
      {
        ok: false,
        tool: "request",
        error: `Boolean op limit exceeded: ${requestedBooleanOps} > ${MAX_BOOLEAN_OPS_PER_REQUEST}`
      }
    ];
  }

  const results: AiExecutionResult[] = [];
  const totalBatches = Math.ceil(bounded.length / batchSize);
  let wasCancelled = false;

  for (let batchStart = 0, batchIndex = 0; batchStart < bounded.length; batchStart += batchSize, batchIndex += 1) {
    if (options?.signal?.aborted) {
      wasCancelled = true;
      break;
    }

    const batchEnd = Math.min(batchStart + batchSize, bounded.length);
    options?.onBatch?.(batchIndex + 1, totalBatches, batchStart + 1, batchEnd);

    for (let index = batchStart; index < batchEnd; index += 1) {
      if (options?.signal?.aborted) {
        wasCancelled = true;
        break;
      }

      const toolCall = bounded[index];
      if (!isToolAllowedByPermissions(toolCall, permissions)) {
        const blockedBy = blockedPermissionReasons(toolCall, permissions).join(", ");
        incrementPolicyBlocked(toolCall.tool);
        void reportPolicyEvent(toolCall.tool, blockedBy || "policy", "editor");
        results.push({
          ok: false,
          tool: toolCall.tool,
          error: `Blocked by AI permissions: ${blockedBy || "policy"}`
        });
        options?.onProgress?.(index + 1, bounded.length);
        continue;
      }

      const validationError = validateToolCall(toolCall);
      if (validationError) {
        results.push({ ok: false, tool: toolCall.tool, error: validationError });
        options?.onProgress?.(index + 1, bounded.length);
        continue;
      }

      try {
        if (toolCall.tool === "create_card_draft") {
          results.push(await executeCreateCardDraft(toolCall));
        } else if (toolCall.tool === "create_agent") {
          results.push(await executeCreateAgent(toolCall));
        } else if (toolCall.tool === "assign_agent_tools") {
          results.push(await executeAssignAgentTools(toolCall));
        } else if (toolCall.tool === "assign_agent_skills") {
          results.push(await executeAssignAgentSkills(toolCall));
        } else {
          results.push(await executeLocalTool(toolCall));
        }
      } catch (error) {
        results.push({
          ok: false,
          tool: toolCall.tool,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      options?.onProgress?.(index + 1, bounded.length);
      if ((index + 1) % yieldEvery === 0 && index + 1 < bounded.length) {
        await yieldToEventLoop();
      }
    }

    if (wasCancelled) {
      break;
    }

    if (batchEnd < bounded.length) {
      await yieldToEventLoop();
    }
  }

  if (wasCancelled) {
    results.push({
      ok: false,
      tool: "request",
      error: "Execution cancelled"
    });
  }

  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRemoteToolCalls(payload: unknown): AiToolCall[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.toolCalls)) {
    return null;
  }

  const calls: AiToolCall[] = [];
  for (const item of payload.toolCalls) {
    if (!isRecord(item) || typeof item.tool !== "string" || !isRecord(item.args)) {
      return null;
    }
    calls.push(item as AiToolCall);
  }
  return calls;
}

function buildSceneDigest(): Record<string, unknown> {
  const snapshot = engineApi.getProjectSnapshot();
  const nodes = Object.values(snapshot.nodes).slice(0, 220);
  return {
    units: snapshot.units,
    grid: snapshot.grid,
    selection: engineApi.getSelection(),
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      parentId: node.parentId,
      mode: node.mode,
      materialId: node.materialId,
      transform: node.transform,
      primitive: node.type === "primitive" ? node.primitive : undefined,
      params: node.type === "primitive" ? node.params : undefined
    }))
  };
}

type RemotePlanFetchResult = {
  calls: AiToolCall[] | null;
  reason: string;
};

async function fetchRemoteToolCalls(prompt: string, permissions: AiPermissions): Promise<RemotePlanFetchResult> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    return { calls: null, reason: "no-session-token" };
  }

  try {
    const response = await fetch("/api/me/ai-config/tool-plan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      },
      body: JSON.stringify({
        prompt,
        scene: buildSceneDigest(),
        permissions
      })
    });
    const body = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      if (typeof body === "object" && body !== null) {
        const rawTools = (body as Record<string, unknown>).disallowedTools;
        if (Array.isArray(rawTools)) {
          for (const item of rawTools) {
            if (typeof item === "string") {
              incrementPolicyBlocked(item);
              void reportPolicyEvent(item, "blocked by remote plan policy", "remote-plan");
            }
          }
          return { calls: null, reason: "remote-plan-policy-block" };
        }
      }
      return { calls: null, reason: `remote-http-${response.status}` };
    }
    const calls = normalizeRemoteToolCalls(body);
    if (!calls) {
      return { calls: null, reason: "remote-invalid-payload" };
    }
    return { calls, reason: "remote-ok" };
  } catch {
    return { calls: null, reason: "remote-network-error" };
  }
}

function inferToolCallsFromPromptLocal(prompt: string): AiToolCall[] {
  const command = parseSimpleDsl(prompt);
  if (command.kind === "create") {
    return [{ tool: "create_primitive", args: { primitive: command.primitive } }];
  }

  const normalized = prompt.toLowerCase();
  if (normalized.includes("scene") || normalized.includes("estado")) {
    return [{ tool: "get_scene", args: {} }];
  }

  if (normalized.includes("export stl") || normalized.includes("exportar stl")) {
    return [{ tool: "export_stl", args: {} }];
  }

  if (normalized.includes("export glb") || normalized.includes("exportar glb")) {
    return [{ tool: "export_glb", args: {} }];
  }

  if (normalized.includes("template") || normalized.includes("plantilla")) {
    return [{ tool: "list_assets", args: { kind: "templates" } }];
  }

  if (normalized.includes("agente") || normalized.includes("agent")) {
    return [
      {
        tool: "create_agent",
        args: {
          name: "ReyCAD Assistant Agent",
          role: "builder",
          detail: "Executes structured build tasks from AI plans.",
          memoryScope: "private"
        }
      }
    ];
  }

  if (normalized.includes("crear material") || normalized.includes("nuevo material")) {
    return [
      {
        tool: "create_material",
        args: {
          kind: "pbr",
          name: "AI Material",
          pbr: {
            metalness: 0.35,
            roughness: 0.45,
            baseColor: "#8fa4b8"
          }
        }
      }
    ];
  }

  if (normalized.includes("materiales por lote") || normalized.includes("batch material")) {
    return [
      {
        tool: "create_material_batch",
        args: {
          materials: [
            {
              kind: "solidColor",
              name: "AI Solid A",
              color: "#6f8cab"
            },
            {
              kind: "pbr",
              name: "AI PBR B",
              pbr: {
                metalness: 0.4,
                roughness: 0.5,
                baseColor: "#9ca7b8"
              }
            }
          ]
        }
      }
    ];
  }

  if (normalized.includes("material")) {
    return [{ tool: "list_assets", args: { kind: "materials" } }];
  }

  if (normalized.includes("agrupar") || normalized.includes("group")) {
    return [{ tool: "get_scene", args: {} }];
  }

  if (normalized.includes("carta") || normalized.includes("card")) {
    const hasLegendary = normalized.includes("legend");
    const hasTank = normalized.includes("tank") || normalized.includes("guardian");
    const hasFast = normalized.includes("speed") || normalized.includes("agil") || normalized.includes("fast");

    return [
      {
        tool: "create_card_draft",
        args: {
          name: hasLegendary ? "Imperial Legend Core" : "Imperial Forge Card",
          rarity: hasLegendary ? "legendary" : "epic",
          cardClass: hasTank ? "guardian" : hasFast ? "assassin" : "warrior",
          abilities: hasTank ? ["shield", "regen"] : hasFast ? ["quick-step", "pierce"] : ["fury", "berserk"],
          summonCost: hasLegendary ? 7 : 5,
          energy: hasLegendary ? 8 : 6,
          baseStats: hasTank ? { attack: 10, defense: 16, speed: 7 } : hasFast ? { attack: 12, defense: 8, speed: 14 } : { attack: 13, defense: 10, speed: 8 }
        }
      }
    ];
  }

  return [];
}

export async function inferToolCallsFromPrompt(prompt: string, permissions?: AiPermissions): Promise<AiToolCall[]> {
  const effectivePermissions = permissions ?? loadAiPermissionsLocal();
  const remote = await fetchRemoteToolCalls(prompt, effectivePermissions);
  if (remote.calls && remote.calls.length > 0) {
    lastPlanMeta = {
      source: "remote",
      reason: "remote-ok",
      at: new Date().toISOString()
    };
    return remote.calls;
  }
  const local = inferToolCallsFromPromptLocal(prompt);
  const fallbackSource = remote.reason === "no-session-token" ? "local" : "local-fallback";
  lastPlanMeta = {
    source: fallbackSource,
    reason: remote.reason,
    at: new Date().toISOString()
  };
  return local;
}
