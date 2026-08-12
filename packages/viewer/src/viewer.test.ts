import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  JsonlResultStore,
  JsonlTraceStore,
  WorkflowJournal,
  type Campaign,
  type ExperimentRecord,
  type FactoryConfig,
  type JournalJsonValue
} from "@gamefactory/core";
import { createFactorySnapshot, readFactoryTrace, startFactoryViewer, type FactoryViewerOptions } from "./index.js";

const runId = "viewer-demo-aabbccdd";
const campaign: Campaign = {
  apiVersion: "gamefactory.dev/v1",
  id: "viewer-demo",
  objective: "Find the clearest version of a tiny puzzle loop",
  projectRoot: ".",
  workflow: "tournament",
  requires: [],
  acceptance: { primaryMetric: "clarity", direction: "maximize" }
};
const config: FactoryConfig = {
  apiVersion: "gamefactory.dev/v1",
  extensions: [],
  journalLog: ".factory/journal/demo.jsonl",
  resultLog: ".factory/results/demo.jsonl",
  artifactDirectory: ".factory/artifacts",
  traceLog: ".factory/traces/demo.jsonl"
};
const fingerprints = { campaign: "campaign", config: "config", project: "project" };

async function fixture(): Promise<{ root: string; options: FactoryViewerOptions; journal: WorkflowJournal; record: ExperimentRecord; artifact: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-viewer-"));
  const options = { cwd: root, campaign: { ...campaign, projectRoot: root }, config, pollIntervalMs: 50 };
  const journal = new WorkflowJournal(resolve(root, ".factory/journal/demo.jsonl"));
  const artifact = resolve(root, ".factory/artifacts/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt");
  await mkdir(resolve(root, ".factory/artifacts/aa"), { recursive: true });
  await writeFile(artifact, "preserved evidence", "utf8");
  const append = (phase: Parameters<WorkflowJournal["append"]>[0]["phase"], data?: Parameters<WorkflowJournal["append"]>[0]["data"]) => journal.append({
    runId,
    campaignId: campaign.id,
    experimentId: "tournament-r0001-c001",
    phase,
    idempotencyKey: `${runId}:${phase}`,
    fingerprints,
    ...(data === undefined ? {} : { data })
  });
  await append("reserved", { round: 1, slot: 1 });
  await append("candidate-created", { candidate: { id: "candidate-1", root, metadata: {} } });
  await append("agent-finished", { summary: "Tightened the first puzzle hint." });
  await append("evaluated", { evaluations: [{ evaluator: "playtest.agents", status: "pass" }] });
  await append("evidence-preserved");
  await append("acceptance-intent", { action: "accept" });
  const record: ExperimentRecord = {
    campaignId: campaign.id,
    runId,
    experimentId: "tournament-r0001-c001",
    candidateId: "candidate-1",
    startedAt: "2026-08-12T12:00:00.000Z",
    finishedAt: "2026-08-12T12:00:03.000Z",
    status: "keep",
    summary: "The opening puzzle now teaches itself.",
    metrics: { clarity: 0.91 },
    evaluations: [{
      evaluator: "playtest.agents",
      version: "1",
      status: "pass",
      metrics: { clarity: 0.91 },
      violations: [],
      artifacts: [{ kind: "log", path: artifact, mediaType: "text/plain", label: "Playtest notes", sha256: "a".repeat(64), metadata: { sizeBytes: 18 } }],
      summary: "Players solved it without prompting."
    }],
    agent: {
      summary: "Implemented the selected hint treatment.",
      artifacts: [],
      contributors: [{
        agentId: "puzzle-critic",
        role: "critic",
        status: "complete",
        startedAt: "2026-08-12T12:00:00.500Z",
        finishedAt: "2026-08-12T12:00:01.500Z",
        summary: "Found one ambiguous affordance.",
        artifacts: [],
        invocationId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1",
        parentInvocationId: "agent-node:tournament-r0001-c001:puzzle-critic",
        usage: { provider: "openai", model: "test-model", inputTokens: 100, outputTokens: 25, costUsd: 0.01, costSource: "provider-reported", billingMode: "metered", identitySource: "provider-reported" }
      }]
    },
    metadata: { tournament: { round: 1, slot: 1, winner: true } }
  };
  await append("applied", JSON.parse(JSON.stringify({ record })) as JournalJsonValue);
  await new JsonlResultStore(resolve(root, ".factory/results/demo.jsonl")).append(record);
  await append("recorded", { status: "keep" });
  await append("cleaned");
  await writeFile(`${journal.path}.lock`, `${JSON.stringify({ runId })}\n`, "utf8");
  return { root, options, journal, record, artifact };
}

