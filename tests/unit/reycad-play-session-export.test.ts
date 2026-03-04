import assert from "node:assert/strict";
import test from "node:test";
import { createProject, createPrimitiveNode } from "../../reycad/src/engine/scenegraph/factory";
import type { GroupNode } from "../../reycad/src/engine/scenegraph/types";
import { buildPlaySessionPackage } from "../../reycad/src/editor/runtime/playSessionExport";

test("play session export builds manifest with summary and metadata", () => {
  const project = createProject();
  const root = project.nodes[project.rootId];
  assert.equal(root.type, "group");

  const box = createPrimitiveNode("box");
  box.id = "box_test";
  box.parentId = project.rootId;
  box.materialId = "pbr_metal";
  (root as GroupNode).children.push(box.id);
  project.nodes[box.id] = box;

  project.textures["tx_base"] = {
    id: "tx_base",
    name: "base",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
    createdAt: new Date().toISOString(),
    width: 1,
    height: 1
  };
  const pbrMetal = project.materials["pbr_metal"];
  if (pbrMetal && pbrMetal.kind === "pbr" && pbrMetal.pbr) {
    pbrMetal.pbr.baseColorMapId = "tx_base";
  }

  const bundle = buildPlaySessionPackage(project, {
    preset: "outdoor",
    source: "unit-test",
    generatedAt: "2026-03-03T00:00:00.000Z"
  });

  assert.equal(bundle.manifest.kind, "reycad_play_session_manifest_v1");
  assert.equal(bundle.manifest.schema, 1);
  assert.equal(bundle.manifest.generatedAt, "2026-03-03T00:00:00.000Z");
  assert.equal(bundle.manifest.summary.nodeCount, Object.keys(project.nodes).length);
  assert.equal(bundle.manifest.summary.materialCount, Object.keys(project.materials).length);
  assert.equal(bundle.manifest.summary.textureCount, 1);
  assert.equal(bundle.manifest.summary.primitiveCount, 1);
  assert.ok(bundle.manifest.summary.textureBytesApprox > 0);

  const pbrEntry = bundle.manifest.materials.find((item) => item.id === "pbr_metal");
  assert.ok(pbrEntry);
  assert.deepEqual(pbrEntry?.textureRefs, ["tx_base"]);
});
