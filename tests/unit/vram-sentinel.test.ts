import assert from "node:assert/strict";
import test from "node:test";
import { evaluateVramPolicy, parseNvidiaSmiCsvOutput } from "../../src/services/vram-sentinel";

test("parseNvidiaSmiCsvOutput parses gpu rows", () => {
  const parsed = parseNvidiaSmiCsvOutput(
    [
      "0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 11000, 13564",
      "1, GPU-bbbb, NVIDIA GeForce RTX 4080, 16384, 2000, 14384"
    ].join("\n")
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].index, 0);
  assert.equal(parsed[0].uuid, "GPU-aaaa");
  assert.equal(parsed[0].memoryTotalMb, 24564);
  assert.equal(parsed[0].memoryUsedMb, 11000);
  assert.equal(parsed[0].memoryFreeMb, 13564);
  assert.equal(parsed[1].index, 1);
  assert.equal(parsed[1].name, "NVIDIA GeForce RTX 4080");
});

test("evaluateVramPolicy allows healthy budget", () => {
  const evaluated = evaluateVramPolicy(
    [
      {
        index: 0,
        uuid: "GPU-aaaa",
        name: "GPU0",
        memoryTotalMb: 24564,
        memoryUsedMb: 12000,
        memoryFreeMb: 12564
      }
    ],
    {
      highWatermarkMb: 22000,
      minFreeMb: 1200,
      taskReserveMb: 1200
    }
  );

  assert.equal(evaluated.constrained, false);
  assert.equal(evaluated.reason, null);
});

test("evaluateVramPolicy blocks on high watermark", () => {
  const evaluated = evaluateVramPolicy(
    [
      {
        index: 0,
        uuid: "GPU-aaaa",
        name: "GPU0",
        memoryTotalMb: 24564,
        memoryUsedMb: 23000,
        memoryFreeMb: 1564
      }
    ],
    {
      highWatermarkMb: 22000,
      minFreeMb: 1200,
      taskReserveMb: 1200
    }
  );

  assert.equal(evaluated.constrained, true);
  assert.equal(evaluated.reason, "max_used_mb 23000 >= 22000");
});

test("evaluateVramPolicy blocks on low free / reserve", () => {
  const evaluated = evaluateVramPolicy(
    [
      {
        index: 0,
        uuid: "GPU-aaaa",
        name: "GPU0",
        memoryTotalMb: 24564,
        memoryUsedMb: 15000,
        memoryFreeMb: 900
      }
    ],
    {
      highWatermarkMb: 22000,
      minFreeMb: 1200,
      taskReserveMb: 1200
    }
  );

  assert.equal(evaluated.constrained, true);
  assert.equal(evaluated.reason, "min_free_mb 900 <= 1200");
});
