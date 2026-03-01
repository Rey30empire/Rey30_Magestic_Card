import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";
import { createSkillSchema, listSkillsQuerySchema, promoteSkillSchema } from "../schemas/acs.schemas";
import { buildZodSchema, SchemaDefinition } from "../schemas/schema-definition";
import { listSupportedTools } from "../services/tools-registry";
import { parseJsonSafe } from "../utils/json";

type SkillRow = {
  id: string;
  name: string;
  version: string;
  description: string;
  input_schema: string;
  output_schema: string;
  required_tools: string;
  status: string;
  environment: "draft" | "staging" | "prod";
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type SkillTestRow = {
  id: string;
  skill_id: string;
  name: string;
  input_payload: string;
  expected_output: string;
  status: string;
  last_run_at: string | null;
  last_result: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type SkillPromotionRow = {
  id: string;
  skill_id: string;
  from_environment: "draft" | "staging" | "prod";
  to_environment: "draft" | "staging" | "prod";
  gate_status: string;
  gate_report: string;
  note: string | null;
  promoted_by: string | null;
  promoted_by_username: string | null;
  created_at: string;
};

const runTestsBodySchema = z.object({
  maxTests: z.number().int().min(1).max(200).default(100)
});
const skillPromotionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(200_000).default(0)
});

const ENV_TRANSITIONS: Record<"draft" | "staging" | "prod", Array<"draft" | "staging" | "prod">> = {
  draft: ["staging"],
  staging: ["draft", "prod"],
  prod: ["staging"]
};

function canPromote(from: "draft" | "staging" | "prod", to: "draft" | "staging" | "prod"): boolean {
  if (from === to) {
    return true;
  }

  return ENV_TRANSITIONS[from].includes(to);
}

async function evaluatePromotionGates(skill: SkillRow): Promise<{
  ok: boolean;
  issues: string[];
  testsChecked: number;
}> {
  const issues: string[] = [];
  const tests = await all<SkillTestRow>(
    `
      SELECT id, skill_id, name, input_payload, expected_output, status, last_run_at, last_result, created_by, created_at, updated_at
      FROM skill_tests
      WHERE skill_id = ?
      ORDER BY created_at ASC
      LIMIT 200
    `,
    [skill.id]
  );

  if (tests.length === 0) {
    issues.push("skill has no tests");
  }

  const inputDef = parseJsonSafe<SchemaDefinition>(skill.input_schema, { type: "object", properties: {} });
  const outputDef = parseJsonSafe<SchemaDefinition>(skill.output_schema, { type: "object", properties: {} });
  const inputSchema = buildZodSchema(inputDef);
  const outputSchema = buildZodSchema(outputDef);

  for (const test of tests) {
    const inputData = parseJsonSafe<unknown>(test.input_payload, {});
    const expectedOutput = parseJsonSafe<unknown>(test.expected_output, {});
    if (!inputSchema.safeParse(inputData).success) {
      issues.push(`test ${test.name} has invalid input`);
    }
    if (!outputSchema.safeParse(expectedOutput).success) {
      issues.push(`test ${test.name} has invalid expected output`);
    }
  }

  const supportedTools = new Set(listSupportedTools().map((tool) => tool.key));
  const requiredTools = parseJsonSafe<string[]>(skill.required_tools, []);
  const missingTools = requiredTools.filter((toolKey) => !supportedTools.has(toolKey));
  if (missingTools.length > 0) {
    issues.push(`missing required tools: ${missingTools.join(", ")}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    testsChecked: tests.length
  };
}

function mapSkill(row: SkillRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    environment: row.environment,
    inputSchema: parseJsonSafe<SchemaDefinition>(row.input_schema, { type: "object", properties: {} }),
    outputSchema: parseJsonSafe<SchemaDefinition>(row.output_schema, { type: "object", properties: {} }),
    requiredTools: parseJsonSafe<string[]>(row.required_tools, []),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSkillTest(row: SkillTestRow): Record<string, unknown> {
  return {
    id: row.id,
    skillId: row.skill_id,
    name: row.name,
    input: parseJsonSafe<unknown>(row.input_payload, {}),
    expectedOutput: parseJsonSafe<unknown>(row.expected_output, {}),
    status: row.status,
    lastRunAt: row.last_run_at,
    lastResult: parseJsonSafe<Record<string, unknown>>(row.last_result, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const skillsRouter = Router();

skillsRouter.post("/", authRequired, requirePermission("skills.create"), async (req, res) => {
  const parsed = createSkillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const supportedTools = new Set(listSupportedTools().map((tool) => tool.key));
  const unsupportedTools = parsed.data.requiredTools.filter((toolKey) => !supportedTools.has(toolKey));
  if (unsupportedTools.length > 0) {
    res.status(400).json({
      error: "Skill requires unsupported tools",
      unsupportedTools
    });
    return;
  }

  const existing = await get<{ id: string }>("SELECT id FROM skills_catalog WHERE name = ? AND version = ?", [
    parsed.data.name,
    parsed.data.version
  ]);
  if (existing) {
    res.status(409).json({ error: "Skill version already exists", skillId: existing.id });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO skills_catalog (
        id, name, version, description, input_schema, output_schema, required_tools, status, environment, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `,
    [
      id,
      parsed.data.name,
      parsed.data.version,
      parsed.data.description,
      JSON.stringify(parsed.data.inputSchema),
      JSON.stringify(parsed.data.outputSchema),
      JSON.stringify(parsed.data.requiredTools),
      parsed.data.environment,
      req.user!.id,
      now,
      now
    ]
  );

  for (const test of parsed.data.tests) {
    await run(
      `
        INSERT INTO skill_tests (
          id, skill_id, name, input_payload, expected_output, status, last_run_at, last_result, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, ?)
      `,
      [randomUUID(), id, test.name, JSON.stringify(test.input), JSON.stringify(test.expectedOutput), req.user!.id, now, now]
    );
  }

  await auditLog(req.user!.id, "skills.create", {
    skillId: id,
    name: parsed.data.name,
    version: parsed.data.version,
    testsCount: parsed.data.tests.length
  });

  res.status(201).json({
    id,
    testsCount: parsed.data.tests.length
  });
});

