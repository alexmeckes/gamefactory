import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FactoryRunner, MemoryLogger, WorkflowJournal } from "@gamefactory/core";
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
  const factoryConfig = {
    apiVersion: "gamefactory.dev/v1" as const,
    extensions: [resolve(extensionRoot, "../mock"), extensionRoot],
    resultLog: "results.jsonl"
  };
  const runner = new FactoryRunner({
    cwd: projectRoot,
    config: factoryConfig,
    logger: new MemoryLogger()
  });
  try {
    await runner.initialize();
    assert.equal(runner.extensions.explain(["workflow:autoresearch"])[0]?.active, false);
    const { budget: _operationalBudget, ...campaignBehavior } = campaign;
    const campaignFingerprint = createHash("sha256").update(JSON.stringify(campaignBehavior)).digest("hex");
    const configFingerprint = createHash("sha256").update(JSON.stringify(factoryConfig)).digest("hex");
    const runFingerprint = createHash("sha256").update(`${campaignFingerprint}:${configFingerprint}`).digest("hex");
    const runId = `${campaign.id}-${runFingerprint.slice(0, 16)}`;
    const fingerprints = {
      campaign: campaignFingerprint,
      config: configFingerprint,
      project: `unversioned:${resolve(projectRoot)}`
    };
    const interruptedRoot = resolve(projectRoot, ".factory", "mock-candidates", "exp-0001");
    await mkdir(interruptedRoot, { recursive: true });
    await writeFile(resolve(interruptedRoot, "orphan.txt"), "orphan", "utf8");
    const journal = new WorkflowJournal(resolve(projectRoot, ".factory", "journal", "integration.jsonl"));
    await journal.append({ runId, campaignId: campaign.id, experimentId: "exp-0001", phase: "reserved", idempotencyKey: "interrupted-reserved", fingerprints });
    await journal.append({
      runId,
      campaignId: campaign.id,
      experimentId: "exp-0001",
      phase: "candidate-created",
      idempotencyKey: "interrupted-candidate",
      fingerprints,
      data: { candidate: { id: "exp-0001", root: interruptedRoot, metadata: { isolated: true } } }
    });
    const result = await runner.run(campaign);
    assert.equal(result.status, "budget-exhausted");
    assert.equal(result.experiments.length, 5);
    assert.deepEqual(result.experiments.map((item) => item.status), ["baseline", "keep", "keep", "discard", "keep"]);
    assert.equal(result.bestMetrics.score, 0.65);
    const recovery = await new WorkflowJournal(resolve(projectRoot, ".factory", "journal", "integration.jsonl")).recover();
    assert.equal(recovery.incomplete.length, 0);
    assert.equal(recovery.experiments.length, 5);
    assert.ok(recovery.experiments.every((experiment) => experiment.latestPhase === "cleaned"));
    assert.deepEqual(recovery.experiments.find((experiment) => experiment.experimentId === "exp-0001")?.entries.map((entry) => entry.phase).slice(-9), [
      "reserved",
      "candidate-created",
      "agent-finished",
      "evaluated",
      "evidence-preserved",
      "acceptance-intent",
      "applied",
      "recorded",
      "cleaned"
    ]);
    const resumed = await runner.run(campaign);
    assert.equal(resumed.experiments.length, 5);
  } finally {
    await runner.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("autoresearch blocks and retains a candidate when evidence cannot be preserved", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-evidence-block-"));
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "evidence-block",
    objective: "retain evidence before cleanup",
    projectRoot,
    workflow: "autoresearch",
    requires: ["workspace:mock.workspace", "agent:mock.agent", "evaluator:mock.score"],
    parameters: { workspace: "mock.workspace", agent: "mock.agent", evaluators: ["mock.score"], mockMissingArtifact: true },
    acceptance: { primaryMetric: "score", direction: "maximize" },
    budget: { maximumExperiments: 1 }
  };
  const runner = new FactoryRunner({
    cwd: projectRoot,
    config: { apiVersion: "gamefactory.dev/v1", extensions: [resolve(extensionRoot, "../mock"), extensionRoot] },
    logger: new MemoryLogger()
  });
  try {
    await runner.initialize();
    const result = await runner.run(campaign);
    assert.equal(result.status, "blocked");
    assert.equal(result.experiments.at(-1)?.status, "blocked");
    const candidateRoot = resolve(projectRoot, ".factory", "mock-candidates", "exp-0001");
    assert.equal((await stat(candidateRoot)).isDirectory(), true);
    const recovery = await new WorkflowJournal(resolve(projectRoot, ".factory", "journal", "evidence-block.jsonl")).recover();
    assert.equal(recovery.incomplete[0]?.latestPhase, "blocked");
  } finally {
    await runner.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
