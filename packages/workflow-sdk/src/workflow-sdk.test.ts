import assert from "node:assert/strict";
import test from "node:test";
import { emitTrace, evaluatorPlans, mapBounded } from "./index.js";

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

test("trace failures are observational and never fail the workflow", async () => {
  const debugMessages: string[] = [];
  const context = {
    trace: {
      runId: "test-run",
      emit: async () => {
        throw new Error("trace disk unavailable");
      }
    },
    logger: {
      debug: (message: string) => debugMessages.push(message)
    }
  };

  await assert.doesNotReject(() => emitTrace(context as never, {
    type: "node:progress",
    nodeId: "agent:test",
    message: "still working"
  }));
  assert.equal(debugMessages.length, 1);
  assert.match(debugMessages[0] ?? "", /Ignoring observational trace failure/);
});
