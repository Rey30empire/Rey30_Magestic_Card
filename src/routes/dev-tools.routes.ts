import { Router } from "express";
import { z } from "zod";
import { auditLog, get } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requireNoAbuseBlock } from "../middleware/abuse-block";
import { sensitiveRateLimit } from "../middleware/rate-limit";
import { AgentToolRunStatus, recordAgentToolRun } from "../services/agent-tool-runs";
import { recordAbuseRiskEvent } from "../services/abuse-detection";
import { checkAgentSandboxGate } from "../services/sandbox-gate";
import { executeToolAction, getToolDefinition } from "../services/tools-registry";
import { env } from "../config/env";

type AgentRow = {
  id: string;
  owner_user_id: string;
  status: string;
};

const runToolSchema = z.object({
  agentId: z.string().uuid().optional(),
  input: z.unknown()
});

export const devToolsRouter = Router();
const sensitiveDevToolsLimiter = sensitiveRateLimit({
  windowMs: env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxPerUser: env.SENSITIVE_RATE_LIMIT_MAX_PER_USER,
  maxPerToken: env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN,
  maxBuckets: env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS
});
const abuseGuard = requireNoAbuseBlock();

function recordDevToolsRiskEvent(
  userId: string | undefined,
  eventKey: string,
  metadata: Record<string, unknown>,
  requestId?: string | null,
  traceId?: string | null
): void {
  if (!userId) {
    return;
  }

  void recordAbuseRiskEvent({
    userId,
    source: "dev-tools",
    eventKey,
    metadata,
    requestId: requestId ?? null,
    traceId: traceId ?? null
  }).catch((error) => {
    console.error("[abuse-risk] failed to record dev-tools event", error);
  });
}

async function safeRecordToolRun(input: {
  userId: string;
  toolKey: string;
  status: AgentToolRunStatus;
  startedAt: number;
  agentId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  runInput: unknown;
  runOutput?: unknown;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    await recordAgentToolRun({
      agentId: input.agentId ?? null,
      userId: input.userId,
      toolKey: input.toolKey,
      status: input.status,
      latencyMs: Date.now() - input.startedAt,
      inputPayload: input.runInput,
      outputPayload: input.runOutput,
      errorMessage: input.errorMessage ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null
    });
  } catch (error) {
    console.error("[dev-tools] failed to persist tool run history", error);
  }
}

