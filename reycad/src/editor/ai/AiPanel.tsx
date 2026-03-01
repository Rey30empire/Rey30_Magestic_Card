import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { executeToolCalls, getAiPolicyStats, getLastAiPlanMeta, hasDestructiveToolCalls, inferToolCallsFromPrompt, resetAiPolicyStats } from "./aiBridge";
import { AI_PERMISSION_DEFINITIONS, createDefaultAiPermissions, loadAiPermissionsLocal, mergeAiPermissions, saveAiPermissionsLocal } from "./aiPermissions";
import type { AiExecutionResult, AiPermissions, AiToolCall } from "./aiSchema";
import { AI_SYSTEM_PROMPT } from "./aiPrompts";
import { useEditorStore } from "../state/editorStore";
import type { AiHistoryBlock, EditorAiHistory } from "../state/types";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type AiJob = {
  id: string;
  label: string;
  calls: AiToolCall[];
};

type BatchState = {
  batchIndex: number;
  totalBatches: number;
  from: number;
  to: number;
};

type AiRunSummary = {
  id: string;
  label: string;
  createdAt: string;
  total: number;
  ok: number;
  failed: number;
  blocked: number;
  topErrors: string[];
};

function tryParseToolCalls(input: string): AiToolCall[] | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as AiToolCall[];
    }
    if (parsed && typeof parsed === "object" && "tool" in (parsed as Record<string, unknown>)) {
      return [parsed as AiToolCall];
    }
    return null;
  } catch {
    return null;
  }
}

function summarizeToolCall(toolCall: AiToolCall): string {
  if (toolCall.tool === "create_primitive") {
    return `create_primitive(${toolCall.args.primitive})`;
  }
  if (toolCall.tool === "create_card_draft") {
    return `create_card_draft(${toolCall.args.name})`;
  }
  if (toolCall.tool === "delete_nodes") {
    return `delete_nodes(${toolCall.args.nodeIds.length})`;
  }
  if (toolCall.tool === "group") {
    return `group(${toolCall.args.nodeIds.length})`;
  }
  if (toolCall.tool === "duplicate") {
    return `duplicate(${toolCall.args.nodeIds.length})`;
  }
  if (toolCall.tool === "add_boolean") {
    return `add_boolean(${toolCall.args.op})`;
  }
  if (toolCall.tool === "create_material") {
    return `create_material(${toolCall.args.kind})`;
  }
  if (toolCall.tool === "update_material") {
    return `update_material(${toolCall.args.materialId})`;
  }
  if (toolCall.tool === "create_material_batch") {
    return `create_material_batch(${toolCall.args.materials.length})`;
  }
  if (toolCall.tool === "update_material_batch") {
    return `update_material_batch(${toolCall.args.updates.length})`;
  }
  if (toolCall.tool === "assign_material_batch") {
    return `assign_material_batch(${toolCall.args.nodeIds.length})`;
  }
  if (toolCall.tool === "create_agent") {
    return `create_agent(${toolCall.args.name})`;
  }
  if (toolCall.tool === "assign_agent_tools") {
    return `assign_agent_tools(${toolCall.args.agentId})`;
  }
  if (toolCall.tool === "assign_agent_skills") {
    return `assign_agent_skills(${toolCall.args.agentId})`;
  }
  if (toolCall.tool === "export_stl") {
    return "export_stl";
  }
  if (toolCall.tool === "export_glb") {
    return "export_glb";
  }
  return toolCall.tool;
}

