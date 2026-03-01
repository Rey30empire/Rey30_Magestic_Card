import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sha256, stableJson } from "../utils/hash";

const rarityEnum = z.enum(["common", "rare", "epic", "legendary"]);

const statsSchema = z.object({
  attack: z.number().int().min(0).max(30),
  defense: z.number().int().min(0).max(30),
  speed: z.number().int().min(0).max(30)
});

export const createCardSchema = z.object({
  name: z.string().min(3).max(48),
  rarity: rarityEnum,
  cardClass: z.string().min(2).max(32),
  abilities: z.array(z.string().min(2).max(120)).min(1).max(5),
  summonCost: z.number().int().min(0).max(20),
  energy: z.number().int().min(0).max(20),
  baseStats: statsSchema,
  model3dUrl: z.string().url().optional(),
  isOriginal: z.boolean().default(true)
});

export type CreateCardInput = z.infer<typeof createCardSchema>;

const rarityMaxStats: Record<CreateCardInput["rarity"], number> = {
  common: 22,
  rare: 30,
  epic: 38,
  legendary: 46
};

const rarityMaxAbilities: Record<CreateCardInput["rarity"], number> = {
  common: 2,
  rare: 3,
  epic: 4,
  legendary: 5
};

const rarityPointsCost: Record<CreateCardInput["rarity"], number> = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 5
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAbilities(abilities: string[]): string[] {
  return abilities.map((ability) => normalizeText(ability)).sort();
}

export function creativePointsCost(rarity: CreateCardInput["rarity"]): number {
  return rarityPointsCost[rarity];
}

export function validateCardBalance(input: CreateCardInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const totalStats = input.baseStats.attack + input.baseStats.defense + input.baseStats.speed;

  if (totalStats > rarityMaxStats[input.rarity]) {
    errors.push(`Total stats (${totalStats}) exceed cap for ${input.rarity}.`);
  }

  if (input.abilities.length > rarityMaxAbilities[input.rarity]) {
    errors.push(`Too many abilities for ${input.rarity}.`);
  }

  if (input.summonCost > input.energy + 6) {
    errors.push("Summon cost is too high relative to energy.");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function buildCardFingerprint(input: CreateCardInput): string {
  const cardPayload = {
    name: normalizeText(input.name),
    rarity: input.rarity,
    cardClass: normalizeText(input.cardClass),
    abilities: normalizeAbilities(input.abilities),
    summonCost: input.summonCost,
    energy: input.energy,
    baseStats: {
      attack: input.baseStats.attack,
      defense: input.baseStats.defense,
      speed: input.baseStats.speed
    },
    model3dUrl: input.model3dUrl?.trim() ?? null
  };

  return sha256(stableJson(cardPayload));
}

export function buildCardRecord(userId: string, input: CreateCardInput): {
  id: string;
  ownerUserId: string;
  name: string;
  cardHash: string;
  r33Signature: string | null;
  rarity: CreateCardInput["rarity"];
  cardClass: string;
  abilitiesJson: string;
  summonCost: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  model3dUrl: string | null;
  metadataJson: string;
} {
  const cardHash = buildCardFingerprint(input);

  return {
    id: randomUUID(),
    ownerUserId: userId,
    name: input.name,
    cardHash,
    r33Signature: input.isOriginal ? `R33-${cardHash.slice(0, 12)}` : null,
    rarity: input.rarity,
    cardClass: input.cardClass,
    abilitiesJson: JSON.stringify(input.abilities),
    summonCost: input.summonCost,
    energy: input.energy,
    attack: input.baseStats.attack,
    defense: input.baseStats.defense,
    speed: input.baseStats.speed,
    model3dUrl: input.model3dUrl ?? null,
    metadataJson: JSON.stringify({
      source: "editor-modular-mvp",
      createdWithValidator: true
    })
  };
}
