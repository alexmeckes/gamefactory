import assert from "node:assert/strict";
import test from "node:test";
import { evaluatorPlans, mapBounded } from "./index.js";

test("evaluator plans are ordered by declared relative cost", () => {
  assert.deepEqual(evaluatorPlans([
    { id: "slow", cost: 10 },
    "default",
    { id: "fast", cost: 0 }
  ]).map((item) => item.id), ["fast", "default", "slow"]);
});

test("bounded map preserves input order while bounding active work", async () => {
  let active = 0;
  let maximum = 0;
  const output = await mapBounded([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(output, [2, 4, 6, 8]);
  assert.equal(maximum, 2);
});
