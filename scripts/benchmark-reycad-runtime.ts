import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import engineApi, { type BenchmarkScenePreset } from "../reycad/src/engine/api/engineApi";
import { useEditorStore } from "../reycad/src/editor/state/editorStore";
import { createProject } from "../reycad/src/engine/scenegraph/factory";
import { evaluateProject } from "../reycad/src/engine/scenegraph/evaluator";
import { computeSceneRuntimeProfile, resolveSceneBudgetTargets } from "../reycad/src/engine/rendering/renderTuning";

type SceneBaseline = {
  nodeCountMin: number;
  generateMsP95: number;
  evaluateMsP95: number;
};

type BaselineSpec = {
  schema: number;
  thresholdMultiplier: number;
  iterations: number;
  warmupIterations: number;
  scenes: Record<BenchmarkScenePreset, SceneBaseline>;
};

type BenchmarkReport = {
  generatedAt: string;
  baselinePath: string;
  thresholdMultiplier: number;
  samples: number;
  warmupSamples: number;
  summaries: SceneRunSummary[];
  failures: string[];
};

type SceneRunSummary = {
  preset: BenchmarkScenePreset;
  samples: number;
  nodeCountMin: number;
  nodeCountMax: number;
  drawTargetMin: number;
  trianglesTargetMin: number;
  generateMsP95: number;
  generateMsAvg: number;
  evaluateMsP95: number;
  evaluateMsAvg: number;
};

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0.25, value);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

function roundMs(value: number): number {
  return Number(value.toFixed(2));
}

