import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Project } from "../../reycad/src/engine/scenegraph/types";
import type { PlaySessionManifest } from "../../reycad/src/editor/runtime/playSessionExport";

const repoRoot = path.resolve(__dirname, "..", "..");
const packageDir = path.join(repoRoot, "artifacts", "reycad-play");
const manifestPath = path.join(packageDir, "play-session.manifest.json");
const projectPath = path.join(packageDir, "scene.project.json");

test("play package manifest and scene files are generated and internally consistent", () => {
  assert.equal(fs.existsSync(manifestPath), true, `missing file: ${manifestPath}`);
  assert.equal(fs.existsSync(projectPath), true, `missing file: ${projectPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PlaySessionManifest;
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8")) as Project;

  assert.equal(manifest.kind, "reycad_play_session_manifest_v1");
  assert.equal(manifest.schema, 1);
  assert.ok(typeof manifest.generatedAt === "string" && manifest.generatedAt.length > 0);
  assert.ok(typeof manifest.preset === "string" && manifest.preset.length > 0);
  assert.ok(typeof manifest.source === "string" && manifest.source.length > 0);
  assert.equal(manifest.files.project, "scene.project.json");

  assert.equal(manifest.summary.nodeCount, Object.keys(project.nodes).length);
  assert.equal(manifest.summary.materialCount, Object.keys(project.materials).length);
  assert.equal(manifest.summary.textureCount, Object.keys(project.textures).length);
  assert.ok(Array.isArray(manifest.materials));
  assert.ok(Array.isArray(manifest.textures));
  assert.ok(manifest.summary.textureBytesApprox >= 0);
  for (const texture of manifest.textures) {
    assert.ok(texture.bytesApprox >= 0);
  }
});
