import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import {
  buildCardFingerprint,
  buildCardRecord,
  createCardSchema,
  CreateCardInput,
  creativePointsCost,
  validateCardBalance
} from "../services/card-validator";
import { parseJsonSafe } from "../utils/json";

type UserPointsRow = {
  creative_points: number;
};

type CardRow = {
  id: string;
  owner_user_id: string;
  name: string;
  card_hash: string;
  r33_signature: string | null;
  rarity: "common" | "rare" | "epic" | "legendary";
  class: string;
  abilities: string;
  summon_cost: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  model_3d_url: string | null;
  metadata: string;
  status: "published" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
};

type CardDraftRow = {
  id: string;
  owner_user_id: string;
  source_card_id: string | null;
  payload: string;
  fingerprint: string;
  status: "draft" | "validated" | "published" | "archived";
  validation_errors: string;
  version: number;
  published_card_id: string | null;
  created_at: string;
  updated_at: string;
};

type CardVersionRow = {
  id: string;
  card_id: string;
  version: number;
  snapshot: string;
  change_note: string | null;
  created_by: string | null;
  created_at: string;
};

type IdRow = {
  id: string;
};

type CardSnapshot = {
  id: string;
  ownerUserId: string;
  name: string;
  hash: string;
  r33Signature: string | null;
  rarity: "common" | "rare" | "epic" | "legendary";
  cardClass: string;
  abilities: string[];
  summonCost: number;
  energy: number;
  baseStats: {
    attack: number;
    defense: number;
    speed: number;
  };
  model3dUrl: string | null;
  metadata: Record<string, unknown>;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const cardDraftPayloadSchema = createCardSchema.omit({ isOriginal: true });
const cardDraftPatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  changes: cardDraftPayloadSchema.partial().refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required in changes"
  })
});
const cardPublishOptionsSchema = z.object({
  consumeCreativePoints: z.boolean().default(true)
});
const updateStatsSchema = z.object({
  attack: z.number().int().min(0).max(30),
  defense: z.number().int().min(0).max(30),
  speed: z.number().int().min(0).max(30)
});
const cardRevertSchema = z.object({
  version: z.number().int().min(1),
  note: z.string().min(3).max(240).optional()
});

function isSqliteUniqueConstraint(error: unknown, target: string | string[]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("UNIQUE constraint failed")) {
    return false;
  }

  const targets = Array.isArray(target) ? target : [target];
  return targets.every((item) => message.includes(item));
}

async function safeRollback(): Promise<void> {
  try {
    await run("ROLLBACK");
  } catch {
    // Ignore rollback errors when transaction was not started.
  }
}

async function hasDuplicateCardHash(cardHash: string, excludeCardId?: string): Promise<boolean> {
  const where = excludeCardId ? "card_hash = ? AND id != ?" : "card_hash = ?";
  const params = excludeCardId ? [cardHash, excludeCardId] : [cardHash];
  const existing = await get<IdRow>(`SELECT id FROM cards WHERE ${where} LIMIT 1`, params);
  return Boolean(existing?.id);
}

async function hasDuplicateActiveDraftFingerprint(userId: string, fingerprint: string, excludeDraftId?: string): Promise<boolean> {
  const where = excludeDraftId
    ? "owner_user_id = ? AND fingerprint = ? AND status IN ('draft', 'validated') AND id != ?"
    : "owner_user_id = ? AND fingerprint = ? AND status IN ('draft', 'validated')";
  const params = excludeDraftId ? [userId, fingerprint, excludeDraftId] : [userId, fingerprint];
  const existing = await get<IdRow>(`SELECT id FROM card_drafts WHERE ${where} LIMIT 1`, params);
  return Boolean(existing?.id);
}

function mapCard(card: CardRow): CardSnapshot {
  return {
    id: card.id,
    ownerUserId: card.owner_user_id,
    name: card.name,
    hash: card.card_hash,
    r33Signature: card.r33_signature,
    rarity: card.rarity,
    cardClass: card.class,
    abilities: parseJsonSafe<string[]>(card.abilities, []),
    summonCost: card.summon_cost,
    energy: card.energy,
    baseStats: {
      attack: card.attack,
      defense: card.defense,
      speed: card.speed
    },
    model3dUrl: card.model_3d_url,
    metadata: parseJsonSafe<Record<string, unknown>>(card.metadata, {}),
    status: card.status,
    version: card.version,
    createdAt: card.created_at,
    updatedAt: card.updated_at
  };
}