function loadBaseline(filePath: string): BaselineSpec {
  if (!existsSync(filePath)) {
    throw new Error(`missing benchmark baseline file: ${filePath}`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as BaselineSpec;
  if (!parsed || typeof parsed !== "object" || parsed.schema !== 1) {
    throw new Error(`invalid baseline schema in ${filePath}`);
  }
  return parsed;
}

function measurePreset(
  preset: BenchmarkScenePreset,
  warmupIterations: number,
  measuredIterations: number
): SceneRunSummary {
  const generateSamples: number[] = [];
  const evaluateSamples: number[] = [];
  let nodeCountMin = Number.POSITIVE_INFINITY;
  let nodeCountMax = 0;
  let drawTargetMin = Number.POSITIVE_INFINITY;
  let trianglesTargetMin = Number.POSITIVE_INFINITY;

  for (let index = 0; index < warmupIterations + measuredIterations; index += 1) {
    useEditorStore.getState().loadProject(createProject());

    const generateStart = performance.now();
    const summary = engineApi.generateBenchmarkScene(preset);
    const generateMs = performance.now() - generateStart;

    const snapshot = engineApi.getProjectSnapshot();
    const evaluateStart = performance.now();
    const evaluated = evaluateProject(snapshot);
    const evaluateMs = performance.now() - evaluateStart;

    const profile = computeSceneRuntimeProfile(evaluated.items, "high");
    const targets = resolveSceneBudgetTargets(profile.sceneProfile, "high", profile.sceneNodeCount);

    if (index >= warmupIterations) {
      generateSamples.push(generateMs);
      evaluateSamples.push(evaluateMs);
      nodeCountMin = Math.min(nodeCountMin, summary.nodeCount);
      nodeCountMax = Math.max(nodeCountMax, summary.nodeCount);
      drawTargetMin = Math.min(drawTargetMin, targets.drawCalls);
      trianglesTargetMin = Math.min(trianglesTargetMin, targets.triangles);
    }
  }

  return {
    preset,
    samples: measuredIterations,
    nodeCountMin: nodeCountMin === Number.POSITIVE_INFINITY ? 0 : nodeCountMin,
    nodeCountMax,
    drawTargetMin: drawTargetMin === Number.POSITIVE_INFINITY ? 0 : drawTargetMin,
    trianglesTargetMin: trianglesTargetMin === Number.POSITIVE_INFINITY ? 0 : trianglesTargetMin,
    generateMsP95: roundMs(percentile(generateSamples, 0.95)),
    generateMsAvg: roundMs(average(generateSamples)),
    evaluateMsP95: roundMs(percentile(evaluateSamples, 0.95)),
    evaluateMsAvg: roundMs(average(evaluateSamples))
  };
}

function printSummary(summary: SceneRunSummary): void {
  const line = [
    `preset=${summary.preset}`,
    `samples=${summary.samples}`,
    `nodes[min-max]=${summary.nodeCountMin}-${summary.nodeCountMax}`,
    `gen[p95/avg]=${summary.generateMsP95}/${summary.generateMsAvg}ms`,
    `eval[p95/avg]=${summary.evaluateMsP95}/${summary.evaluateMsAvg}ms`,
    `targets[draw/tri]=${summary.drawTargetMin}/${summary.trianglesTargetMin}`
  ].join(" ");
  console.log(line);
}

function writeReport(filePath: string, report: BenchmarkReport): void {
  const normalizedPath = resolve(process.cwd(), filePath);
  const separator = Math.max(normalizedPath.lastIndexOf("/"), normalizedPath.lastIndexOf("\\"));
  if (separator > 0) {
    mkdirSync(normalizedPath.slice(0, separator), { recursive: true });
  }
  writeFileSync(normalizedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[benchmark-gate] report=${normalizedPath}`);
}

function main(): void {
  const baselinePath = resolve(process.cwd(), "benchmarks/reycad-runtime-baseline.json");
  const baseline = loadBaseline(baselinePath);
  const warmupIterations = parsePositiveInt(process.env.REYCAD_BENCH_WARMUP, baseline.warmupIterations);
  const measuredIterations = parsePositiveInt(process.env.REYCAD_BENCH_ITERATIONS, baseline.iterations);
  const thresholdMultiplier = parsePositiveNumber(process.env.REYCAD_BENCH_THRESHOLD_MULTIPLIER, baseline.thresholdMultiplier);
  const reportPath = process.env.REYCAD_BENCH_OUTPUT;

  const presets: BenchmarkScenePreset[] = ["indoor", "outdoor", "large-world"];
  const summaries: SceneRunSummary[] = [];
  for (const preset of presets) {
    const summary = measurePreset(preset, warmupIterations, measuredIterations);
    summaries.push(summary);
    printSummary(summary);
  }

  const failures: string[] = [];
  for (const summary of summaries) {
    const limit = baseline.scenes[summary.preset];
    const maxGenerateMs = roundMs(limit.generateMsP95 * thresholdMultiplier);
    const maxEvaluateMs = roundMs(limit.evaluateMsP95 * thresholdMultiplier);
    if (summary.nodeCountMin < limit.nodeCountMin) {
      failures.push(
        `${summary.preset}: nodeCount min ${summary.nodeCountMin} < required ${limit.nodeCountMin}`
      );
    }
    if (summary.generateMsP95 > maxGenerateMs) {
      failures.push(
        `${summary.preset}: generate p95 ${summary.generateMsP95}ms > max ${maxGenerateMs}ms`
      );
    }
    if (summary.evaluateMsP95 > maxEvaluateMs) {
      failures.push(
        `${summary.preset}: evaluate p95 ${summary.evaluateMsP95}ms > max ${maxEvaluateMs}ms`
      );
    }
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    baselinePath,
    thresholdMultiplier,
    samples: measuredIterations,
    warmupSamples: warmupIterations,
    summaries,
    failures
  };

  if (typeof reportPath === "string" && reportPath.trim().length > 0) {
    writeReport(reportPath.trim(), report);
  }

  if (failures.length > 0) {
    console.error(`\n[benchmark-gate] failed (${failures.length})`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `\n[benchmark-gate] passed baseline=${baselinePath} samples=${measuredIterations} warmup=${warmupIterations} multiplier=${thresholdMultiplier}`
  );
}

main();
