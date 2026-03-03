import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4745 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-cards-editor-int-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

async function patchJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "PATCH",
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

async function putJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "PUT",
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

async function registerUser(username: string, password: string): Promise<{ token: string; userId: string }> {
  const register = await postJson(
    "/api/auth/register",
    { username, password },
    {
      "x-client-platform": "web"
    }
  );

  assert.equal(register.status, 201);
  const body = register.body as { token?: string; user?: { id: string } };
  assert.ok(body.token);
  assert.ok(body.user?.id);

  return {
    token: body.token as string,
    userId: body.user!.id
  };
}

test("cards creator/editor flow supports drafts, versioning and state transitions", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret_for_cards_editor",
    TRAINING_QUEUE_BACKEND: "local"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const owner = await registerUser(`editor_${Date.now()}`, "EditorPass123!");
    const authHeaders = {
      Authorization: `Bearer ${owner.token}`,
      "x-client-platform": "web"
    };

    const draftName = `Aegis Vanguard ${Date.now()}`;
    const draftPayload = {
      name: draftName,
      rarity: "epic",
      cardClass: "guardian",
      abilities: ["shield", "regen"],
      summonCost: 6,
      energy: 7,
      baseStats: {
        attack: 11,
        defense: 15,
        speed: 8
      }
    };

    const createDraft = await postJson("/api/cards/drafts", draftPayload, authHeaders);
    assert.equal(createDraft.status, 201);
    const createdDraftBody = createDraft.body as { id?: string; version?: number };
    assert.ok(createdDraftBody.id);
    assert.equal(createdDraftBody.version, 1);
    const draftId = createdDraftBody.id as string;

    const duplicateDraft = await postJson(
      "/api/cards/drafts",
      {
        ...draftPayload,
        name: `  ${draftName.toLowerCase()} `,
        cardClass: "Guardian",
        abilities: ["REGEN", "shield"]
      },
      authHeaders
    );
    assert.equal(duplicateDraft.status, 409);

    const stalePatch = await patchJson(
      `/api/cards/drafts/${draftId}`,
      {
        expectedVersion: 2,
        changes: {
          summonCost: 5
        }
      },
      authHeaders
    );
    assert.equal(stalePatch.status, 409);

    const patchDraft = await patchJson(
      `/api/cards/drafts/${draftId}`,
      {
        expectedVersion: 1,
        changes: {
          baseStats: {
            attack: 12,
            defense: 15,
            speed: 8
          }
        }
      },
      authHeaders
    );
    assert.equal(patchDraft.status, 200);
    const patchBody = patchDraft.body as { version?: number };
    assert.equal(patchBody.version, 2);

    const validateDraft = await postJson(`/api/cards/drafts/${draftId}/validate`, {}, authHeaders);
    assert.equal(validateDraft.status, 200);
    const validateBody = validateDraft.body as { ok?: boolean };
    assert.equal(validateBody.ok, true);

    const publishDraft = await postJson(`/api/cards/drafts/${draftId}/publish`, {}, authHeaders);
    assert.equal(publishDraft.status, 201);
    const publishBody = publishDraft.body as { cardId?: string; status?: string };
    assert.ok(publishBody.cardId);
    assert.equal(publishBody.status, "published");
    const cardId = publishBody.cardId as string;

    const publishAgain = await postJson(`/api/cards/drafts/${draftId}/publish`, {}, authHeaders);
    assert.equal(publishAgain.status, 409);

    const getCard = await getJson(`/api/cards/${cardId}`);
    assert.equal(getCard.status, 200);
    const cardBody = getCard.body as { status?: string; version?: number };
    assert.equal(cardBody.status, "published");
    assert.equal(cardBody.version, 1);

    const versionsV1 = await getJson(`/api/cards/${cardId}/versions`, authHeaders);
    assert.equal(versionsV1.status, 200);
    const versionsV1Body = versionsV1.body as { currentVersion?: number; items?: Array<{ version: number }> };
    assert.equal(versionsV1Body.currentVersion, 1);
    assert.ok(Array.isArray(versionsV1Body.items));
    assert.ok((versionsV1Body.items?.length ?? 0) >= 1);

    const archiveCard = await postJson(`/api/cards/${cardId}/archive`, {}, authHeaders);
    assert.equal(archiveCard.status, 200);

    const listArchived = await postJson(
      "/api/marketplace/listings",
      {
        cardId,
        priceCredits: 4
      },
      authHeaders
    );
    assert.equal(listArchived.status, 409);

    const updateArchivedStats = await putJson(
      `/api/cards/${cardId}/stats`,
      {
        attack: 10,
        defense: 10,
        speed: 10
      },
      authHeaders
    );
    assert.equal(updateArchivedStats.status, 409);

    const unarchiveCard = await postJson(`/api/cards/${cardId}/unarchive`, {}, authHeaders);
    assert.equal(unarchiveCard.status, 200);

    const updateStats = await putJson(
      `/api/cards/${cardId}/stats`,
      {
        attack: 10,
        defense: 10,
        speed: 10
      },
      authHeaders
    );
    assert.equal(updateStats.status, 200);
    const updateStatsBody = updateStats.body as { version?: number };
    assert.equal(updateStatsBody.version, 2);

    const versionsV2 = await getJson(`/api/cards/${cardId}/versions`, authHeaders);
    assert.equal(versionsV2.status, 200);
    const versionsV2Body = versionsV2.body as { currentVersion?: number; items?: Array<{ version: number }> };
    assert.equal(versionsV2Body.currentVersion, 2);
    assert.ok((versionsV2Body.items?.some((item) => item.version === 2) ?? false) === true);

    const revert = await postJson(
      `/api/cards/${cardId}/revert`,
      {
        version: 1,
        note: "rollback integration test"
      },
      authHeaders
    );
    assert.equal(revert.status, 200);
    const revertBody = revert.body as { newVersion?: number; revertedToVersion?: number };
    assert.equal(revertBody.revertedToVersion, 1);
    assert.equal(revertBody.newVersion, 3);

    const cloneDraft = await postJson(`/api/cards/${cardId}/clone-draft`, {}, authHeaders);
    assert.equal(cloneDraft.status, 201);
    const cloneDraftBody = cloneDraft.body as { id?: string };
    assert.ok(cloneDraftBody.id);

    const publishClone = await postJson(
      `/api/cards/drafts/${cloneDraftBody.id}/publish`,
      {
        consumeCreativePoints: false
      },
      authHeaders
    );
    assert.equal(publishClone.status, 409);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
