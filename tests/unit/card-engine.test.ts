import assert from "node:assert/strict";
import test from "node:test";
import { simulateCardEngine } from "../../src/services/card-engine";

test("simulateCardEngine is deterministic with same seed and decks", () => {
  const input = {
    seed: "seed-det-001",
    maxTurns: 12,
    leftCards: [
      {
        name: "Atlas",
        rarity: "epic" as const,
        attack: 12,
        defense: 14,
        speed: 8,
        abilities: ["shield", "regen"]
      }
    ],
    rightCards: [
      {
        name: "Raider",
        rarity: "rare" as const,
        attack: 10,
        defense: 9,
        speed: 10,
        abilities: ["quick-step"]
      }
    ]
  };

  const first = simulateCardEngine(input);
  const second = simulateCardEngine(input);

  assert.deepEqual(second, first);
});

test("simulateCardEngine clamps max turns to 30", () => {
  const result = simulateCardEngine({
    seed: "seed-clamp-001",
    maxTurns: 200,
    leftCards: [
      {
        name: "Wall A",
        rarity: "common",
        attack: 0,
        defense: 30,
        speed: 1,
        abilities: []
      }
    ],
    rightCards: [
      {
        name: "Wall B",
        rarity: "common",
        attack: 0,
        defense: 30,
        speed: 1,
        abilities: []
      }
    ]
  });

  assert.equal(result.turns, 30);
});

test("simulateCardEngine applies lifesteal when attacker has missing hp", () => {
  const result = simulateCardEngine({
    seed: "seed-lifesteal-001",
    maxTurns: 6,
    leftCards: [
      {
        name: "Vamp Knight",
        rarity: "epic",
        attack: 20,
        defense: 20,
        speed: 1,
        abilities: ["lifesteal"]
      }
    ],
    rightCards: [
      {
        name: "Swift Rogue",
        rarity: "rare",
        attack: 7,
        defense: 4,
        speed: 20,
        abilities: []
      }
    ]
  });

  const attackEvents = result.timeline.filter((event) => event.type === "attack");
  const hasLifesteal = attackEvents.some((event) => Number(event.lifestealHeal) > 0);
  assert.equal(hasLifesteal, true);
});
