import assert from "node:assert/strict";
import test from "node:test";
import { aggregateInvocationUsage, invocationTokenTotal, parseInvocationUsage } from "./usage.js";

test("invocation usage validates model accounting and derives safe totals", () => {
  const usage = parseInvocationUsage({
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 25,
    reasoningTokens: 10,
    costUsd: 0.04,
    costSource: "provider-reported"
  }, { provider: "openai", model: "example-model" });
  assert.equal(invocationTokenTotal(usage), 125);
  assert.equal(usage?.provider, "openai");
  assert.equal(usage?.cachedInputTokens, 60);
  assert.throws(() => parseInvocationUsage({ inputTokens: -1 }), /non-negative/);
});

test("usage aggregation only reports complete token and cost totals", () => {
  const complete = aggregateInvocationUsage([
    { provider: "openai", model: "m", totalTokens: 100, costUsd: 0.1 },
    { provider: "openai", model: "m", inputTokens: 40, outputTokens: 10, costUsd: 0.05 }
  ]);
  assert.equal(complete?.totalTokens, 150);
  assert.ok(Math.abs((complete?.costUsd ?? 0) - 0.15) < 1e-12);
  assert.equal(complete?.model, "m");
  const partial = aggregateInvocationUsage([{ totalTokens: 100, costUsd: 0.1 }, { model: "local" }]);
  assert.equal(partial?.totalTokens, undefined);
  assert.equal(partial?.costUsd, undefined);
  const missing = aggregateInvocationUsage([{ totalTokens: 100, costUsd: 0.1 }, undefined]);
  assert.equal(missing?.totalTokens, undefined);
  assert.equal(missing?.costUsd, undefined);
});
