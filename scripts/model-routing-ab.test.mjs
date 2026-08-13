import assert from "node:assert/strict";
import test from "node:test";
import { BENCHMARK_TASKS, rankProfiles, scoreResponse } from "./model-routing-ab.mjs";

test("routing benchmark scores grounded concepts, evidence, structure, and recommendation", () => {
  const task = BENCHMARK_TASKS[0];
  const response = {
    outcome: "complete",
    findings: [
      { issue: "Zero length division can produce NaN", evidence: "src/rope_integrator.gd" },
      { issue: "Crossing order and over/under topology are ignored", evidence: "src/knot_detector.gd" },
      { issue: "No grab radius means click anywhere selects the nearest point", evidence: "src/drag_controller.gd" },
      { issue: "Crossing legibility needs a gap or bridge", evidence: "STYLE_CONTRACT.md" }
    ],
    recommendation: "Guard zero-length segments first, enforce a grab radius, encode crossing order in detection, then render explicit over-under bridges at crossings."
  };
  assert.equal(scoreResponse(task, response).score, 100);
});

test("routing benchmark recommends the token-efficient near-quality tie and reports Pareto arms", () => {
  const ranking = rankProfiles([
    { id: "luna-high", quality: 98, latencyMs: 1_000, totalTokens: 1_000, runs: 2, successfulRuns: 2 },
    { id: "sol-medium", quality: 100, latencyMs: 2_000, totalTokens: 2_000, runs: 2, successfulRuns: 2 },
    { id: "sol-high", quality: 100, latencyMs: 3_000, totalTokens: 3_000, runs: 2, successfulRuns: 2 }
  ]);
  assert.equal(ranking.recommendedProfileId, "luna-high");
  assert.deepEqual(ranking.paretoProfileIds, ["luna-high", "sol-medium"]);
});