function permissionsPreset(kind: "safe" | "modeling" | "agents" | "full"): AiPermissions {
  const base = createDefaultAiPermissions();
  if (kind === "safe") {
    return {
      ...base,
      readScene: true
    };
  }
  if (kind === "modeling") {
    return {
      ...base,
      readScene: true,
      createGeometry: true,
      editGeometry: true,
      materials: true,
      booleans: true,
      templates: true,
      grid: true
    };
  }
  if (kind === "agents") {
    return {
      ...base,
      readScene: true,
      cards: true,
      agents: true,
      skills: true,
      grid: true
    };
  }
  return {
    ...base,
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

export default function AiPanel(): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolPlan, setToolPlan] = useState<AiToolCall[]>([]);
  const [pendingPlan, setPendingPlan] = useState<AiToolCall[] | null>(null);
  const [selectedStepIndexes, setSelectedStepIndexes] = useState<number[]>([]);
  const [autoApply, setAutoApply] = useState(true);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [running, setRunning] = useState(false);
  const [currentJobLabel, setCurrentJobLabel] = useState<string | null>(null);
  const [jobQueue, setJobQueue] = useState<AiJob[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [permissions, setPermissions] = useState<AiPermissions>(() => loadAiPermissionsLocal());
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsSync, setPermissionsSync] = useState<"synced" | "local-only" | "error">("local-only");
  const [policyStats, setPolicyStats] = useState(() => getAiPolicyStats());
  const [planMeta, setPlanMeta] = useState(() => getLastAiPlanMeta());
  const [runHistory, setRunHistory] = useState<AiRunSummary[]>([]);
  const [lastPolicyWarning, setLastPolicyWarning] = useState<string | null>(null);
  const aiHistory = useEditorStore((state) => state.data.aiHistory);
  const addLog = useEditorStore((state) => state.addLog);
  const undoSteps = useEditorStore((state) => state.undoSteps);
  const redoSteps = useEditorStore((state) => state.redoSteps);
  const setAiHistory = useEditorStore((state) => state.setAiHistory);
  const undoStack = useEditorStore((state) => state.undoStack);
  const redoStack = useEditorStore((state) => state.redoStack);
  const processingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const systemPromptPreview = useMemo(() => AI_SYSTEM_PROMPT.split("\n").slice(0, 3).join(" "), []);
  const activePlan = pendingPlan ?? toolPlan;
  const planHasDestructiveActions = hasDestructiveToolCalls(activePlan);

  const normalizedSelectedStepIndexes = useMemo(
    () =>
      Array.from(new Set(selectedStepIndexes))
        .filter((index) => index >= 0 && index < activePlan.length)
        .sort((a, b) => a - b),
    [activePlan.length, selectedStepIndexes]
  );
  const selectedStepSet = useMemo(() => new Set(normalizedSelectedStepIndexes), [normalizedSelectedStepIndexes]);
  const selectedCalls = useMemo(
    () =>
      normalizedSelectedStepIndexes.flatMap((index) => {
        const value = activePlan[index];
        return value ? [value] : [];
      }),
    [activePlan, normalizedSelectedStepIndexes]
  );
  const selectedHasDestructiveActions = hasDestructiveToolCalls(selectedCalls);
  const nextSelectedIndex = normalizedSelectedStepIndexes[0];
  const nextSelectedCall = nextSelectedIndex === undefined ? null : activePlan[nextSelectedIndex];
  const nextStepNeedsConfirm = nextSelectedCall ? hasDestructiveToolCalls([nextSelectedCall]) : false;
  const pendingJobs = running ? jobQueue.slice(1) : jobQueue;
  const latestUndoBlock = aiHistory.undoBlocks[aiHistory.undoBlocks.length - 1] ?? null;
  const latestRedoBlock = aiHistory.redoBlocks[aiHistory.redoBlocks.length - 1] ?? null;
  const canUndoLatestBlock = useMemo(() => {
    if (!latestUndoBlock) {
      return false;
    }
    const currentDepth = undoStack.length;
    const currentTopId = undoStack[currentDepth - 1]?.id ?? null;
    return currentDepth === latestUndoBlock.afterDepth && currentTopId === latestUndoBlock.topCommandId;
  }, [latestUndoBlock, undoStack]);
  const canRedoLatestBlock = useMemo(() => {
    if (!latestRedoBlock) {
      return false;
    }
    const currentUndoDepth = undoStack.length;
    const currentRedoDepth = redoStack.length;
    const currentRedoTopId = redoStack[0]?.id ?? null;
    if (currentUndoDepth !== latestRedoBlock.beforeDepth || currentRedoDepth < latestRedoBlock.undoSteps) {
      return false;
    }
    if (latestRedoBlock.redoTopCommandId && currentRedoTopId !== latestRedoBlock.redoTopCommandId) {
      return false;
    }
    return true;
  }, [latestRedoBlock, redoStack, undoStack]);

  const addAssistantMessage = useCallback((text: string): void => {
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text }]);
  }, []);

  const enabledPermissionsCount = useMemo(
    () => Object.values(permissions).filter((value) => value).length,
    [permissions]
  );
  const syncLabel =
    permissionsSync === "synced" ? "Synced backend" : permissionsSync === "error" ? "Sync error" : "Local only";
  const planSourceLabel = planMeta.source === "remote" ? "Remote plan" : planMeta.source === "local-fallback" ? "Local fallback" : "Local plan";
  const permissionLabelByKey = useMemo(
    () =>
      Object.fromEntries(AI_PERMISSION_DEFINITIONS.map((item) => [item.key, item.label])) as Record<string, string>,
    []
  );
  const topBlockedTools = useMemo(
    () =>
      Object.entries(policyStats.blockedByTool)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
    [policyStats.blockedByTool]
  );

  const setPermissionValue = useCallback((key: keyof AiPermissions, value: boolean) => {
    setPermissions((current) => ({
      ...current,
      [key]: value
    }));
    setPermissionsDirty(true);
    setPermissionsSync("local-only");
  }, []);

  const savePermissions = useCallback(async () => {
    setPermissionsSaving(true);
    try {
      saveAiPermissionsLocal(permissions);
      const token = localStorage.getItem("rey30_frontend_token") ?? "";
      if (token) {
        const response = await fetch("/api/me/ai-config/permissions", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "x-client-platform": "web"
          },
          body: JSON.stringify({ permissions })
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as unknown;
          throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
        }
        setPermissionsSync("synced");
      } else {
        setPermissionsSync("local-only");
      }
      setPermissionsDirty(false);
      addAssistantMessage(`AI permissions saved (${enabledPermissionsCount}/${AI_PERMISSION_DEFINITIONS.length} enabled).`);
    } catch (error) {
      setPermissionsSync("error");
      addAssistantMessage(`Failed to save AI permissions: ${String(error)}`);
    } finally {
      setPermissionsSaving(false);
    }
  }, [addAssistantMessage, enabledPermissionsCount, permissions]);

  useEffect(() => {
    const token = localStorage.getItem("rey30_frontend_token") ?? "";
    if (!token) {
      setPermissionsSync("local-only");
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/me/ai-config", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-client-platform": "web"
          }
        });
        if (!response.ok) {
          setPermissionsSync("error");
          return;
        }
        const body = (await response.json()) as { permissions?: Partial<AiPermissions> };
        if (body.permissions && typeof body.permissions === "object") {
          const merged = mergeAiPermissions(createDefaultAiPermissions(), body.permissions);
          setPermissions(merged);
          saveAiPermissionsLocal(merged);
          setPermissionsDirty(false);
          setPermissionsSync("synced");
          return;
        }
        setPermissionsSync("local-only");
      } catch {
        setPermissionsSync("error");
      }
    })();
  }, []);

  const extractBlockedPolicyInfo = useCallback(
    (results: AiExecutionResult[]): { blockedCount: number; requiredLabels: string[] } => {
      const blockedErrors = results
        .filter((result) => !result.ok && typeof result.error === "string" && result.error.startsWith("Blocked by AI permissions:"))
        .map((result) => result.error as string);

      const required = new Set<string>();
      for (const error of blockedErrors) {
        const raw = error.split(":").slice(1).join(":");
        const keys = raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        for (const key of keys) {
          required.add(permissionLabelByKey[key] ?? key);
        }
      }

      return {
        blockedCount: blockedErrors.length,
        requiredLabels: Array.from(required)
      };
    },
    [permissionLabelByKey]
  );

  const summarizeResults = useCallback(
    (results: AiExecutionResult[], jobLabel: string): string => {
      const okCount = results.filter((result) => result.ok).length;
      const failCount = results.length - okCount;
      const blockedCount = results.filter(
        (result) => !result.ok && typeof result.error === "string" && result.error.startsWith("Blocked by AI permissions:")
      ).length;
      const details = results.map((result) => `${result.tool}: ${result.ok ? "ok" : result.error}`).join("\n");
      const blockedLine = blockedCount > 0 ? `, ${blockedCount} blocked by policy` : "";
      return `[${jobLabel}] Applied ${results.length} action(s): ${okCount} ok, ${failCount} failed${blockedLine}.\n${details}`;
    },
    []
  );

  const updateAiHistory = useCallback(
    (updater: (current: EditorAiHistory) => EditorAiHistory) => {
      const current = useEditorStore.getState().data.aiHistory;
      setAiHistory(updater(current));
    },
    [setAiHistory]
  );

  const undoLastAiBlock = useCallback(() => {
    const block = useEditorStore.getState().data.aiHistory.undoBlocks.slice(-1)[0];
    if (!block) {
      addAssistantMessage("No committed AI block to undo.");
      return;
    }

    const storeState = useEditorStore.getState();
    const currentDepth = storeState.undoStack.length;
    const currentTopId = storeState.undoStack[currentDepth - 1]?.id ?? null;
    if (currentDepth !== block.afterDepth || currentTopId !== block.topCommandId) {
      addAssistantMessage("Cannot undo AI block automatically because the undo stack changed. Use regular undo manually.");
      addLog("[ai] block undo skipped: stack drift detected");
      return;
    }

    const reverted = undoSteps(block.undoSteps);
    addLog(`[ai] block undo "${block.label}" reverted ${reverted}/${block.undoSteps} step(s)`);
    addAssistantMessage(`Undo block "${block.label}" reverted ${reverted}/${block.undoSteps} command(s).`);
    if (reverted === block.undoSteps) {
      const redoTopCommandId = useEditorStore.getState().redoStack[0]?.id ?? null;
      updateAiHistory((current) => ({
        undoBlocks: current.undoBlocks.slice(0, -1),
        redoBlocks: [...current.redoBlocks, { ...block, redoTopCommandId }].slice(-40)
      }));
    }
  }, [addAssistantMessage, addLog, undoSteps, updateAiHistory]);

  const redoLastAiBlock = useCallback(() => {
    const block = useEditorStore.getState().data.aiHistory.redoBlocks.slice(-1)[0];
    if (!block) {
      addAssistantMessage("No AI block available to redo.");
      return;
    }

    const storeState = useEditorStore.getState();
    const currentUndoDepth = storeState.undoStack.length;
    const currentRedoDepth = storeState.redoStack.length;
    const currentRedoTopId = storeState.redoStack[0]?.id ?? null;
    if (currentUndoDepth !== block.beforeDepth || currentRedoDepth < block.undoSteps) {
      addAssistantMessage("Cannot redo AI block automatically because the undo/redo stack changed.");
      addLog("[ai] block redo skipped: stack drift detected");
      return;
    }
    if (block.redoTopCommandId && currentRedoTopId !== block.redoTopCommandId) {
      addAssistantMessage("Cannot redo AI block: redo order changed.");
      addLog("[ai] block redo skipped: redo top mismatch");
      return;
    }

    const replayed = redoSteps(block.undoSteps);
    addLog(`[ai] block redo "${block.label}" replayed ${replayed}/${block.undoSteps} step(s)`);
    addAssistantMessage(`Redo block "${block.label}" replayed ${replayed}/${block.undoSteps} command(s).`);
    if (replayed === block.undoSteps) {
      const stateAfter = useEditorStore.getState();
      const afterDepth = stateAfter.undoStack.length;
      const topCommandId = stateAfter.undoStack[afterDepth - 1]?.id ?? null;
      updateAiHistory((current) => ({
        redoBlocks: current.redoBlocks.slice(0, -1),
        undoBlocks: [
          ...current.undoBlocks,
          {
            ...block,
            beforeDepth: afterDepth - replayed,
            afterDepth,
            topCommandId,
            redoTopCommandId: null
          }
        ].slice(-40)
      }));
    }
  }, [addAssistantMessage, addLog, redoSteps, updateAiHistory]);

  const queuePlan = useCallback(
    (calls: AiToolCall[], label: string, consumedIndexes: number[]) => {
      if (calls.length === 0) {
        return;
      }
      if (hasDestructiveToolCalls(calls) && !confirmDestructive) {
        addAssistantMessage("Destructive actions selected. Confirm destructive actions before queuing.");
        return;
      }

      const job: AiJob = {
        id: crypto.randomUUID(),
        label,
        calls
      };
      setJobQueue((current) => [...current, job]);
      setSelectedStepIndexes((current) => current.filter((index) => !consumedIndexes.includes(index)));
      setConfirmDestructive(false);
      addLog(`[ai] queued ${calls.length} action(s)`);
      addAssistantMessage(`Queued ${calls.length} action(s).`);
    },
    [addAssistantMessage, addLog, confirmDestructive]
  );

  const processQueue = useCallback(async () => {
    if (processingRef.current) {
      return;
    }
    const job = jobQueue[0];
    if (!job) {
      return;
    }

    processingRef.current = true;
    const abortController = new AbortController();
    abortRef.current = abortController;
    setRunning(true);
    setCurrentJobLabel(job.label);
    setProgress({ done: 0, total: job.calls.length });
    setBatch(null);
    const beforeUndoDepth = useEditorStore.getState().undoStack.length;

    try {
      const results = await executeToolCalls(job.calls, {
        yieldEvery: 6,
        batchSize: 10,
        permissions,
        signal: abortController.signal,
        onProgress: (done, total) => setProgress({ done, total }),
        onBatch: (batchIndex, totalBatches, from, to) => setBatch({ batchIndex, totalBatches, from, to })
      });
      addLog(`[ai] executed ${results.length} tool call(s)`);

      const okCount = results.filter((result) => result.ok).length;
      const failCount = results.length - okCount;
      const topErrors = Array.from(
        new Set(
          results
            .filter((result) => !result.ok && typeof result.error === "string")
            .map((result) => String(result.error))
            .filter((text) => text.length > 0)
        )
      ).slice(0, 3);

      const blockedInfo = extractBlockedPolicyInfo(results);
      if (blockedInfo.blockedCount > 0) {
        const required = blockedInfo.requiredLabels.length > 0 ? blockedInfo.requiredLabels.join(", ") : "required permissions";
        const warningText = `Policy blocked ${blockedInfo.blockedCount} action(s). Enable: ${required}.`;
        setLastPolicyWarning(warningText);
        addAssistantMessage(warningText);
      } else {
        setLastPolicyWarning(null);
      }

      setRunHistory((current) =>
        [
          {
            id: crypto.randomUUID(),
            label: job.label,
            createdAt: new Date().toISOString(),
            total: results.length,
            ok: okCount,
            failed: failCount,
            blocked: blockedInfo.blockedCount,
            topErrors
          },
          ...current
        ].slice(0, 20)
      );

      const undoStackAfter = useEditorStore.getState().undoStack;
      const afterUndoDepth = undoStackAfter.length;
      const committedSteps = Math.max(0, afterUndoDepth - beforeUndoDepth);
      const topCommandId = undoStackAfter[afterUndoDepth - 1]?.id ?? null;
      if (committedSteps > 0) {
        const block: AiHistoryBlock = {
          id: crypto.randomUUID(),
          label: job.label,
          undoSteps: committedSteps,
          beforeDepth: beforeUndoDepth,
          afterDepth: afterUndoDepth,
          topCommandId,
          redoTopCommandId: null,
          createdAt: new Date().toISOString()
        };
        updateAiHistory((current) => ({
          undoBlocks: [...current.undoBlocks, block].slice(-40),
          redoBlocks: []
        }));
        addLog(`[ai] block committed "${job.label}" (${committedSteps} command(s))`);
      } else {
        addLog(`[ai] block "${job.label}" had no undoable commands`);
      }
      addAssistantMessage(summarizeResults(results, job.label));
      if (pendingPlan && job.calls.length === pendingPlan.length) {
        setPendingPlan(null);
      }
    } catch (error) {
      addAssistantMessage(`[${job.label}] Execution error: ${String(error)}`);
      addLog(`[ai] error ${String(error)}`);
    } finally {
      abortRef.current = null;
      processingRef.current = false;
      setRunning(false);
      setCurrentJobLabel(null);
      setProgress(null);
      setBatch(null);
      setPolicyStats(getAiPolicyStats());
      setJobQueue((current) => {
        if (current[0]?.id === job.id) {
          return current.slice(1);
        }
        return current.filter((item) => item.id !== job.id);
      });
    }
  }, [addAssistantMessage, addLog, extractBlockedPolicyInfo, jobQueue, pendingPlan, permissions, summarizeResults, updateAiHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPolicyStats(getAiPolicyStats());
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void processQueue();
  }, [processQueue]);

  function onToggleStep(index: number): void {
    setSelectedStepIndexes((current) => {
      if (current.includes(index)) {
        return current.filter((item) => item !== index);
      }
      return [...current, index];
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) {
      return;
    }

    const userText = prompt.trim();
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: userText }]);

    const parsedToolCalls = tryParseToolCalls(userText);
    const planned = parsedToolCalls ?? (await inferToolCallsFromPrompt(userText, permissions));
    if (parsedToolCalls) {
      setPlanMeta({
        source: "local",
        reason: "manual-json",
        at: new Date().toISOString()
      });
    } else {
      setPlanMeta(getLastAiPlanMeta());
    }
    setToolPlan(planned);
    setPendingPlan(planned.length > 0 ? planned : null);
    setSelectedStepIndexes(planned.map((_, index) => index));
    setConfirmDestructive(false);
    setPrompt("");

    if (planned.length === 0) {
      addAssistantMessage("No tool calls inferred. Try JSON tool call or mention a primitive.");
      return;
    }

    if (enabledPermissionsCount === 0) {
      addAssistantMessage("All AI permissions are OFF. Enable permissions (red -> green) and save before applying.");
      return;
    }

    if (!autoApply || hasDestructiveToolCalls(planned)) {
      const modeLabel = hasDestructiveToolCalls(planned) ? "confirmation required (destructive actions)" : "manual apply mode";
      addAssistantMessage(`Plan ready with ${planned.length} action(s), ${modeLabel}.`);
      return;
    }

    queuePlan(planned, "auto plan", planned.map((_, index) => index));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>AI Chat</h3>
        <div className="row">
          <label className="toggle">
            <input checked={autoApply} onChange={(event) => setAutoApply(event.target.checked)} type="checkbox" />
            <span>Auto-apply</span>
          </label>
          <button className="btn" disabled={!latestUndoBlock || running || !canUndoLatestBlock} onClick={undoLastAiBlock} type="button">
            Undo AI block
          </button>
          <button className="btn" disabled={!latestRedoBlock || running || !canRedoLatestBlock} onClick={redoLastAiBlock} type="button">
            Redo AI block
          </button>
        </div>
      </div>

      <p className="muted">{systemPromptPreview}</p>
      <p className="muted">
        Plan source: <strong>{planSourceLabel}</strong> ({planMeta.reason})
      </p>

      <section className="perm-card stack-sm">
        <div className="panel-head">
          <h4>AI Permissions (Opt-In)</h4>
          <span className={`pill ${permissionsSync === "synced" ? "ok" : permissionsSync === "error" ? "warn" : ""}`}>
            {syncLabel}
          </span>
        </div>
        <p className="muted">
          Default policy is OFF. Red = blocked, green = allowed. Enabled: {enabledPermissionsCount}/{AI_PERMISSION_DEFINITIONS.length}.
        </p>
        <div className="perm-grid">
          {AI_PERMISSION_DEFINITIONS.map((definition) => {
            const isOn = permissions[definition.key];
            return (
              <button
                key={definition.key}
                className={`perm-toggle ${isOn ? "on" : "off"}`}
                onClick={() => setPermissionValue(definition.key, !isOn)}
                title={definition.description}
                type="button"
              >
                <span>{definition.label}</span>
                <strong>{isOn ? "ON" : "OFF"}</strong>
              </button>
            );
          })}
        </div>
        <div className="row wrap">
          <button
            className="btn btn-primary"
            disabled={permissionsSaving || !permissionsDirty}
            onClick={() => {
              void savePermissions();
            }}
            type="button"
          >
            Save Permissions
          </button>
          <button
            className="btn"
            disabled={permissionsSaving}
            onClick={() => {
              setPermissions(permissionsPreset("safe"));
              setPermissionsDirty(true);
              setPermissionsSync("local-only");
            }}
            type="button"
          >
            Modo Seguro
          </button>
          <button
            className="btn"
            disabled={permissionsSaving}
            onClick={() => {
              setPermissions(permissionsPreset("modeling"));
              setPermissionsDirty(true);
              setPermissionsSync("local-only");
            }}
            type="button"
          >
            Modo Modelado
          </button>
          <button
            className="btn"
            disabled={permissionsSaving}
            onClick={() => {
              setPermissions(permissionsPreset("agents"));
              setPermissionsDirty(true);
              setPermissionsSync("local-only");
            }}
            type="button"
          >
            Modo Agentes
          </button>
          <button
            className="btn"
            disabled={permissionsSaving}
            onClick={() => {
              setPermissions(permissionsPreset("full"));
              setPermissionsDirty(true);
              setPermissionsSync("local-only");
            }}
            type="button"
          >
            Full Manual
          </button>
          <button
            className="btn"
            disabled={permissionsSaving}
            onClick={() => {
              const none = createDefaultAiPermissions();
              setPermissions(none);
              setPermissionsDirty(true);
              setPermissionsSync("local-only");
            }}
            type="button"
          >
            Disable All
          </button>
        </div>

        <div className="row wrap">
          <span className="mono">Policy blocked: {policyStats.blockedCount}</span>
          {policyStats.lastBlockedAt && <span className="mono">last: {new Date(policyStats.lastBlockedAt).toLocaleTimeString()}</span>}
          <button
            className="btn"
            onClick={() => {
              resetAiPolicyStats();
              setPolicyStats(getAiPolicyStats());
            }}
            type="button"
          >
            Reset Policy Counter
          </button>
        </div>
        {lastPolicyWarning && <div className="warning">{lastPolicyWarning}</div>}
        {topBlockedTools.length > 0 && (
          <ul className="list">
            {topBlockedTools.map(([tool, count]) => (
              <li key={tool} className="list-item">
                <span>{tool}</span>
                <span className="mono">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="chat-list">
        {messages.map((message) => (
          <article key={message.id} className={`chat-item ${message.role}`}>
            <strong>{message.role === "user" ? "You" : "AI"}</strong>
            <pre>{message.text}</pre>
          </article>
        ))}
      </div>

      <form className="stack-sm" onSubmit={onSubmit}>
        <textarea
          className="input"
          rows={4}
          placeholder='Prompt or JSON tool call. Example: {"tool":"create_primitive","args":{"primitive":"box"}} or "crea una carta legendaria tanque"'
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button className="btn btn-primary" type="submit">
          Plan
        </button>
      </form>

      <div className="stack-sm">
        <div className="panel-head">
          <h4>Plan</h4>
          <div className="row wrap">
            <button className="btn" onClick={() => setSelectedStepIndexes(activePlan.map((_, index) => index))} type="button">
              Select all
            </button>
            <button className="btn" onClick={() => setSelectedStepIndexes([])} type="button">
              Clear
            </button>
            <button
              className="btn btn-primary"
              disabled={selectedCalls.length === 0 || (selectedHasDestructiveActions && !confirmDestructive)}
              onClick={() => queuePlan(selectedCalls, "selected plan", normalizedSelectedStepIndexes)}
              type="button"
            >
              Queue selected
            </button>
            <button
              className="btn"
              disabled={nextSelectedCall === null || (nextStepNeedsConfirm && !confirmDestructive)}
              onClick={() => {
                if (!nextSelectedCall || nextSelectedIndex === undefined) {
                  return;
                }
                queuePlan([nextSelectedCall], `step ${nextSelectedIndex + 1}`, [nextSelectedIndex]);
              }}
              type="button"
            >
              Queue next step
            </button>
          </div>
        </div>

        {planHasDestructiveActions && (
          <div className="warning">
            Plan includes destructive actions (`delete_nodes`). Confirm before queueing those steps.
          </div>
        )}

        <label className="toggle">
          <input
            checked={confirmDestructive}
            disabled={!planHasDestructiveActions}
            onChange={(event) => setConfirmDestructive(event.target.checked)}
            type="checkbox"
          />
          <span>Confirm destructive actions</span>
        </label>

        {activePlan.length > 0 && (
          <ul className="list">
            {activePlan.map((toolCall, index) => (
              <li key={`${toolCall.tool}-${index}`} className="list-item">
                <label className="toggle">
                  <input checked={selectedStepSet.has(index)} onChange={() => onToggleStep(index)} type="checkbox" />
                  <span>
                    {index + 1}. {summarizeToolCall(toolCall)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {running && progress && (
          <p className="muted">
            Running {currentJobLabel ?? "job"}: {progress.done}/{progress.total}
          </p>
        )}
        {running && batch && (
          <p className="muted">
            Batch {batch.batchIndex}/{batch.totalBatches} (steps {batch.from}-{batch.to})
          </p>
        )}

        <div className="row wrap">
          <button
            className="btn btn-danger"
            disabled={!running}
            onClick={() => {
              abortRef.current?.abort();
              addAssistantMessage("Cancel requested for current AI job.");
              addLog("[ai] cancel requested");
            }}
            type="button"
          >
            Cancel current
          </button>
          <button
            className="btn"
            disabled={pendingJobs.length === 0}
            onClick={() => {
              setJobQueue((current) => (running ? current.slice(0, 1) : []));
              addAssistantMessage("Pending AI queue cleared.");
            }}
            type="button"
          >
            Clear pending
          </button>
        </div>

        <p className="muted">
          Queue: {pendingJobs.length} pending
          {running ? `, processing ${currentJobLabel ?? "job"}` : ""}
        </p>
        {latestUndoBlock && (
          <p className="muted">
            Last AI block: {latestUndoBlock.label} ({latestUndoBlock.undoSteps} command(s))
            {!canUndoLatestBlock ? " | history only" : ""}
          </p>
        )}
        {latestRedoBlock && (
          <p className="muted">
            Redo AI block ready: {latestRedoBlock.label} ({latestRedoBlock.undoSteps} command(s))
            {!canRedoLatestBlock ? " | history only" : ""}
          </p>
        )}
        {pendingJobs.length > 0 && (
          <ul className="list">
            {pendingJobs.map((job) => (
              <li key={job.id} className="list-item">
                <span>{job.label}</span>
                <span className="mono">{job.calls.length} steps</span>
              </li>
            ))}
          </ul>
        )}

        <section className="perm-card stack-sm">
          <div className="panel-head">
            <h4>AI Block History</h4>
            <button className="btn" onClick={() => setRunHistory([])} type="button">
              Clear
            </button>
          </div>
          {runHistory.length === 0 ? (
            <p className="muted">No AI blocks executed yet.</p>
          ) : (
            <ul className="list">
              {runHistory.map((item) => (
                <li key={item.id} className="list-item">
                  <div className="stack-xs">
                    <strong>{item.label}</strong>
                    <span className="mono">
                      {new Date(item.createdAt).toLocaleTimeString()} · {item.ok}/{item.total} ok · {item.failed} failed
                      {item.blocked > 0 ? ` · ${item.blocked} blocked` : ""}
                    </span>
                    {item.topErrors.length > 0 && <span className="mono">{item.topErrors[0]}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <pre className="code">{JSON.stringify(activePlan, null, 2)}</pre>
      </div>
    </div>
  );
}
