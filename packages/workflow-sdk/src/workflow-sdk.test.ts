import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { isInfrastructureFailure, WorkflowJournal } from "@gamefactory/core";
import type { AgentDriver, Campaign, Candidate, ExperimentRecord, WorkflowContext, WorkspaceDriver } from "@gamefactory/core";
import { emitTrace, evaluateWaterfall, evaluatorPlans, mapBounded, recoverWorkflow } from "./index.js";

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

test("evaluator crashes remain infrastructure failures instead of candidate rejection", async () => {
  const context = {
    campaign: { id: "test", projectRoot: "." },
    signal: new AbortController().signal,
    get: () => ({
      id: "reviewer",
      version: "1.0.0",
      evaluate: async () => { throw new Error("provider unavailable"); }
    }),
    preserveArtifacts: async (artifacts: unknown[]) => artifacts,
    logger: { debug() {} }
  };
  await assert.rejects(
    () => evaluateWaterfall(context as never, [{ id: "reviewer", cost: 0, order: 0 }], { id: "candidate", root: ".", metadata: {} }, "exp-1"),
    (error: unknown) => isInfrastructureFailure(error) && error instanceof Error && /provider unavailable/.test(error.message)
  );
});

function recoveryFixture(journal: WorkflowJournal, campaign: Campaign, records: ExperimentRecord[], agent: AgentDriver): WorkflowContext {
  const runId = "recovery-run";
  const fingerprints = { campaign: "campaign-fingerprint", config: "config-fingerprint", project: "project-fingerprint" };
  return {
    campaign,
    signal: new AbortController().signal,
    startedAt: "2026-01-01T00:00:00.000Z",
    get: (_kind, id) => {
      if (id !== agent.id) throw new Error(`Unexpected capability ${id}`);
      return agent as never;
    },
    getAll: () => [],
    appendRecord: async (record) => { records.push(record); },
    readRecords: async () => [...records],
    preserveArtifacts: async (artifacts) => artifacts,
    journal: {
      runId,
      fingerprints,
      append: (input) => journal.append({ ...input, runId, campaignId: campaign.id, fingerprints }),
      appendRecovered: (input) => journal.append(input),
      recover: () => journal.recover()
    },
    emit: async () => undefined,
    budget: {} as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  };
}

async function appendRecoveryPhase(journal: WorkflowJournal, campaign: Campaign, experimentId: string, phase: Parameters<WorkflowJournal["append"]>[0]["phase"], data?: unknown): Promise<void> {
  await journal.append({
    runId: "recovery-run",
    campaignId: campaign.id,
    experimentId,
    phase,
    idempotencyKey: `${experimentId}:${phase}`,
    fingerprints: { campaign: "campaign-fingerprint", config: "config-fingerprint", project: "project-fingerprint" },
    ...(data === undefined ? {} : { data: JSON.parse(JSON.stringify(data)) })
  });
}

