import { sha256 } from "../utils/hash";

export type AiLevel = "novato" | "guerrero" | "dragon" | "maestra";

type CardStat = {
  attack: number;
  defense: number;
  speed: number;
  rarity: "common" | "rare" | "epic" | "legendary";
};

const aiBasePower: Record<AiLevel, number> = {
  novato: 18,
  guerrero: 26,
  dragon: 34,
  maestra: 42
};

const aiWinPenalty: Record<AiLevel, number> = {
  novato: 4,
  guerrero: 7,
  dragon: 10,
  maestra: 13
};

const aiWinReward: Record<AiLevel, { elo: number; points: number }> = {
  novato: { elo: 8, points: 1 },
  guerrero: { elo: 14, points: 2 },
  dragon: { elo: 20, points: 3 },
  maestra: { elo: 26, points: 5 }
};

const rarityMultiplier: Record<CardStat["rarity"], number> = {
  common: 1,
  rare: 1.08,
  epic: 1.16,
  legendary: 1.25
};

function deterministicRoll(seed: string): number {
  return Number.parseInt(sha256(seed).slice(0, 8), 16) % 100;
}

export function simulateAiDuel(input: {
  userId: string;
  aiLevel: AiLevel;
  cardStats: CardStat[];
}): {
  result: "win" | "lose";
  eloDelta: number;
  creativePointsReward: number;
  debug: {
    playerPower: number;
    aiPower: number;
    roll: number;
  };
} {
  const playerPower = input.cardStats.reduce((acc, c) => {
    const raw = c.attack * 1.3 + c.defense * 1.1 + c.speed * 0.9;
    return acc + raw * rarityMultiplier[c.rarity];
  }, 0);

  const seed = [
    input.userId,
    input.aiLevel,
    input.cardStats
      .map((c) => `${c.attack}:${c.defense}:${c.speed}:${c.rarity}`)
      .sort()
      .join("|")
  ].join("::");

  const roll = deterministicRoll(seed);
  const aiPower = aiBasePower[input.aiLevel] + (100 - roll) * 0.21;
  const finalPlayerPower = playerPower + roll * 0.2;

  const result = finalPlayerPower >= aiPower ? "win" : "lose";

  if (result === "win") {
    return {
      result,
      eloDelta: aiWinReward[input.aiLevel].elo,
      creativePointsReward: aiWinReward[input.aiLevel].points,
      debug: {
        playerPower: Number(finalPlayerPower.toFixed(2)),
        aiPower: Number(aiPower.toFixed(2)),
        roll
      }
    };
  }

  return {
    result,
    eloDelta: -aiWinPenalty[input.aiLevel],
    creativePointsReward: 0,
    debug: {
      playerPower: Number(finalPlayerPower.toFixed(2)),
      aiPower: Number(aiPower.toFixed(2)),
      roll
    }
  };
}
