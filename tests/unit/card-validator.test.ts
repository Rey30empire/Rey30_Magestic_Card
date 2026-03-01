import assert from "node:assert/strict";
import test from "node:test";
import { buildCardFingerprint, buildCardRecord, creativePointsCost, validateCardBalance } from "../../src/services/card-validator";

test("creativePointsCost returns expected value by rarity", () => {
  assert.equal(creativePointsCost("common"), 1);
  assert.equal(creativePointsCost("rare"), 2);
  assert.equal(creativePointsCost("epic"), 3);
  assert.equal(creativePointsCost("legendary"), 5);
});

test("validateCardBalance rejects overpowered card", () => {
  const result = validateCardBalance({
    name: "Broken Titan",
    rarity: "common",
    cardClass: "tank",
    abilities: ["block", "counter"],
    summonCost: 1,
    energy: 10,
    baseStats: {
      attack: 20,
      defense: 20,
      speed: 20
    },
    isOriginal: true
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("buildCardFingerprint generates same hash for semantically identical cards", () => {
  const baseInput = {
    name: "Phoenix Guard",
    rarity: "epic" as const,
    cardClass: "Sentinel",
    abilities: ["Shield Aura", "Counter Burn", "Sky Dash"],
    summonCost: 6,
    energy: 7,
    baseStats: {
      attack: 12,
      defense: 14,
      speed: 9
    },
    isOriginal: true
  };

  const variantInput = {
    ...baseInput,
    name: "  phoenix guard  ",
    cardClass: "sentinel",
    abilities: ["sky dash", "shield aura", "counter burn"]
  };

  const fingerprintA = buildCardFingerprint(baseInput);
  const fingerprintB = buildCardFingerprint(variantInput);

  assert.equal(fingerprintA, fingerprintB);
});

test("buildCardRecord uses global card fingerprint regardless of owner", () => {
  const input = {
    name: "Blizzard Mage",
    rarity: "rare" as const,
    cardClass: "caster",
    abilities: ["freeze"],
    summonCost: 3,
    energy: 4,
    baseStats: {
      attack: 8,
      defense: 6,
      speed: 7
    },
    isOriginal: true
  };

  const cardA = buildCardRecord("user-a", input);
  const cardB = buildCardRecord("user-b", input);

  assert.equal(cardA.cardHash, cardB.cardHash);
});