devToolsRouter.post(
  "/:toolKey/run",
  authRequired,
  sensitiveDevToolsLimiter,
  abuseGuard,
  async (req, res) => {
    const startedAt = Date.now();
    const toolKey = String(req.params.toolKey);
    const parsed = runToolSchema.safeParse(req.body);
    if (!parsed.success) {
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "failed",
        startedAt,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: req.body,
        errorMessage: "invalid-payload"
      });
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const tool = getToolDefinition(toolKey);
    if (!tool) {
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "failed",
        startedAt,
        agentId: parsed.data.agentId ?? null,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: parsed.data.input,
        errorMessage: "unsupported-tool"
      });
      res.status(404).json({ error: "Unsupported tool", toolKey });
      return;
    }

    const isAdmin = (req.user!.roles ?? []).includes("admin");
    const userRoles = new Set(req.user!.roles ?? [req.user!.role]);
    if (!isAdmin && !userRoles.has("approvedCreator")) {
      recordDevToolsRiskEvent(
        req.user?.id,
        "dev-tools.permission-denied",
        { toolKey, reason: "role", requiredRole: "approvedCreator" },
        req.requestId,
        req.traceId
      );
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "denied",
        startedAt,
        agentId: parsed.data.agentId ?? null,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: parsed.data.input,
        errorMessage: "insufficient-role"
      });
      res.status(403).json({ error: "Insufficient role", requiredRoles: ["approvedCreator"] });
      return;
    }

    const userPermissions = new Set(req.user!.permissions ?? []);
    if (!isAdmin && !userPermissions.has(tool.requiredPermission)) {
      recordDevToolsRiskEvent(
        req.user?.id,
        "dev-tools.permission-denied",
        { toolKey, reason: "permission", requiredPermission: tool.requiredPermission },
        req.requestId,
        req.traceId
      );
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "denied",
        startedAt,
        agentId: parsed.data.agentId ?? null,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: parsed.data.input,
        errorMessage: "missing-permission"
      });
      res.status(403).json({
        error: "Missing tool permission",
        requiredPermission: tool.requiredPermission
      });
      return;
    }

    const agentId = parsed.data.agentId;
    if (agentId) {
      const agent = isAdmin
        ? await get<AgentRow>("SELECT id, owner_user_id, status FROM agents WHERE id = ?", [agentId])
        : await get<AgentRow>("SELECT id, owner_user_id, status FROM agents WHERE id = ? AND owner_user_id = ?", [agentId, req.user!.id]);

      if (!agent) {
        await safeRecordToolRun({
          userId: req.user!.id,
          toolKey,
          status: "failed",
          startedAt,
          agentId,
          requestId: req.requestId ?? null,
          traceId: req.traceId ?? null,
          runInput: parsed.data.input,
          errorMessage: "agent-not-found"
        });
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      if (agent.status === "suspended") {
        await safeRecordToolRun({
          userId: req.user!.id,
          toolKey,
          status: "blocked",
          startedAt,
          agentId: agent.id,
          requestId: req.requestId ?? null,
          traceId: req.traceId ?? null,
          runInput: parsed.data.input,
          errorMessage: "agent-suspended"
        });
        res.status(409).json({ error: "Agent is suspended" });
        return;
      }

      const assignment = await get<{ id: string }>(
        "SELECT id FROM agent_tools WHERE agent_id = ? AND tool_key = ? AND allowed = 1",
        [agent.id, toolKey]
      );
      if (!assignment) {
        recordDevToolsRiskEvent(
          req.user?.id,
          "dev-tools.tool-unassigned",
          { toolKey, agentId: agent.id },
          req.requestId,
          req.traceId
        );
        await safeRecordToolRun({
          userId: req.user!.id,
          toolKey,
          status: "blocked",
          startedAt,
          agentId: agent.id,
          requestId: req.requestId ?? null,
          traceId: req.traceId ?? null,
          runInput: parsed.data.input,
          errorMessage: "tool-not-assigned"
        });
        res.status(403).json({
          error: "Tool not assigned to agent",
          toolKey,
          agentId
        });
        return;
      }

      const sandboxGate = await checkAgentSandboxGate(agent.id);
      if (!sandboxGate.ok) {
        recordDevToolsRiskEvent(
          req.user?.id,
          "dev-tools.sandbox-blocked",
          { toolKey, agentId: agent.id, reason: sandboxGate.reason },
          req.requestId,
          req.traceId
        );
        await safeRecordToolRun({
          userId: req.user!.id,
          toolKey,
          status: "blocked",
          startedAt,
          agentId: agent.id,
          requestId: req.requestId ?? null,
          traceId: req.traceId ?? null,
          runInput: parsed.data.input,
          errorMessage: `sandbox-${sandboxGate.reason}`
        });
        res.status(409).json({
          error: "Agent sandbox verification required before dev-tools execution",
          reason: sandboxGate.reason,
          agentId: agent.id,
          latestTestId: sandboxGate.latestTestId,
          testedAt: sandboxGate.testedAt,
          ageMinutes: sandboxGate.ageMinutes,
          action: "Run POST /api/agents/:id/sandbox-test and retry"
        });
        return;
      }
    }

    try {
      const result = await executeToolAction(
        toolKey,
        {
          userId: req.user!.id,
          agentId
        },
        parsed.data.input
      );

      await auditLog(req.user!.id, "dev-tools.run", {
        toolKey,
        agentId: agentId ?? null
      });
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "success",
        startedAt,
        agentId: agentId ?? null,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: parsed.data.input,
        runOutput: result
      });

      res.json({
        ok: true,
        toolKey,
        agentId: agentId ?? null,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      recordDevToolsRiskEvent(
        req.user?.id,
        "dev-tools.execution-failed",
        { toolKey, agentId: parsed.data.agentId ?? null, message },
        req.requestId,
        req.traceId
      );
      await safeRecordToolRun({
        userId: req.user!.id,
        toolKey,
        status: "failed",
        startedAt,
        agentId: parsed.data.agentId ?? null,
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null,
        runInput: parsed.data.input,
        errorMessage: message
      });
      res.status(400).json({ error: message });
    }
  }
);
