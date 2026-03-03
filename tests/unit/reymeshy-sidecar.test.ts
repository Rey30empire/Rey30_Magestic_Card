import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReyMeshyCleanup, type ReyMeshyMeshData } from "../../src/services/reymeshy-sidecar";

function makeTempScript(source: string): { dir: string; scriptPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reymeshy-sidecar-test-"));
  const scriptPath = path.join(dir, "mock-sidecar.js");
  fs.writeFileSync(scriptPath, source, "utf8");
  return { dir, scriptPath };
}

const sampleMesh: ReyMeshyMeshData = {
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  uvs: []
};

test("runReyMeshyCleanup parses successful sidecar output", async () => {
  const mock = makeTempScript(`
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const mesh = JSON.parse(raw);
process.stdout.write(JSON.stringify({
  remeshed: mesh,
  uv_unwrapped: mesh,
  lod_optimized: mesh
}));
`);

  try {
    const result = await runReyMeshyCleanup(sampleMesh, {
      command: process.execPath,
      args: [mock.scriptPath],
      timeoutMs: 1500
    });
    assert.deepEqual(result.remeshed.indices, [0, 1, 2]);
    assert.deepEqual(result.uv_unwrapped.vertices, sampleMesh.vertices);
    assert.deepEqual(result.lod_optimized.uvs, []);
  } finally {
    fs.rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("runReyMeshyCleanup surfaces non-zero sidecar exits", async () => {
  const mock = makeTempScript(`
process.stderr.write("forced failure");
process.exit(7);
`);

  try {
    await assert.rejects(
      () =>
        runReyMeshyCleanup(sampleMesh, {
          command: process.execPath,
          args: [mock.scriptPath],
          timeoutMs: 1500
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes("code 7"));
        assert.ok(message.includes("forced failure"));
        return true;
      }
    );
  } finally {
    fs.rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("runReyMeshyCleanup enforces timeout", async () => {
  const mock = makeTempScript(`
setTimeout(() => {
  process.stdout.write("{}");
}, 5000);
`);

  try {
    await assert.rejects(
      () =>
        runReyMeshyCleanup(sampleMesh, {
          command: process.execPath,
          args: [mock.scriptPath],
          timeoutMs: 120
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.toLowerCase().includes("timeout"));
        return true;
      }
    );
  } finally {
    fs.rmSync(mock.dir, { recursive: true, force: true });
  }
});
