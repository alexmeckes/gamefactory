import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BudgetController } from "./budget.js";
import { decideAcceptance } from "./decision.js";
import { CapabilityRegistry } from "./registry.js";
import { JsonlResultStore } from "./results.js";
import type { Evaluation, ExperimentRecord } from "./types.js";

const evaluation = (score: number): Evaluation => ({
  evaluator: "score",
  version: "1",
  status: "pass",
  metrics: { score },
  violations: [],
  artifacts: []
});

test("registry registers and disposes capabilities", () => {
  const registry = new CapabilityRegistry();
  const disposable = registry.register("evaluator", "demo", { value: 1 }, "test");
  assert.equal(registry.get<{ value: number }>("evaluator", "demo").value, 1);
  disposable.dispose();
  assert.throws(() => registry.get("evaluator", "demo"));
});

test("acceptance honors direction and minimum delta", () => {
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", minimumDelta: 0.01 },
    [evaluation(0.5)],
    [evaluation(0.52)]
  ).accepted, true);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", minimumDelta: 0.01 },
    [evaluation(0.5)],
    [evaluation(0.505)]
  ).accepted, false);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", minimumDelta: 0.01 },
    [evaluation(0.5)],
    [evaluation(0.51)]
  ).accepted, true);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", minimumDelta: 0 },
    [evaluation(1)],
    [evaluation(1)]
  ).accepted, false);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", minimumDelta: 0, comparison: "at-least" },
    [{ evaluator: "fixture", version: "1", status: "pass", metrics: { score: 1 }, violations: [], artifacts: [] }],
    [{ evaluator: "fixture", version: "1", status: "pass", metrics: { score: 1 }, violations: [], artifacts: [] }]
  ).accepted, true);
});

test("acceptance enforces declared hard and human evaluator gates", () => {
  const quality = { ...evaluation(0.8), evaluator: "quality" };
  const human = { ...evaluation(1), evaluator: "playtest.human" };
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", hardGates: ["quality"] },
    [evaluation(0.5)],
    [evaluation(0.8)]
  ).accepted, false);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", hardGates: ["quality"] },
    [evaluation(0.5)],
    [evaluation(0.8), quality],
    { humanGates: ["playtest.human"] }
  ).accepted, false);
  assert.equal(decideAcceptance(
    { primaryMetric: "score", direction: "maximize", hardGates: ["quality"] },
    [evaluation(0.5)],
    [evaluation(0.8), quality, human],
    { humanGates: ["playtest.human"] }
  ).accepted, true);
});

test("budget stops after experiment limit", () => {
  const budget = new BudgetController({ maximumExperiments: 1 });
  assert.equal(budget.remainingExperiments(), 1);
  assert.equal(budget.canStart().allowed, true);
  budget.record({ status: "keep" });
  assert.equal(budget.remainingExperiments(), 0);
  assert.equal(budget.canStart().allowed, false);
});

test("budget can reserve a tournament-sized batch", () => {
  const budget = new BudgetController({ maximumExperiments: 3 });
  assert.equal(budget.canStart(3).allowed, true);
  assert.equal(budget.canStart(4).allowed, false);
});

test("budget reservations enforce parallel capacity and settle once", () => {
  const budget = new BudgetController({ maximumExperiments: 3, maximumCostUsd: 2 });
  const leases = Array.from({ length: 10 }, (_, index) => budget.tryReserve({ experimentId: `slot-${index}`, estimatedCostUsd: 0.5 })).filter((item) => item !== undefined);
  assert.equal(leases.length, 3);
  assert.equal(budget.remainingExperiments(), 0);
  leases[0]!.settle({ status: "discard", actualCostUsd: 0.4 });
  leases[0]!.settle({ status: "crash", actualCostUsd: 10 });
  leases[1]!.cancel();
  leases[1]!.cancel();
  leases[2]!.settle({ status: "keep", actualCostUsd: 0.5 });
  assert.equal(budget.experiments, 2);
  assert.equal(budget.costUsd, 0.9);
  assert.equal(budget.remainingExperiments(), 1);
});

test("JSONL results round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-core-"));
  try {
    const path = join(directory, "results.jsonl");
    const store = new JsonlResultStore(path);
    const record: ExperimentRecord = {
      campaignId: "demo",
      experimentId: "baseline",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      status: "baseline",
      summary: "baseline",
      metrics: { score: 1 },
      evaluations: [evaluation(1)]
    };
    await store.append(record);
    assert.deepEqual(await store.read("demo"), [record]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL results serialize concurrent appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-results-"));
  try {
    const path = join(directory, "results.jsonl");
    const store = new JsonlResultStore(path);
    const secondStore = new JsonlResultStore(path);
    const records = Array.from({ length: 25 }, (_, index): ExperimentRecord => ({
      campaignId: "parallel",
      experimentId: `candidate-${index}`,
      startedAt: new Date(index).toISOString(),
      finishedAt: new Date(index).toISOString(),
      status: "discard",
      summary: "parallel write",
      metrics: { index },
      evaluations: []
    }));
    await Promise.all(records.map((record, index) => (index % 2 === 0 ? store : secondStore).append(record)));
    assert.deepEqual((await store.read("parallel")).map((record) => record.experimentId), records.map((record) => record.experimentId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
