import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FactoryRunner, MemoryLogger } from "@gamefactory/core";
import type { Campaign } from "@gamefactory/core";

test("autoresearch runs a resumable keep/discard campaign through lazy extensions", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-loop-"));
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "integration",
    objective: "improve score",
    projectRoot,
    workflow: "autoresearch",
    requires: ["workspace:mock.workspace", "agent:mock.agent", "evaluator:mock.score"],
    parameters: { workspace: "mock.workspace", agent: "mock.agent", evaluators: ["mock.score"] },
    acceptance: { primaryMetric: "score", direction: "maximize", minimumDelta: 0.01 },
    budget: { maximumExperiments: 4 }
  };
  const runner = new FactoryRunner({
    cwd: projectRoot,
    config: {
      apiVersion: "gamefactory.dev/v1",
      extensions: [resolve(extensionRoot, "../mock"), extensionRoot],
      resultLog: "results.jsonl"
    },
    logger: new MemoryLogger()
  });
  try {
    await runner.initialize();
    assert.equal(runner.extensions.explain(["workflow:autoresearch"])[0]?.active, false);
    const result = await runner.run(campaign);
    assert.equal(result.status, "budget-exhausted");
    assert.equal(result.experiments.length, 5);
    assert.deepEqual(result.experiments.map((item) => item.status), ["baseline", "keep", "keep", "discard", "keep"]);
    assert.equal(result.bestMetrics.score, 0.65);
  } finally {
    await runner.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
