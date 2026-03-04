import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import engineApi, { type BenchmarkScenePreset } from "../reycad/src/engine/api/engineApi";
import { createProject } from "../reycad/src/engine/scenegraph/factory";
import type { Project } from "../reycad/src/engine/scenegraph/types";
import { useEditorStore } from "../reycad/src/editor/state/editorStore";
import { migrateProject } from "../reycad/src/editor/persistence/migrations";
import { buildPlaySessionPackage } from "../reycad/src/editor/runtime/playSessionExport";

const DEFAULT_OUTPUT_DIR = "artifacts/reycad-play";
const DEFAULT_PRESET: BenchmarkScenePreset = "outdoor";

function parsePreset(input: string | undefined): BenchmarkScenePreset {
  const value = (input ?? "").trim().toLowerCase();
  if (value === "indoor" || value === "outdoor" || value === "large-world") {
    return value;
  }
  return DEFAULT_PRESET;
}

function loadProjectFromFile(filePath: string): Project {
  if (!existsSync(filePath)) {
    throw new Error(`REYCAD_PLAY_PROJECT not found: ${filePath}`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Project;
  return migrateProject(parsed);
}

function generateProjectFromPreset(preset: BenchmarkScenePreset): Project {
  useEditorStore.getState().loadProject(createProject());
  engineApi.generateBenchmarkScene(preset);
  return engineApi.getProjectSnapshot();
}

function cleanOutput(outputDir: string): void {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
}

function writeUtf8(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
}

function main(): void {
  const outputDir = resolve(process.cwd(), (process.env.REYCAD_PLAY_OUT_DIR || DEFAULT_OUTPUT_DIR).trim());
  const preset = parsePreset(process.env.REYCAD_PLAY_PRESET);
  const projectPathRaw = (process.env.REYCAD_PLAY_PROJECT || "").trim();
  const projectPath = projectPathRaw.length > 0 ? resolve(process.cwd(), projectPathRaw) : null;

  const source = projectPath ? `project-file:${projectPathRaw}` : `benchmark:${preset}`;
  const project = projectPath ? loadProjectFromFile(projectPath) : generateProjectFromPreset(preset);
  const bundle = buildPlaySessionPackage(project, {
    preset,
    source,
    projectFileName: "scene.project.json"
  });

  cleanOutput(outputDir);
  writeUtf8(resolve(outputDir, "play-session.manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  writeUtf8(resolve(outputDir, "scene.project.json"), `${JSON.stringify(bundle.project, null, 2)}\n`);
  writeUtf8(
    resolve(outputDir, "README.txt"),
    [
      "ReyCAD Play Package",
      "",
      `generatedAt=${bundle.manifest.generatedAt}`,
      `preset=${bundle.manifest.preset}`,
      `source=${bundle.manifest.source}`,
      `nodeCount=${bundle.manifest.summary.nodeCount}`,
      `materials=${bundle.manifest.summary.materialCount}`,
      `textures=${bundle.manifest.summary.textureCount}`,
      "",
      "Files:",
      "- play-session.manifest.json",
      "- scene.project.json"
    ].join("\n")
  );

  console.log(
    [
      "[reycad:build:play]",
      `output=${outputDir}`,
      `preset=${bundle.manifest.preset}`,
      `source=${bundle.manifest.source}`,
      `nodes=${bundle.manifest.summary.nodeCount}`,
      `materials=${bundle.manifest.summary.materialCount}`,
      `textures=${bundle.manifest.summary.textureCount}`
    ].join(" ")
  );
}

main();
