import { sha256 } from "../utils/hash";

export type CardEngineRarity = "common" | "rare" | "epic" | "legendary";

export type CardEngineInputCard = {
  id?: string;
  name: string;
  rarity: CardEngineRarity;
  attack: number;
  defense: number;
  speed: number;
  abilities: string[];
};

export type CardEngineInput = {
  seed: string;
  maxTurns: number;
  leftCards: CardEngineInputCard[];
  rightCards: CardEngineInputCard[];
};

type SideKey = "left" | "right";

type CombatUnit = {
  uid: string;
  side: SideKey;
  slot: number;
  name: string;
  rarity: CardEngineRarity;
  attack: number;
  defense: number;
  speed: number;
  maxHp: number;
  hp: number;
  abilities: Set<string>;
};

const rarityBonus: Record<CardEngineRarity, number> = {
  common: 0,
  rare: 1,
  epic: 2,
  legendary: 3
};

function normalizeAbility(value: string): string {
  return value.trim().toLowerCase();
}

function deterministicInt(seed: string, key: string, maxExclusive: number): number {
  const safeMax = Math.max(1, maxExclusive);
  const hash = sha256(`${seed}::${key}`);
  const raw = Number.parseInt(hash.slice(0, 8), 16);
  return raw % safeMax;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildCombatUnit(card: CardEngineInputCard, side: SideKey, slot: number): CombatUnit {
  const abilities = new Set(card.abilities.map(normalizeAbility));
  const hpBase = 26 + card.defense * 2 + rarityBonus[card.rarity] * 2;

  return {
    uid: `${side}:${slot}:${card.id ?? card.name}`,
    side,
    slot,
    name: card.name,
    rarity: card.rarity,
    attack: card.attack,
    defense: card.defense,
    speed: card.speed,
    maxHp: hpBase,
    hp: hpBase,
    abilities
  };
}

function pickActive(units: CombatUnit[]): CombatUnit | undefined {
  return units.find((unit) => unit.hp > 0);
}

function applyStartTurnEffects(unit: CombatUnit): number {
  if (unit.hp <= 0) {
    return 0;
  }

  let healed = 0;
  if (unit.abilities.has("regen")) {
    healed += 1;
  }
  if (unit.abilities.has("legend-heart") && unit.hp <= Math.floor(unit.maxHp * 0.4)) {
    healed += 1;
  }

  if (healed > 0) {
    const before = unit.hp;
    unit.hp = clamp(unit.hp + healed, 0, unit.maxHp);
    return unit.hp - before;
  }

  return 0;
}

function computeInitiative(seed: string, turn: number, unit: CombatUnit): number {
  const quickStep = unit.abilities.has("quick-step") ? 1 : 0;
  const roll = deterministicInt(seed, `initiative:${turn}:${unit.uid}`, 4);
  return unit.speed + rarityBonus[unit.rarity] + quickStep + roll;
}

function computeDamage(seed: string, turn: number, attacker: CombatUnit, defender: CombatUnit): number {
  const berserk = attacker.abilities.has("berserk") && attacker.hp <= Math.floor(attacker.maxHp / 2) ? 2 : 0;
  const fury = attacker.abilities.has("fury") ? Math.floor((turn - 1) / 2) : 0;
  const attackPower = attacker.attack + berserk + fury + rarityBonus[attacker.rarity];
  const defenseFactor = attacker.abilities.has("pierce") ? 0.15 : 0.35;
  const defenseValue = Math.floor(defender.defense * defenseFactor);
  const shield = defender.abilities.has("shield") ? 1 : 0;
  const variance = deterministicInt(seed, `damage:${turn}:${attacker.uid}->${defender.uid}`, 3);

  return Math.max(1, attackPower + variance - defenseValue - shield);
}

function applyLifesteal(attacker: CombatUnit, dealtDamage: number): number {
  if (!attacker.abilities.has("lifesteal") || dealtDamage <= 0) {
    return 0;
  }

  const heal = Math.max(1, Math.floor(dealtDamage * 0.25));
  const before = attacker.hp;
  attacker.hp = clamp(attacker.hp + heal, 0, attacker.maxHp);
  return attacker.hp - before;
}

function totalHp(units: CombatUnit[]): number {
  return units.reduce((sum, unit) => sum + Math.max(0, unit.hp), 0);
}

export function simulateCardEngine(input: CardEngineInput): {
  seed: string;
  winner: SideKey | "draw";
  turns: number;
  timeline: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
} {
  const left = input.leftCards.map((card, index) => buildCombatUnit(card, "left", index));
  const right = input.rightCards.map((card, index) => buildCombatUnit(card, "right", index));

  const timeline: Array<Record<string, unknown>> = [];
  const maxTurns = clamp(input.maxTurns, 1, 30);
  let turnsPlayed = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turnsPlayed = turn;
    const leftActive = pickActive(left);
    const rightActive = pickActive(right);

    if (!leftActive || !rightActive) {
      break;
    }

    const leftHeal = applyStartTurnEffects(leftActive);
    const rightHeal = applyStartTurnEffects(rightActive);
    if (leftHeal > 0 || rightHeal > 0) {
      timeline.push({
        turn,
        type: "start-turn",
        leftHeal,
        rightHeal,
        leftHp: leftActive.hp,
        rightHp: rightActive.hp
      });
    }

    const leftInitiative = computeInitiative(input.seed, turn, leftActive);
    const rightInitiative = computeInitiative(input.seed, turn, rightActive);
    const order: CombatUnit[] =
      leftInitiative >= rightInitiative ? [leftActive, rightActive] : [rightActive, leftActive];

    for (const actor of order) {
      const defender = actor.side === "left" ? pickActive(right) : pickActive(left);
      if (!defender) {
        break;
      }

      if (actor.hp <= 0) {
        continue;
      }

      const damage = computeDamage(input.seed, turn, actor, defender);
      defender.hp = clamp(defender.hp - damage, 0, defender.maxHp);
      const lifestealHeal = applyLifesteal(actor, damage);

      timeline.push({
        turn,
        type: "attack",
        actorSide: actor.side,
        actorName: actor.name,
        targetSide: defender.side,
        targetName: defender.name,
        damage,
        lifestealHeal,
        targetHp: defender.hp
      });

      if (defender.hp <= 0) {
        timeline.push({
          turn,
          type: "ko",
          side: defender.side,
          unit: defender.name,
          slot: defender.slot
        });
      }
    }

    if (!pickActive(left) || !pickActive(right)) {
      break;
    }
  }

  const leftAlive = Boolean(pickActive(left));
  const rightAlive = Boolean(pickActive(right));
  const leftHp = totalHp(left);
  const rightHp = totalHp(right);

  let winner: SideKey | "draw" = "draw";
  if (leftAlive && !rightAlive) {
    winner = "left";
  } else if (rightAlive && !leftAlive) {
    winner = "right";
  } else if (leftHp > rightHp) {
    winner = "left";
  } else if (rightHp > leftHp) {
    winner = "right";
  }

  return {
    seed: input.seed,
    winner,
    turns: turnsPlayed,
    timeline,
    summary: {
      leftRemainingUnits: left.filter((unit) => unit.hp > 0).length,
      rightRemainingUnits: right.filter((unit) => unit.hp > 0).length,
      leftTotalHp: leftHp,
      rightTotalHp: rightHp
    }
  };
}