test("recovery idempotently completes an acceptance interrupted before workspace acknowledgement", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "workflow-recovery-accept-"));
  const journal = new WorkflowJournal(resolve(root, "journal.jsonl"));
  const campaign: Campaign = { apiVersion: "gamefactory.dev/v1", id: "recovery", objective: "recover", projectRoot: root, workflow: "test", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } };
  const candidate: Candidate = { id: "exp-1", root: resolve(root, "candidate"), baseRevision: "base", metadata: {} };
  const records: ExperimentRecord[] = [];
  let accepts = 0;
  let finalizes = 0;
  const workspace: WorkspaceDriver = {
    id: "idempotent.workspace",
    async createCandidate() { return candidate; },
    async acceptCandidate({ operationId }) { accepts += 1; assert.equal(operationId, "op-1"); return { revision: "accepted", candidateRevision: "candidate", changed: true }; },
    async discardCandidate() {}
  };
  const agent: AgentDriver = {
    id: "recoverable.agent",
    async run() { return { summary: "unused" }; },
    async finalize(request) { finalizes += 1; assert.equal(request.accepted, true); }
  };
  try {
    await appendRecoveryPhase(journal, campaign, "exp-1", "reserved", { startedAt: "2026-01-01T00:00:00.000Z" });
    await appendRecoveryPhase(journal, campaign, "exp-1", "candidate-created", { candidate });
    await appendRecoveryPhase(journal, campaign, "exp-1", "acceptance-intent", {
      action: "accept",
      operationId: "op-1",
      recoveryMetadata: { tournament: { round: 7, slot: 2 } },
      finalization: { agentId: agent.id, candidate, accepted: true, reason: "candidate-accepted", evaluations: [{ evaluator: "score", version: "1", status: "pass", metrics: { score: 1 }, violations: [], artifacts: [] }], result: { summary: "candidate complete" } }
    });
    const first = await recoverWorkflow(recoveryFixture(journal, campaign, records, agent), workspace);
    assert.equal(first.blocked, undefined);
    assert.equal(accepts, 1);
    assert.equal(finalizes, 1);
    assert.equal(records[0]?.status, "keep");
    assert.equal(records[0]?.revision, "accepted");
    assert.deepEqual(records[0]?.metadata?.tournament, { round: 7, slot: 2 });
    assert.deepEqual((await journal.recover()).experiments[0]?.entries.map((entry) => entry.phase), ["reserved", "candidate-created", "acceptance-intent", "workspace-applied", "agent-finalization-intent", "agent-finalized", "applied", "recorded", "cleaned"]);
    await recoverWorkflow(recoveryFixture(journal, campaign, records, agent), workspace);
    assert.equal(accepts, 1);
    assert.equal(finalizes, 1);
    assert.equal(records.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery records a finalized decision without replaying workspace mutation or finalization", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "workflow-recovery-finalize-"));
  const journal = new WorkflowJournal(resolve(root, "journal.jsonl"));
  const campaign: Campaign = { apiVersion: "gamefactory.dev/v1", id: "recovery-finalize", objective: "recover", projectRoot: root, workflow: "test", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } };
  const candidate: Candidate = { id: "exp-2", root: resolve(root, "candidate"), metadata: {} };
  const records: ExperimentRecord[] = [];
  let accepts = 0;
  let finalizes = 0;
  const workspace: WorkspaceDriver = { id: "workspace", async createCandidate() { return candidate; }, async acceptCandidate() { accepts += 1; return { changed: true }; }, async discardCandidate() {} };
  const agent: AgentDriver = { id: "agent", async run() { return { summary: "unused" }; }, async finalize() { finalizes += 1; } };
  const finalization = { agentId: agent.id, candidate, accepted: true, reason: "accepted", evaluations: [], result: { summary: "finished" } };
  try {
    await appendRecoveryPhase(journal, campaign, "exp-2", "reserved", { startedAt: "2026-01-01T00:00:00.000Z" });
    await appendRecoveryPhase(journal, campaign, "exp-2", "candidate-created", { candidate });
    await appendRecoveryPhase(journal, campaign, "exp-2", "acceptance-intent", { action: "accept", operationId: "op-2", finalization });
    await appendRecoveryPhase(journal, campaign, "exp-2", "workspace-applied", { action: "accept", operationId: "op-2", result: { revision: "accepted", changed: true } });
    await appendRecoveryPhase(journal, campaign, "exp-2", "agent-finalization-intent", finalization);
    await appendRecoveryPhase(journal, campaign, "exp-2", "agent-finalized", { agentId: agent.id, accepted: true, reason: "accepted" });
    const result = await recoverWorkflow(recoveryFixture(journal, campaign, records, agent), workspace);
    assert.equal(result.blocked, undefined);
    assert.equal(accepts, 0);
    assert.equal(finalizes, 0);
    assert.equal(records[0]?.revision, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery preserves an accepted no-op as a keep on the base revision", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "workflow-recovery-no-op-"));
  const journal = new WorkflowJournal(resolve(root, "journal.jsonl"));
  const campaign: Campaign = { apiVersion: "gamefactory.dev/v1", id: "recovery-no-op", objective: "recover", projectRoot: root, workflow: "test", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } };
  const candidate: Candidate = { id: "exp-no-op", root: resolve(root, "candidate"), baseRevision: "existing-revision", metadata: {} };
  const records: ExperimentRecord[] = [];
  let finalizes = 0;
  const workspace: WorkspaceDriver = { id: "workspace", async createCandidate() { return candidate; }, async acceptCandidate() { return { changed: false }; }, async discardCandidate() {} };
  const agent: AgentDriver = { id: "agent", async run() { return { summary: "unused" }; }, async finalize(request) { finalizes += 1; assert.equal(request.accepted, true); assert.equal(request.reason, "candidate-accepted-no-change"); } };
  try {
    await appendRecoveryPhase(journal, campaign, candidate.id, "reserved", { startedAt: "2026-01-01T00:00:00.000Z" });
    await appendRecoveryPhase(journal, campaign, candidate.id, "candidate-created", { candidate });
    await appendRecoveryPhase(journal, campaign, candidate.id, "acceptance-intent", {
      action: "accept",
      operationId: "op-no-op",
      finalization: { agentId: agent.id, candidate, accepted: true, reason: "candidate-accepted", evaluations: [], result: { summary: "already correct" } }
    });
    const result = await recoverWorkflow(recoveryFixture(journal, campaign, records, agent), workspace);
    assert.equal(result.blocked, undefined);
    assert.equal(finalizes, 1);
    assert.equal(records[0]?.status, "keep");
    assert.equal(records[0]?.revision, candidate.baseRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery retains meaningful pre-decision work for a bounded resume", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "workflow-recovery-predecision-"));
  const journal = new WorkflowJournal(resolve(root, "journal.jsonl"));
  const campaign: Campaign = { apiVersion: "gamefactory.dev/v1", id: "recovery-predecision", objective: "recover", projectRoot: root, workflow: "test", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } };
  const candidate: Candidate = { id: "exp-3", root: resolve(root, "candidate"), metadata: {} };
  const records: ExperimentRecord[] = [];
  let discards = 0;
  const workspace: WorkspaceDriver = { id: "workspace", async createCandidate() { return candidate; }, async acceptCandidate() { return { changed: true }; }, async discardCandidate() { discards += 1; } };
  const agent: AgentDriver = { id: "agent", async run() { return { summary: "unused" }; } };
  try {
    await appendRecoveryPhase(journal, campaign, "exp-3", "reserved", { startedAt: "2026-01-01T00:00:00.000Z", slot: 2 });
    await appendRecoveryPhase(journal, campaign, "exp-3", "candidate-created", { candidate });
    await appendRecoveryPhase(journal, campaign, "exp-3", "agent-finished", { summary: "expensive work completed" });
    const result = await recoverWorkflow(recoveryFixture(journal, campaign, records, agent), workspace);
    assert.equal(result.blocked, undefined);
    assert.equal(discards, 0);
    assert.equal(result.resumableCandidates.length, 1);
    assert.equal(result.resumableCandidates[0]?.candidate.root, candidate.root);
    assert.equal(result.resumableCandidates[0]?.reserved.slot, 2);
    assert.equal((await journal.recover()).incomplete[0]?.latestPhase, "agent-finished");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
