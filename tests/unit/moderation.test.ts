import assert from "node:assert/strict";
import test from "node:test";
import { moderateMessage } from "../../src/services/moderation";

test("moderateMessage blocks configured banned words", () => {
  const result = moderateMessage("this is a scam");
  assert.equal(result.ok, false);
  assert.ok((result.reason ?? "").includes("Blocked word"));
});

test("moderateMessage accepts normal short messages", () => {
  const result = moderateMessage("hola equipo");
  assert.equal(result.ok, true);
  assert.equal(result.clean, "hola equipo");
});