function mapDraft(row: CardDraftRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    sourceCardId: row.source_card_id,
    payload: parseJsonSafe<Record<string, unknown>>(row.payload, {}),
    fingerprint: row.fingerprint,
    status: row.status,
    validationErrors: parseJsonSafe<string[]>(row.validation_errors, []),
    version: row.version,
    publishedCardId: row.published_card_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapVersion(row: CardVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    cardId: row.card_id,
    version: row.version,
    snapshot: parseJsonSafe<Record<string, unknown>>(row.snapshot, {}),
    changeNote: row.change_note,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function toCreateCardInput(payload: z.infer<typeof cardDraftPayloadSchema>): CreateCardInput {
  return {
    ...payload,
    isOriginal: true
  };
}

function evaluateDraft(payload: z.infer<typeof cardDraftPayloadSchema>): {
  fingerprint: string;
  validationErrors: string[];
  status: "draft" | "validated";
} {
  const cardInput = toCreateCardInput(payload);
  const validation = validateCardBalance(cardInput);
  const fingerprint = buildCardFingerprint(cardInput);

  return {
    fingerprint,
    validationErrors: validation.errors,
    status: validation.ok ? "validated" : "draft"
  };
}

function buildSnapshotFromCardRow(card: CardRow): CardSnapshot {
  return mapCard(card);
}

function buildDraftPayloadFromCard(card: CardRow): z.infer<typeof cardDraftPayloadSchema> {
  return {
    name: card.name,
    rarity: card.rarity,
    cardClass: card.class,
    abilities: parseJsonSafe<string[]>(card.abilities, []),
    summonCost: card.summon_cost,
    energy: card.energy,
    baseStats: {
      attack: card.attack,
      defense: card.defense,
      speed: card.speed
    },
    model3dUrl: card.model_3d_url ?? undefined
  };
}

async function getOwnedCard(cardId: string, userId: string): Promise<CardRow | undefined> {
  return get<CardRow>("SELECT * FROM cards WHERE id = ? AND owner_user_id = ?", [cardId, userId]);
}

export const cardsRouter = Router();

cardsRouter.get("/", async (req, res) => {
  const ownerUserId = typeof req.query.ownerUserId === "string" ? req.query.ownerUserId : undefined;

  const rows = ownerUserId
    ? await all<CardRow>("SELECT * FROM cards WHERE owner_user_id = ? ORDER BY created_at DESC", [ownerUserId])
    : await all<CardRow>("SELECT * FROM cards ORDER BY created_at DESC LIMIT 200");

  res.json({ items: rows.map(mapCard) });
});

cardsRouter.post("/", authRequired, async (req, res) => {
  const parsed = createCardSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid card payload", details: parsed.error.flatten() });
    return;
  }

  const balance = validateCardBalance(parsed.data);
  if (!balance.ok) {
    res.status(422).json({ error: "Card failed validator engine", details: balance.errors });
    return;
  }

  const userId = req.user!.id;
  const userPoints = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [userId]);
  if (!userPoints) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const cost = creativePointsCost(parsed.data.rarity);
  if (userPoints.creative_points < cost) {
    res.status(402).json({ error: "Not enough creative points", needed: cost, current: userPoints.creative_points });
    return;
  }

  const card = buildCardRecord(userId, parsed.data);
  const now = new Date().toISOString();
  const initialSnapshot: CardSnapshot = {
    id: card.id,
    ownerUserId: userId,
    name: card.name,
    hash: card.cardHash,
    r33Signature: card.r33Signature,
    rarity: card.rarity,
    cardClass: card.cardClass,
    abilities: parseJsonSafe<string[]>(card.abilitiesJson, []),
    summonCost: card.summonCost,
    energy: card.energy,
    baseStats: {
      attack: card.attack,
      defense: card.defense,
      speed: card.speed
    },
    model3dUrl: card.model3dUrl,
    metadata: parseJsonSafe<Record<string, unknown>>(card.metadataJson, {}),
    status: "published",
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  if (await hasDuplicateCardHash(card.cardHash)) {
    res.status(409).json({
      error: "An identical card already exists",
      cardHash: card.cardHash
    });
    return;
  }

  try {
    await run("BEGIN TRANSACTION");

    const debit = await run("UPDATE users SET creative_points = creative_points - ? WHERE id = ? AND creative_points >= ?", [
      cost,
      userId,
      cost
    ]);
    if (debit.changes === 0) {
      throw new Error("Not enough creative points");
    }

    await run(
      `
        INSERT INTO cards (
          id, owner_user_id, name, card_hash, r33_signature, rarity, class, abilities,
          summon_cost, energy, attack, defense, speed, model_3d_url, metadata, status, version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ?, ?)
      `,
      [
        card.id,
        card.ownerUserId,
        card.name,
        card.cardHash,
        card.r33Signature,
        card.rarity,
        card.cardClass,
        card.abilitiesJson,
        card.summonCost,
        card.energy,
        card.attack,
        card.defense,
        card.speed,
        card.model3dUrl,
        card.metadataJson,
        now,
        now
      ]
    );

    await run(
      `
        INSERT INTO inventory (id, user_id, card_id, source, active, acquired_at)
        VALUES (?, ?, ?, 'created', 1, ?)
      `,
      [randomUUID(), userId, card.id, now]
    );

    await run(
      `
        INSERT INTO card_versions (id, card_id, version, snapshot, change_note, created_by, created_at)
        VALUES (?, ?, 1, ?, 'card created', ?, ?)
      `,
      [randomUUID(), card.id, JSON.stringify(initialSnapshot), userId, now]
    );

    await run("COMMIT");
  } catch (error) {
    await safeRollback();

    const message = error instanceof Error ? error.message : "Failed to create card";
    if (message === "Not enough creative points") {
      res.status(402).json({ error: "Not enough creative points", needed: cost });
      return;
    }

    if (isSqliteUniqueConstraint(error, "cards.card_hash")) {
      res.status(409).json({
        error: "An identical card already exists",
        cardHash: card.cardHash
      });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(userId, "cards.create", {
    cardId: card.id,
    rarity: card.rarity,
    cost,
    version: 1
  });

  const updated = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [userId]);

  res.status(201).json({
    cardId: card.id,
    hash: card.cardHash,
    r33Signature: card.r33Signature,
    version: 1,
    creativePointsRemaining: updated?.creative_points ?? 0
  });
});

cardsRouter.post("/drafts", authRequired, async (req, res) => {
  const parsed = cardDraftPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid draft payload", details: parsed.error.flatten() });
    return;
  }

  const draftId = randomUUID();
  const now = new Date().toISOString();
  const evaluation = evaluateDraft(parsed.data);

  if (await hasDuplicateActiveDraftFingerprint(req.user!.id, evaluation.fingerprint)) {
    res.status(409).json({ error: "An equivalent draft already exists for this user" });
    return;
  }

  try {
    await run(
      `
        INSERT INTO card_drafts (
          id, owner_user_id, source_card_id, payload, fingerprint, status, validation_errors, version, published_card_id, created_at, updated_at
        )
        VALUES (?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?)
      `,
      [
        draftId,
        req.user!.id,
        JSON.stringify(parsed.data),
        evaluation.fingerprint,
        evaluation.status,
        JSON.stringify(evaluation.validationErrors),
        now,
        now
      ]
    );
  } catch (error) {
    if (isSqliteUniqueConstraint(error, ["card_drafts.owner_user_id", "card_drafts.fingerprint"])) {
      res.status(409).json({ error: "An equivalent draft already exists for this user" });
      return;
    }

    const message = error instanceof Error ? error.message : "Failed to create draft";
    res.status(500).json({ error: message });
    return;
  }

  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ?", [draftId]);
  await auditLog(req.user!.id, "cards.draft.create", {
    draftId,
    status: evaluation.status
  });

  res.status(201).json(draft ? mapDraft(draft) : { id: draftId, status: evaluation.status });
});

cardsRouter.get("/drafts", authRequired, async (req, res) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  const where: string[] = ["owner_user_id = ?"];
  const params: Array<string | number> = [req.user!.id];

  if (statusFilter) {
    where.push("status = ?");
    params.push(statusFilter);
  }

  const rows = await all<CardDraftRow>(
    `
      SELECT *
      FROM card_drafts
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT 300
    `,
    params
  );

  res.json({ items: rows.map(mapDraft) });
});