test("viewer reconstructs candidate lanes, provenance, metrics, and live state", async () => {
  const value = await fixture();
  try {
    const trace = await readFactoryTrace(value.options);
    const snapshot = createFactorySnapshot(trace, value.options.campaign);
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.live, true);
    assert.equal(snapshot.sequence, 9);
    assert.equal(snapshot.counters.kept, 1);
    assert.equal(snapshot.experiments[0]?.round, 1);
    assert.equal(snapshot.experiments[0]?.slot, 1);
    assert.equal(snapshot.experiments[0]?.primaryMetric, 0.91);
    assert.equal(snapshot.experiments[0]?.contributors[0]?.role, "critic");
    assert.equal(snapshot.experiments[0]?.evaluations[0]?.evaluator, "playtest.agents");
    assert.equal(snapshot.experiments[0]?.artifacts[0]?.available, true);
    assert.match(snapshot.events.find((event) => event.phase === "acceptance-intent")?.note ?? "", /Accept/);
    assert.deepEqual(
      [...new Set(snapshot.graph.nodes.map((node) => node.kind))].sort(),
      ["agent", "campaign", "candidate", "contributor", "decision", "evaluator", "outcome", "workspace"]
    );
    assert.equal(snapshot.graph.clusters[0]?.nodeIds.length, 7);
    assert.equal(snapshot.graph.nodes.find((node) => node.kind === "workspace")?.enteredSequence, 2);
    assert.equal(snapshot.graph.nodes.find((node) => node.kind === "agent")?.completedSequence, 3);
    assert.equal(snapshot.graph.nodes.find((node) => node.kind === "evaluator")?.completedSequence, 4);
    assert.equal(snapshot.graph.nodes.find((node) => node.kind === "decision")?.completedSequence, 6);
    assert.equal(snapshot.graph.nodes.find((node) => node.kind === "outcome")?.completedSequence, 9);
    assert.ok(snapshot.graph.edges.some((edge) => edge.kind === "evidence"));
    assert.equal(snapshot.usage.invocations, 1);
    assert.equal(snapshot.usage.totalTokens, 125);
    assert.equal(snapshot.usage.costUsd, 0.01);
    assert.deepEqual(snapshot.usage.billingModes, ["metered"]);
    assert.equal(snapshot.usage.models[0]?.model, "test-model");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("viewer merges live agent attempts and progress into the replayable graph", async () => {
  const value = await fixture();
  try {
    const store = new JsonlTraceStore(resolve(value.root, ".factory/traces/demo.jsonl"));
    const identity = { runId, campaignId: campaign.id };
    await store.append(identity, { type: "node:created", nodeId: "agent-team:tournament-r0001-c001", experimentId: "tournament-r0001-c001", parentNodeId: "experiment:tournament-r0001-c001", label: "Agent team", role: "agent-team" });
    await store.append(identity, { type: "node:started", nodeId: "agent-team:tournament-r0001-c001", experimentId: "tournament-r0001-c001", label: "Agent team", role: "agent-team" });
    await store.append(identity, { type: "node:created", nodeId: "agent-node:tournament-r0001-c001:puzzle-critic", experimentId: "tournament-r0001-c001", parentNodeId: "agent-team:tournament-r0001-c001", label: "puzzle-critic", role: "critic" });
    await store.append(identity, { type: "node:created", nodeId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", experimentId: "tournament-r0001-c001", parentNodeId: "agent-node:tournament-r0001-c001:puzzle-critic", label: "puzzle-critic", role: "critic", attempt: 1, data: { invocationId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", parentInvocationId: "agent-node:tournament-r0001-c001:puzzle-critic", provider: "openai", model: "test-model" } });
    await store.append(identity, { type: "edge:created", nodeId: "edge:critic-attempt", experimentId: "tournament-r0001-c001", sourceNodeId: "agent-node:tournament-r0001-c001:puzzle-critic", targetNodeId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", role: "agent" });
    await store.append(identity, { type: "node:started", nodeId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", experimentId: "tournament-r0001-c001", label: "puzzle-critic", role: "critic", attempt: 1 });
    await store.append(identity, { type: "node:progress", nodeId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", experimentId: "tournament-r0001-c001", label: "puzzle-critic", role: "critic", attempt: 1, message: "Subprocess output", progress: { current: 2048, unit: "bytes" } });
    await store.append(identity, { type: "node:completed", nodeId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", experimentId: "tournament-r0001-c001", label: "puzzle-critic", role: "critic", attempt: 1, status: "complete", message: "Critique finished", data: { invocationId: "agent:tournament-r0001-c001:puzzle-critic:attempt-1", parentInvocationId: "agent-node:tournament-r0001-c001:puzzle-critic", usage: { provider: "openai", model: "test-model", inputTokens: 120, outputTokens: 30, costUsd: 0.02, costSource: "provider-reported", billingMode: "metered", identitySource: "provider-reported" } } });
    const snapshot = createFactorySnapshot(await readFactoryTrace(value.options), value.options.campaign);
    assert.ok(snapshot.events.some((event) => event.source === "trace" && event.phase === "node:progress"));
    const attempt = snapshot.graph.nodes.find((node) => node.id === "agent:tournament-r0001-c001:puzzle-critic:attempt-1");
    assert.equal(attempt?.kind, "contributor");
    assert.equal(attempt?.finalState, "complete");
    assert.ok((attempt?.completedSequence ?? 0) > (attempt?.enteredSequence ?? 0));
    assert.ok(snapshot.graph.edges.some((edge) => edge.target === attempt?.id));
    assert.equal(attempt?.usage?.model, "test-model");
    assert.equal(snapshot.usage.invocations, 1);
    assert.equal(snapshot.usage.totalTokens, 150);
    assert.equal(snapshot.usage.costUsd, 0.02);
    assert.deepEqual(snapshot.usage.billingModes, ["metered"]);
    assert.ok(snapshot.sequence > 9);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("viewer server serves the dashboard and only contained preserved artifacts", async () => {
  const value = await fixture();
  const server = await startFactoryViewer({ ...value.options, port: 0, host: "127.0.0.1" });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /GameFactory Flight Recorder/);
    assert.match(pageHtml, /Factory graph/);
    assert.match(pageHtml, /Model usage/);

    const response = await fetch(`${server.url}/api/snapshot`);
    const snapshot = await response.json() as ReturnType<typeof server.snapshot>;
    assert.equal(snapshot.runId, runId);
    assert.equal(snapshot.live, true);

    const artifactUrl = snapshot.experiments[0]?.artifacts[0]?.url;
    assert.ok(artifactUrl);
    const artifact = await fetch(`${server.url}${artifactUrl}`);
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), "preserved evidence");

    const escape = await fetch(`${server.url}/artifacts/not-a-content-address`);
    assert.equal(escape.status, 404);
  } finally {
    await server.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
