import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { simulateCardEngine } from "../services/card-engine";
import { AiLevel, simulateAiDuel } from "../services/duel-engine";
import { sha256 } from "../utils/hash";

type CardRow = {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  attack: number;
  defense: number;
  speed: number;
};

type UserRow = {
  creative_points: number;
  elo: number;
};

const duelSchema = z.object({
  aiLevel: z.enum(["novato", "guerrero", "dragon", "maestra"]),
  cardIds: z.array(z.string().min(5)).min(1).max(10)
});

const engineCardSchema = z.object({
  id: z.string().min(2).max(120).optional(),
  name: z.string().min(2).max(80),
  rarity: z.enum(["common", "rare", "epic", "legendary"]),
  attack: z.number().int().min(0).max(30),
  defense: z.number().int().min(0).max(30),
  speed: z.number().int().min(0).max(30),
  abilities: z.array(z.string().min(1).max(80)).max(8).default([])
});

const engineSimulateSchema = z.object({
  seed: z.string().min(4).max(120).optional(),
  maxTurns: z.number().int().min(1).max(30).default(12),
  left: z.object({
    deckName: z.string().min(2).max(80).optional(),
    cards: z.array(engineCardSchema).min(1).max(5)
  }),
  right: z.object({
    deckName: z.string().min(2).max(80).optional(),
    cards: z.array(engineCardSchema).min(1).max(5)
  })
});

export const duelsRouter = Router();

duelsRouter.post("/engine/simulate", authRequired, async (req, res) => {
  const parsed = engineSimulateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid engine simulation payload", details: parsed.error.flatten() });
    return;
  }

  const seed =
    parsed.data.seed ??
    sha256(
      JSON.stringify({
        userId: req.user!.id,
        left: parsed.data.left.cards.map((card) => ({ ...card, abilities: [...card.abilities].sort() })),
        right: parsed.data.right.cards.map((card) => ({ ...card, abilities: [...card.abilities].sort() }))
      })
    ).slice(0, 20);

  const result = simulateCardEngine({
    seed,
    maxTurns: parsed.data.maxTurns,
    leftCards: parsed.data.left.cards,
    rightCards: parsed.data.right.cards
  });

  await auditLog(req.user!.id, "duel.engine.simulate", {
    seed: result.seed,
    winner: result.winner,
    turns: result.turns,
    leftCards: parsed.data.left.cards.length,
    rightCards: parsed.data.right.cards.length
  });

  res.json({
    ...result,
    decks: {
      left: parsed.data.left.deckName ?? "left",
      right: parsed.data.right.deckName ?? "right"
    },
    note: "Deterministic card engine simulation. Same seed + same decks => same result."
  });
});

duelsRouter.post("/ai", authRequired, async (req, res) => {
  const parsed = duelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid duel payload", details: parsed.error.flatten() });
    return;
  }

  const placeholders = parsed.data.cardIds.map(() => "?").join(", ");
  const rows = await all<CardRow>(
    `
      SELECT c.id, c.rarity, c.attack, c.defense, c.speed
      FROM cards c
      INNER JOIN inventory i ON i.card_id = c.id
      WHERE i.user_id = ? AND i.active = 1 AND c.status = 'published' AND c.id IN (${placeholders})
    `,
    [req.user!.id, ...parsed.data.cardIds]
  );

  if (rows.length === 0) {
    res.status(400).json({ error: "No valid active cards selected" });
    return;
  }

  const result = simulateAiDuel({
    userId: req.user!.id,
    aiLevel: parsed.data.aiLevel as AiLevel,
    cardStats: rows.map((r) => ({
      attack: r.attack,
      defense: r.defense,
      speed: r.speed,
      rarity: r.rarity
    }))
  });

  await run("UPDATE users SET elo = elo + ?, creative_points = creative_points + ? WHERE id = ?", [
    result.eloDelta,
    result.creativePointsReward,
    req.user!.id
  ]);

  await run(
    `
      INSERT INTO duel_history (id, user_id, ai_level, result, elo_delta, creative_points_reward, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [randomUUID(), req.user!.id, parsed.data.aiLevel, result.result, result.eloDelta, result.creativePointsReward, new Date().toISOString()]
  );

  const updatedUser = await get<UserRow>("SELECT creative_points, elo FROM users WHERE id = ?", [req.user!.id]);

  await auditLog(req.user!.id, "duel.ai", {
    aiLevel: parsed.data.aiLevel,
    cardCount: rows.length,
    result: result.result,
    eloDelta: result.eloDelta
  });

  res.json({
    aiLevel: parsed.data.aiLevel,
    result: result.result,
    eloDelta: result.eloDelta,
    creativePointsReward: result.creativePointsReward,
    debug: result.debug,
    user: {
      elo: updatedUser?.elo ?? 1000,
      creativePoints: updatedUser?.creative_points ?? 0
    }
  });
});
