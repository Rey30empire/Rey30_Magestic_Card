import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4860 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-asset-vault-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok) {
          return;
        }
      }
    } catch {
      // retry
    }
    await sleep(250);
  }

  throw new Error("Timed out waiting for backend health");
}

async function postJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

async function getJson(endpoint: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

async function registerUser(username: string): Promise<string> {
  const register = await postJson(
    "/api/auth/register",
    { username, password: "AssetVaultPass123!" },
    {
      "x-client-platform": "web"
    }
  );
  assert.equal(register.status, 201);
  const token = (register.body as { token?: string }).token;
  assert.ok(token);
  return token!;
}

test("asset vault mvp routes: create + dedupe + link + ownership", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    REYMESHY_SIDECAR_ENABLED: "false",
    VRAM_SENTINEL_ENABLED: "false"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const tokenA = await registerUser(`vault_owner_${Date.now()}`);
    const tokenB = await registerUser(`vault_other_${Date.now()}`);

    const projectCreate = await postJson(
      "/api/projects",
      {
        name: "Project Vault",
        description: "Asset vault integration project"
      },
      {
        Authorization: `Bearer ${tokenA}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(projectCreate.status, 201);
    const projectId = (projectCreate.body as { id?: string }).id;
    assert.ok(projectId);

    const createAsset = await postJson(
      "/api/vault/assets",
      {
        type: "model",
        name: "Palm Island Starter",
        description: "Starter palm tree base",
        tags: ["Island", "Tropical", "Starter"],
        source: "import",
        dedupeHash: "PALM_HASH_0001",
        stats: {
          polycount: 4200,
          texturesCount: 3
        }
      },
      {
        Authorization: `Bearer ${tokenA}`
      }
    );
    assert.equal(createAsset.status, 201);
    const createAssetBody = createAsset.body as { id?: string; created?: boolean; deduped?: boolean };
    assert.ok(createAssetBody.id);
    assert.equal(createAssetBody.created, true);
    assert.equal(createAssetBody.deduped, false);

    const dedupeAttempt = await postJson(
      "/api/vault/assets",
      {
        type: "model",
        name: "Palm Island Starter Duplicate",
        source: "import",
        dedupeHash: "PALM_HASH_0001"
      },
      {
        Authorization: `Bearer ${tokenA}`
      }
    );
    assert.equal(dedupeAttempt.status, 200);
    const dedupeBody = dedupeAttempt.body as { id?: string; created?: boolean; deduped?: boolean };
    assert.equal(dedupeBody.id, createAssetBody.id);
    assert.equal(dedupeBody.created, false);
    assert.equal(dedupeBody.deduped, true);

    const uploadPayload = Buffer.from("fake_glb_binary_payload_v1", "utf8");
    const uploadResponse = await fetch(
      `${baseUrl}/api/vault/upload?assetId=${createAssetBody.id}&role=model`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/octet-stream",
          "x-file-name": "palm_tree.glb",
          "x-file-mime": "model/gltf-binary"
        },
        body: uploadPayload
      }
    );
    assert.equal(uploadResponse.status, 201);
    const uploadBody = (await uploadResponse.json()) as {
      uploaded?: boolean;
      deduped?: boolean;
      file?: { id?: string };
    };
    assert.equal(uploadBody.uploaded, true);
    assert.equal(uploadBody.deduped, false);
    assert.ok(uploadBody.file?.id);

    const uploadDedupeResponse = await fetch(
      `${baseUrl}/api/vault/upload?assetId=${createAssetBody.id}&role=model`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/octet-stream",
          "x-file-name": "palm_tree.glb",
          "x-file-mime": "model/gltf-binary"
        },
        body: uploadPayload
      }
    );
    assert.equal(uploadDedupeResponse.status, 200);
    const uploadDedupeBody = (await uploadDedupeResponse.json()) as {
      uploaded?: boolean;
      deduped?: boolean;
      file?: { id?: string };
    };
    assert.equal(uploadDedupeBody.uploaded, false);
    assert.equal(uploadDedupeBody.deduped, true);
    assert.equal(uploadDedupeBody.file?.id, uploadBody.file?.id);

    const ownerList = await getJson("/api/vault/assets?tag=island", {
      Authorization: `Bearer ${tokenA}`
    });
    assert.equal(ownerList.status, 200);
    const ownerListItems = (ownerList.body as { items?: Array<{ id?: string; filesCount?: number }> }).items ?? [];
    assert.ok(ownerListItems.some((item) => item.id === createAssetBody.id));
    assert.equal(ownerListItems.find((item) => item.id === createAssetBody.id)?.filesCount, 1);

    const assetDetail = await getJson(`/api/vault/assets/${createAssetBody.id}`, {
      Authorization: `Bearer ${tokenA}`
    });
    assert.equal(assetDetail.status, 200);
    const assetDetailBody = assetDetail.body as { asset?: { files?: unknown[] } };
    assert.equal((assetDetailBody.asset?.files ?? []).length, 1);

    const downloadResponse = await fetch(
      `${baseUrl}/api/vault/assets/${createAssetBody.id}/files/${uploadBody.file?.id}/download`,
      {
        headers: {
          Authorization: `Bearer ${tokenA}`
        }
      }
    );
    assert.equal(downloadResponse.status, 200);
    const downloadBytes = Buffer.from(await downloadResponse.arrayBuffer());
    assert.deepEqual(downloadBytes, uploadPayload);

    const otherList = await getJson("/api/vault/assets", {
      Authorization: `Bearer ${tokenB}`
    });
    assert.equal(otherList.status, 200);
    const otherItems = (otherList.body as { items?: unknown[] }).items ?? [];
    assert.equal(otherItems.length, 0);

    const linkCreate = await postJson(
      `/api/vault/assets/${createAssetBody.id}/link`,
      {
        projectId,
        overrides: {
          scale: 1.5
        },
        embedMode: "reference"
      },
      {
        Authorization: `Bearer ${tokenA}`
      }
    );
    assert.equal(linkCreate.status, 201);
    const linkCreateBody = linkCreate.body as { id?: string; created?: boolean };
    assert.ok(linkCreateBody.id);
    assert.equal(linkCreateBody.created, true);

    const linkUpdate = await postJson(
      `/api/vault/assets/${createAssetBody.id}/link`,
      {
        projectId,
        overrides: {
          scale: 2
        },
        embedMode: "embed"
      },
      {
        Authorization: `Bearer ${tokenA}`
      }
    );
    assert.equal(linkUpdate.status, 200);
    const linkUpdateBody = linkUpdate.body as { id?: string; created?: boolean; embedMode?: string };
    assert.equal(linkUpdateBody.id, linkCreateBody.id);
    assert.equal(linkUpdateBody.created, false);
    assert.equal(linkUpdateBody.embedMode, "embed");

    const linkedAssets = await getJson(`/api/vault/projects/${projectId}/assets?includeFiles=1`, {
      Authorization: `Bearer ${tokenA}`
    });
    assert.equal(linkedAssets.status, 200);
    const linkedItems = (linkedAssets.body as { items?: Array<{ link?: { embedMode?: string }; asset?: { files?: unknown[] } }> }).items ?? [];
    assert.equal(linkedItems.length, 1);
    assert.equal(linkedItems[0]?.link?.embedMode, "embed");
    assert.equal((linkedItems[0]?.asset?.files ?? []).length, 1);

    const foreignUploadAttempt = await fetch(
      `${baseUrl}/api/vault/upload?assetId=${createAssetBody.id}&role=model`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/octet-stream",
          "x-file-name": "palm_tree.glb"
        },
        body: uploadPayload
      }
    );
    assert.equal(foreignUploadAttempt.status, 404);

    const foreignLinkAttempt = await postJson(
      `/api/vault/assets/${createAssetBody.id}/link`,
      {
        projectId
      },
      {
        Authorization: `Bearer ${tokenB}`
      }
    );
    assert.equal(foreignLinkAttempt.status, 404);

    const foreignProjectList = await getJson(`/api/vault/projects/${projectId}/assets`, {
      Authorization: `Bearer ${tokenB}`
    });
    assert.equal(foreignProjectList.status, 404);
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