cardsRouter.get("/drafts/:draftId", authRequired, async (req, res) => {
  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ? AND owner_user_id = ?", [
    String(req.params.draftId),
    req.user!.id
  ]);

  if (!draft) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }

  res.json(mapDraft(draft));
});

cardsRouter.patch("/drafts/:draftId", authRequired, async (req, res) => {
  const parsed = cardDraftPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid draft patch payload", details: parsed.error.flatten() });
    return;
  }

  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ? AND owner_user_id = ?", [
    String(req.params.draftId),
    req.user!.id
  ]);
  if (!draft) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }

  if (draft.status === "published") {
    res.status(409).json({ error: "Published draft cannot be modified" });
    return;
  }

  if (draft.version !== parsed.data.expectedVersion) {
    res.status(409).json({
      error: "Draft version mismatch",
      expectedVersion: parsed.data.expectedVersion,
      currentVersion: draft.version
    });
    return;
  }

  const currentPayload = parseJsonSafe<z.infer<typeof cardDraftPayloadSchema>>(draft.payload, null as never);
  const mergedRaw = {
    ...(currentPayload ?? {}),
    ...parsed.data.changes
  };
  const merged = cardDraftPayloadSchema.safeParse(mergedRaw);
  if (!merged.success) {
    res.status(400).json({ error: "Invalid merged draft payload", details: merged.error.flatten() });
    return;
  }

  const evaluation = evaluateDraft(merged.data);
  const now = new Date().toISOString();
  const nextVersion = draft.version + 1;

  if (await hasDuplicateActiveDraftFingerprint(req.user!.id, evaluation.fingerprint, draft.id)) {
    res.status(409).json({ error: "An equivalent draft already exists for this user" });
    return;
  }

  try {
    await run(
      `
        UPDATE card_drafts
        SET payload = ?, fingerprint = ?, status = ?, validation_errors = ?, version = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND version = ?
      `,
      [
        JSON.stringify(merged.data),
        evaluation.fingerprint,
        evaluation.status,
        JSON.stringify(evaluation.validationErrors),
        nextVersion,
        now,
        draft.id,
        req.user!.id,
        draft.version
      ]
    );
  } catch (error) {
    if (isSqliteUniqueConstraint(error, ["card_drafts.owner_user_id", "card_drafts.fingerprint"])) {
      res.status(409).json({ error: "An equivalent draft already exists for this user" });
      return;
    }

    const message = error instanceof Error ? error.message : "Failed to update draft";
    res.status(500).json({ error: message });
    return;
  }

  const updatedDraft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ?", [draft.id]);
  await auditLog(req.user!.id, "cards.draft.update", {
    draftId: draft.id,
    fromVersion: draft.version,
    toVersion: nextVersion,
    status: evaluation.status
  });

  res.json(updatedDraft ? mapDraft(updatedDraft) : { id: draft.id, version: nextVersion });
});