skillsRouter.get("/", authRequired, async (req, res) => {
  const parsed = listSkillsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (parsed.data.name) {
    where.push("name LIKE ?");
    params.push(`%${parsed.data.name}%`);
  }

  if (parsed.data.environment) {
    where.push("environment = ?");
    params.push(parsed.data.environment);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<SkillRow>(
    `
      SELECT id, name, version, description, input_schema, output_schema, required_tools, status, environment, created_by, created_at, updated_at
      FROM skills_catalog
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT 300
    `,
    params
  );

  res.json({
    items: rows.map(mapSkill)
  });
});

skillsRouter.get("/:id", authRequired, async (req, res) => {
  const skill = await get<SkillRow>(
    `
      SELECT id, name, version, description, input_schema, output_schema, required_tools, status, environment, created_by, created_at, updated_at
      FROM skills_catalog
      WHERE id = ?
    `,
    [String(req.params.id)]
  );

  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const tests = await all<SkillTestRow>(
    `
      SELECT id, skill_id, name, input_payload, expected_output, status, last_run_at, last_result, created_by, created_at, updated_at
      FROM skill_tests
      WHERE skill_id = ?
      ORDER BY created_at ASC
    `,
    [skill.id]
  );

  res.json({
    ...mapSkill(skill),
    testsCount: tests.length,
    tests: tests.map(mapSkillTest)
  });
});

skillsRouter.get("/:id/tests", authRequired, async (req, res) => {
  const skillId = String(req.params.id);
  const skill = await get<{ id: string }>("SELECT id FROM skills_catalog WHERE id = ?", [skillId]);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const tests = await all<SkillTestRow>(
    `
      SELECT id, skill_id, name, input_payload, expected_output, status, last_run_at, last_result, created_by, created_at, updated_at
      FROM skill_tests
      WHERE skill_id = ?
      ORDER BY created_at ASC
    `,
    [skillId]
  );

  res.json({
    skillId,
    items: tests.map(mapSkillTest)
  });
});

skillsRouter.get("/:id/promotions", authRequired, async (req, res) => {
  const parsed = skillPromotionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const skill = await get<{ id: string }>("SELECT id FROM skills_catalog WHERE id = ?", [String(req.params.id)]);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const rows = await all<SkillPromotionRow>(
    `
      SELECT
        p.id,
        p.skill_id,
        p.from_environment,
        p.to_environment,
        p.gate_status,
        p.gate_report,
        p.note,
        p.promoted_by,
        u.username AS promoted_by_username,
        p.created_at
      FROM skill_promotions p
      LEFT JOIN users u ON u.id = p.promoted_by
      WHERE p.skill_id = ?
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `,
    [skill.id, parsed.data.limit, parsed.data.offset]
  );

  res.json({
    skillId: skill.id,
    items: rows.map((row) => ({
      id: row.id,
      fromEnvironment: row.from_environment,
      toEnvironment: row.to_environment,
      gateStatus: row.gate_status,
      gateReport: parseJsonSafe<Record<string, unknown>>(row.gate_report, {}),
      note: row.note,
      promotedBy: row.promoted_by,
      promotedByUsername: row.promoted_by_username,
      createdAt: row.created_at
    })),
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset
    }
  });
});