cardsRouter.post("/drafts/:draftId/validate", authRequired, async (req, res) => {
  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ? AND owner_user_id = ?", [
    String(req.params.draftId),
    req.user!.id
  ]);
  if (!draft) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }

  if (draft.status === "published") {
    res.status(409).json({ error: "Draft is already published" });
    return;
  }

  const payload = cardDraftPayloadSchema.safeParse(parseJsonSafe<unknown>(draft.payload, {}));
  if (!payload.success) {
    res.status(422).json({ error: "Stored draft payload is invalid", details: payload.error.flatten() });
    return;
  }

  const evaluation = evaluateDraft(payload.data);
  const now = new Date().toISOString();
  await run("UPDATE card_drafts SET status = ?, validation_errors = ?, updated_at = ? WHERE id = ?", [
    evaluation.status,
    JSON.stringify(evaluation.validationErrors),
    now,
    draft.id
  ]);

  const updatedDraft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ?", [draft.id]);
  await auditLog(req.user!.id, "cards.draft.validate", {
    draftId: draft.id,
    status: evaluation.status,
    errors: evaluation.validationErrors.length
  });

  res.json({
    ok: evaluation.validationErrors.length === 0,
    errors: evaluation.validationErrors,
    draft: updatedDraft ? mapDraft(updatedDraft) : { id: draft.id, status: evaluation.status }
  });
});

cardsRouter.post("/drafts/:draftId/publish", authRequired, async (req, res) => {
  const options = cardPublishOptionsSchema.safeParse(req.body ?? {});
  if (!options.success) {
    res.status(400).json({ error: "Invalid publish options", details: options.error.flatten() });
    return;
  }

  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ? AND owner_user_id = ?", [
    String(req.params.draftId),
    req.user!.id
  ]);
  if (!draft) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }

  if (draft.status === "published" && draft.published_card_id) {
    res.status(409).json({ error: "Draft is already published", cardId: draft.published_card_id });
    return;
  }

  const payloadParsed = cardDraftPayloadSchema.safeParse(parseJsonSafe<unknown>(draft.payload, {}));
  if (!payloadParsed.success) {
    res.status(422).json({ error: "Stored draft payload is invalid", details: payloadParsed.error.flatten() });
    return;
  }

  const evaluation = evaluateDraft(payloadParsed.data);
  if (evaluation.validationErrors.length > 0) {
    await run("UPDATE card_drafts SET status = 'draft', validation_errors = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(evaluation.validationErrors),
      new Date().toISOString(),
      draft.id
    ]);
    res.status(422).json({ error: "Draft failed validator engine", details: evaluation.validationErrors });
    return;
  }

  const userId = req.user!.id;
  const userPoints = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [userId]);
  if (!userPoints) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const cardInput = toCreateCardInput(payloadParsed.data);
  const cost = creativePointsCost(payloadParsed.data.rarity);
  if (options.data.consumeCreativePoints && userPoints.creative_points < cost) {
    res.status(402).json({ error: "Not enough creative points", needed: cost, current: userPoints.creative_points });
    return;
  }

  const now = new Date().toISOString();
  const card = buildCardRecord(userId, cardInput);
  const snapshot: CardSnapshot = {
    id: card.id,
    ownerUserId: userId,
    name: card.name,
    hash: card.cardHash,
    r33Signature: card.r33Signature,
    rarity: card.rarity,
    cardClass: card.cardClass,
    abilities: parseJsonSafe<string[]>(card.abilitiesJson, []),
    summonCost: card.summonCost,
    energy: card.energy,
    baseStats: {
      attack: card.attack,
      defense: card.defense,
      speed: card.speed
    },
    model3dUrl: card.model3dUrl,
    metadata: parseJsonSafe<Record<string, unknown>>(card.metadataJson, {}),
    status: "published",
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  if (await hasDuplicateCardHash(card.cardHash)) {
    res.status(409).json({
      error: "An identical card already exists",
      cardHash: card.cardHash
    });
    return;
  }

  try {
    await run("BEGIN TRANSACTION");

    if (options.data.consumeCreativePoints) {
      const debit = await run("UPDATE users SET creative_points = creative_points - ? WHERE id = ? AND creative_points >= ?", [
        cost,
        userId,
        cost
      ]);
      if (debit.changes === 0) {
        throw new Error("Not enough creative points");
      }
    }

    await run(
      `
        INSERT INTO cards (
          id, owner_user_id, name, card_hash, r33_signature, rarity, class, abilities,
          summon_cost, energy, attack, defense, speed, model_3d_url, metadata, status, version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ?, ?)
      `,
      [
        card.id,
        card.ownerUserId,
        card.name,
        card.cardHash,
        card.r33Signature,
        card.rarity,
        card.cardClass,
        card.abilitiesJson,
        card.summonCost,
        card.energy,
        card.attack,
        card.defense,
        card.speed,
        card.model3dUrl,
        card.metadataJson,
        now,
        now
      ]
    );

    await run(
      `
        INSERT INTO inventory (id, user_id, card_id, source, active, acquired_at)
        VALUES (?, ?, ?, 'draft-publish', 1, ?)
      `,
      [randomUUID(), userId, card.id, now]
    );

    await run(
      `
        INSERT INTO card_versions (id, card_id, version, snapshot, change_note, created_by, created_at)
        VALUES (?, ?, 1, ?, 'published from draft', ?, ?)
      `,
      [randomUUID(), card.id, JSON.stringify(snapshot), userId, now]
    );

    await run(
      `
        UPDATE card_drafts
        SET status = 'published', published_card_id = ?, updated_at = ?, validation_errors = ?
        WHERE id = ? AND owner_user_id = ?
      `,
      [card.id, now, JSON.stringify([]), draft.id, userId]
    );

    await run("COMMIT");
  } catch (error) {
    await safeRollback();

    const message = error instanceof Error ? error.message : "Failed to publish draft";
    if (message === "Not enough creative points") {
      res.status(402).json({ error: "Not enough creative points", needed: cost });
      return;
    }

    if (isSqliteUniqueConstraint(error, "cards.card_hash")) {
      res.status(409).json({
        error: "An identical card already exists",
        cardHash: card.cardHash
      });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(userId, "cards.draft.publish", {
    draftId: draft.id,
    cardId: card.id,
    cost: options.data.consumeCreativePoints ? cost : 0
  });

  const updatedPoints = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [userId]);

  res.status(201).json({
    draftId: draft.id,
    cardId: card.id,
    hash: card.cardHash,
    r33Signature: card.r33Signature,
    creativePointsRemaining: updatedPoints?.creative_points ?? 0,
    status: "published"
  });
});