skillsRouter.post("/:id/promote", authRequired, requirePermission("skills.create"), async (req, res) => {
  const parsed = promoteSkillSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const skill = await get<SkillRow>("SELECT * FROM skills_catalog WHERE id = ?", [String(req.params.id)]);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  if (skill.status !== "active") {
    res.status(409).json({ error: "Only active skills can be promoted", status: skill.status });
    return;
  }

  const fromEnvironment = skill.environment;
  const toEnvironment = parsed.data.targetEnvironment;

  if (!canPromote(fromEnvironment, toEnvironment)) {
    res.status(409).json({
      error: "Invalid promotion transition",
      fromEnvironment,
      toEnvironment
    });
    return;
  }

  const gates = await evaluatePromotionGates(skill);
  if (!gates.ok) {
    res.status(409).json({
      error: "Skill promotion gates failed",
      fromEnvironment,
      toEnvironment,
      gates
    });
    return;
  }

  if (fromEnvironment !== toEnvironment) {
    await run("UPDATE skills_catalog SET environment = ?, updated_at = ? WHERE id = ?", [toEnvironment, new Date().toISOString(), skill.id]);
  }

  await run(
    `
      INSERT INTO skill_promotions (
        id, skill_id, from_environment, to_environment, gate_status, gate_report, note, promoted_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      randomUUID(),
      skill.id,
      fromEnvironment,
      toEnvironment,
      gates.ok ? "passed" : "failed",
      JSON.stringify({
        testsChecked: gates.testsChecked,
        issues: gates.issues
      }),
      parsed.data.note ?? null,
      req.user!.id,
      new Date().toISOString()
    ]
  );

  await auditLog(req.user!.id, "skills.promote", {
    skillId: skill.id,
    fromEnvironment,
    toEnvironment,
    testsChecked: gates.testsChecked
  });

  const updated = await get<SkillRow>("SELECT * FROM skills_catalog WHERE id = ?", [skill.id]);
  res.json({
    skill: updated ? mapSkill(updated) : mapSkill(skill),
    fromEnvironment,
    toEnvironment,
    gates
  });
});

skillsRouter.post("/:id/tests/run", authRequired, requirePermission("skills.tests.run"), async (req, res) => {
  const parsedBody = runTestsBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid payload", details: parsedBody.error.flatten() });
    return;
  }

  const skillId = String(req.params.id);
  const skill = await get<SkillRow>("SELECT * FROM skills_catalog WHERE id = ?", [skillId]);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const tests = await all<SkillTestRow>(
    `
      SELECT id, skill_id, name, input_payload, expected_output, status, last_run_at, last_result, created_by, created_at, updated_at
      FROM skill_tests
      WHERE skill_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `,
    [skillId, parsedBody.data.maxTests]
  );

  const inputDef = parseJsonSafe<SchemaDefinition>(skill.input_schema, { type: "object", properties: {} });
  const outputDef = parseJsonSafe<SchemaDefinition>(skill.output_schema, { type: "object", properties: {} });
  const inputSchema = buildZodSchema(inputDef);
  const outputSchema = buildZodSchema(outputDef);

  const supportedTools = new Set(listSupportedTools().map((tool) => tool.key));
  const requiredTools = parseJsonSafe<string[]>(skill.required_tools, []);
  const missingTools = requiredTools.filter((toolKey) => !supportedTools.has(toolKey));

  const now = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  let passed = 0;

  for (const test of tests) {
    const inputPayload = parseJsonSafe<unknown>(test.input_payload, {});
    const expectedOutput = parseJsonSafe<unknown>(test.expected_output, {});

    const inputCheck = inputSchema.safeParse(inputPayload);
    const outputCheck = outputSchema.safeParse(expectedOutput);

    const status = inputCheck.success && outputCheck.success && missingTools.length === 0 ? "passed" : "failed";
    if (status === "passed") {
      passed += 1;
    }

    const resultPayload = {
      inputValid: inputCheck.success,
      outputValid: outputCheck.success,
      missingTools
    };

    await run(
      `
        UPDATE skill_tests
        SET status = ?, last_run_at = ?, last_result = ?, updated_at = ?
        WHERE id = ?
      `,
      [status, now, JSON.stringify(resultPayload), now, test.id]
    );

    results.push({
      testId: test.id,
      name: test.name,
      status,
      result: resultPayload
    });
  }

  await auditLog(req.user!.id, "skills.tests.run", {
    skillId,
    total: tests.length,
    passed,
    failed: tests.length - passed
  });

  res.json({
    skillId,
    total: tests.length,
    passed,
    failed: tests.length - passed,
    status: tests.length === passed ? "passed" : "failed",
    note: "MVP contract validation: test runner validates skill input/output schemas and tool requirements.",
    results
  });
});