cardsRouter.post("/:id/clone-draft", authRequired, async (req, res) => {
  const cardId = String(req.params.id);
  const card = await getOwnedCard(cardId, req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  const payload = buildDraftPayloadFromCard(card);
  const evaluation = evaluateDraft(payload);
  const now = new Date().toISOString();
  const draftId = randomUUID();

  if (await hasDuplicateActiveDraftFingerprint(req.user!.id, evaluation.fingerprint)) {
    res.status(409).json({ error: "An equivalent draft already exists for this user" });
    return;
  }

  try {
    await run(
      `
        INSERT INTO card_drafts (
          id, owner_user_id, source_card_id, payload, fingerprint, status, validation_errors, version, published_card_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `,
      [
        draftId,
        req.user!.id,
        card.id,
        JSON.stringify(payload),
        evaluation.fingerprint,
        evaluation.status,
        JSON.stringify(evaluation.validationErrors),
        now,
        now
      ]
    );
  } catch (error) {
    if (isSqliteUniqueConstraint(error, ["card_drafts.owner_user_id", "card_drafts.fingerprint"])) {
      res.status(409).json({ error: "An equivalent draft already exists for this user" });
      return;
    }

    const message = error instanceof Error ? error.message : "Failed to clone card into draft";
    res.status(500).json({ error: message });
    return;
  }

  const draft = await get<CardDraftRow>("SELECT * FROM card_drafts WHERE id = ?", [draftId]);
  await auditLog(req.user!.id, "cards.clone-to-draft", {
    sourceCardId: card.id,
    draftId
  });

  res.status(201).json(draft ? mapDraft(draft) : { id: draftId });
});

cardsRouter.get("/:id/versions", authRequired, async (req, res) => {
  const card = await getOwnedCard(String(req.params.id), req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  const versions = await all<CardVersionRow>(
    `
      SELECT id, card_id, version, snapshot, change_note, created_by, created_at
      FROM card_versions
      WHERE card_id = ?
      ORDER BY version DESC
    `,
    [card.id]
  );

  res.json({
    cardId: card.id,
    currentVersion: card.version,
    items: versions.map(mapVersion)
  });
});

cardsRouter.post("/:id/revert", authRequired, async (req, res) => {
  const parsed = cardRevertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const card = await getOwnedCard(String(req.params.id), req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  const targetVersion = await get<CardVersionRow>("SELECT * FROM card_versions WHERE card_id = ? AND version = ?", [
    card.id,
    parsed.data.version
  ]);
  if (!targetVersion) {
    res.status(404).json({ error: "Card version not found" });
    return;
  }

  const snapshot = parseJsonSafe<CardSnapshot>(targetVersion.snapshot, null as never);
  if (!snapshot) {
    res.status(422).json({ error: "Corrupted card version snapshot" });
    return;
  }

  const revertPayload = cardDraftPayloadSchema.safeParse({
    name: snapshot.name,
    rarity: snapshot.rarity,
    cardClass: snapshot.cardClass,
    abilities: snapshot.abilities,
    summonCost: snapshot.summonCost,
    energy: snapshot.energy,
    baseStats: snapshot.baseStats,
    model3dUrl: snapshot.model3dUrl ?? undefined
  });
  if (!revertPayload.success) {
    res.status(422).json({ error: "Snapshot is not compatible with current card schema", details: revertPayload.error.flatten() });
    return;
  }

  const revertedCardRecord = buildCardRecord(req.user!.id, toCreateCardInput(revertPayload.data));
  const now = new Date().toISOString();
  const nextVersion = card.version + 1;

  if (await hasDuplicateCardHash(revertedCardRecord.cardHash, card.id)) {
    res.status(409).json({ error: "Revert would create a duplicate card hash" });
    return;
  }

  try {
    await run("BEGIN TRANSACTION");

    await run(
      `
        UPDATE cards
        SET
          name = ?,
          card_hash = ?,
          r33_signature = ?,
          rarity = ?,
          class = ?,
          abilities = ?,
          summon_cost = ?,
          energy = ?,
          attack = ?,
          defense = ?,
          speed = ?,
          model_3d_url = ?,
          metadata = ?,
          version = ?,
          updated_at = ?
        WHERE id = ? AND owner_user_id = ?
      `,
      [
        revertedCardRecord.name,
        revertedCardRecord.cardHash,
        revertedCardRecord.r33Signature,
        revertedCardRecord.rarity,
        revertedCardRecord.cardClass,
        revertedCardRecord.abilitiesJson,
        revertedCardRecord.summonCost,
        revertedCardRecord.energy,
        revertedCardRecord.attack,
        revertedCardRecord.defense,
        revertedCardRecord.speed,
        revertedCardRecord.model3dUrl,
        revertedCardRecord.metadataJson,
        nextVersion,
        now,
        card.id,
        req.user!.id
      ]
    );

    const updatedCard = await get<CardRow>("SELECT * FROM cards WHERE id = ?", [card.id]);
    if (!updatedCard) {
      throw new Error("Card not found after revert");
    }

    await run(
      `
        INSERT INTO card_versions (id, card_id, version, snapshot, change_note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        card.id,
        nextVersion,
        JSON.stringify(buildSnapshotFromCardRow(updatedCard)),
        parsed.data.note ?? `reverted to version ${parsed.data.version}`,
        req.user!.id,
        now
      ]
    );

    await run("COMMIT");
  } catch (error) {
    await safeRollback();
    if (isSqliteUniqueConstraint(error, "cards.card_hash")) {
      res.status(409).json({ error: "Revert would create a duplicate card hash" });
      return;
    }

    const message = error instanceof Error ? error.message : "Failed to revert card";
    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "cards.revert", {
    cardId: card.id,
    fromVersion: card.version,
    revertedToVersion: parsed.data.version,
    newVersion: nextVersion
  });

  const finalCard = await get<CardRow>("SELECT * FROM cards WHERE id = ?", [card.id]);
  res.json({
    card: finalCard ? mapCard(finalCard) : null,
    revertedToVersion: parsed.data.version,
    newVersion: nextVersion
  });
});

cardsRouter.post("/:id/archive", authRequired, async (req, res) => {
  const card = await getOwnedCard(String(req.params.id), req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  if (card.status === "archived") {
    res.json({ cardId: card.id, status: "archived" });
    return;
  }

  const now = new Date().toISOString();
  await run("BEGIN TRANSACTION");
  try {
    await run("UPDATE cards SET status = 'archived', updated_at = ? WHERE id = ? AND owner_user_id = ?", [now, card.id, req.user!.id]);
    await run("UPDATE inventory SET active = 0 WHERE user_id = ? AND card_id = ?", [req.user!.id, card.id]);
    await run("UPDATE market_listings SET status = 'cancelled' WHERE card_id = ? AND status = 'active'", [card.id]);
    await run("COMMIT");
  } catch (error) {
    await safeRollback();
    const message = error instanceof Error ? error.message : "Failed to archive card";
    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "cards.archive", { cardId: card.id });
  res.json({ cardId: card.id, status: "archived" });
});

cardsRouter.post("/:id/unarchive", authRequired, async (req, res) => {
  const card = await getOwnedCard(String(req.params.id), req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  if (card.status === "published") {
    res.json({ cardId: card.id, status: "published" });
    return;
  }

  const now = new Date().toISOString();
  await run("BEGIN TRANSACTION");
  try {
    await run("UPDATE cards SET status = 'published', updated_at = ? WHERE id = ? AND owner_user_id = ?", [now, card.id, req.user!.id]);

    const reactivate = await run(
      `
        UPDATE inventory
        SET active = 1, source = 'card-unarchived', acquired_at = ?
        WHERE user_id = ? AND card_id = ?
      `,
      [now, req.user!.id, card.id]
    );

    if (reactivate.changes === 0) {
      await run(
        `
          INSERT INTO inventory (id, user_id, card_id, source, active, acquired_at)
          VALUES (?, ?, ?, 'card-unarchived', 1, ?)
        `,
        [randomUUID(), req.user!.id, card.id, now]
      );
    }

    await run("COMMIT");
  } catch (error) {
    await safeRollback();
    const message = error instanceof Error ? error.message : "Failed to unarchive card";
    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "cards.unarchive", { cardId: card.id });
  res.json({ cardId: card.id, status: "published" });
});

cardsRouter.get("/:id", async (req, res) => {
  const cardId = String(req.params.id);
  const row = await get<CardRow>("SELECT * FROM cards WHERE id = ?", [cardId]);
  if (!row) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  res.json(mapCard(row));
});

cardsRouter.put("/:id/stats", authRequired, async (req, res) => {
  const cardId = String(req.params.id);
  const parsed = updateStatsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid stats payload", details: parsed.error.flatten() });
    return;
  }

  const card = await getOwnedCard(cardId, req.user!.id);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  if (card.status !== "published") {
    res.status(409).json({ error: "Only published cards can be edited in-place" });
    return;
  }

  const points = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [req.user!.id]);
  if (!points || points.creative_points < 1) {
    res.status(402).json({ error: "Not enough creative points for update", needed: 1 });
    return;
  }

  const validation = validateCardBalance({
    name: card.name,
    rarity: card.rarity,
    cardClass: card.class,
    abilities: parseJsonSafe<string[]>(card.abilities, []),
    summonCost: card.summon_cost,
    energy: card.energy,
    baseStats: parsed.data,
    model3dUrl: card.model_3d_url ?? undefined,
    isOriginal: true
  });

  if (!validation.ok) {
    res.status(422).json({ error: "New stats fail validator", details: validation.errors });
    return;
  }

  const now = new Date().toISOString();
  const nextVersion = card.version + 1;
  let updatedCard: CardRow | undefined;

  try {
    await run("BEGIN TRANSACTION");

    const debit = await run("UPDATE users SET creative_points = creative_points - 1 WHERE id = ? AND creative_points >= 1", [
      req.user!.id
    ]);
    if (debit.changes === 0) {
      throw new Error("Not enough creative points");
    }

    const update = await run(
      "UPDATE cards SET attack = ?, defense = ?, speed = ?, version = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
      [parsed.data.attack, parsed.data.defense, parsed.data.speed, nextVersion, now, card.id, req.user!.id]
    );
    if (update.changes === 0) {
      throw new Error("Card ownership changed");
    }

    updatedCard = await get<CardRow>("SELECT * FROM cards WHERE id = ?", [card.id]);
    if (!updatedCard) {
      throw new Error("Card not found after update");
    }

    await run(
      `
        INSERT INTO card_versions (id, card_id, version, snapshot, change_note, created_by, created_at)
        VALUES (?, ?, ?, ?, 'stats update', ?, ?)
      `,
      [randomUUID(), card.id, nextVersion, JSON.stringify(buildSnapshotFromCardRow(updatedCard)), req.user!.id, now]
    );

    await run("COMMIT");
  } catch (error) {
    await safeRollback();
    const message = error instanceof Error ? error.message : "Failed to update card stats";
    if (message === "Not enough creative points") {
      res.status(402).json({ error: "Not enough creative points for update", needed: 1 });
      return;
    }

    if (message === "Card ownership changed") {
      res.status(409).json({ error: "Card ownership changed; retry operation" });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "cards.update-stats", {
    cardId: card.id,
    stats: parsed.data,
    version: nextVersion
  });

  const updatedPoints = await get<UserPointsRow>("SELECT creative_points FROM users WHERE id = ?", [req.user!.id]);

  res.json({
    cardId: card.id,
    stats: parsed.data,
    version: nextVersion,
    creativePointsRemaining: updatedPoints?.creative_points ?? 0,
    card: updatedCard ? mapCard(updatedCard) : null
  });
});
