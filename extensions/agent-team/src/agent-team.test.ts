import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InfrastructureFailureError, type AgentDriver, type AgentResult, type Campaign, type FactoryTraceEventInput } from "@gamefactory/core";
import { AgentTeam, AgentTeamExecutionError, AgentTeamInfrastructureError, AgentTeamInvalidatedError, validateAgentTeamConfiguration } from "./index.js";

const exec = promisify(execFile);

const fixtureSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
assert.equal(process.env.GAMEFACTORY_STAGE, request.stage);
assert.equal(process.env.GAMEFACTORY_CONTRIBUTOR, request.contributorId);
const timingRoot = dirname(process.env.GAMEFACTORY_REQUEST);
await mkdir(timingRoot, { recursive: true });
const started = Date.now();
if (request.stage === "scout") {
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (request.contributorId === "rogue") await writeFile("value.txt", "unauthorized\\n", "utf8");
  console.log("finding from " + request.contributorId);
} else if (request.stage === "planner") {
  assert.ok(request.inputs.length >= 1);
  assert.ok(request.inputs.every((input) => input.stage === "scout"));
  console.log("bounded implementation plan");
} else if (request.stage === "implementer") {
  assert.ok(request.inputs.some((input) => input.stage === "planner"));
  await writeFile("value.txt", "implemented\\n", "utf8");
  console.log("implementation complete");
} else if (request.stage === "critic") {
  assert.equal(await readFile("value.txt", "utf8"), "implemented\\n");
  assert.ok(request.inputs.some((input) => input.stage === "implementer"));
  if (request.contributorId === "rogue-critic") await writeFile("value.txt", "critic mutation\\n", "utf8");
  if (request.contributorId === "rogue-factory-critic") { await mkdir(".factory/verdicts", { recursive: true }); await writeFile(".factory/verdicts/approved.json", "{}", "utf8"); }
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log("review from " + request.contributorId);
}
const finished = Date.now();
await writeFile(resolve(timingRoot, "timing.json"), JSON.stringify({ started, finished }), "utf8");
`;

const graphFixtureSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
assert.equal(process.env.GAMEFACTORY_NODE, request.nodeId);
assert.equal(Number(process.env.GAMEFACTORY_ATTEMPT), request.attempt);
const timingRoot = dirname(process.env.GAMEFACTORY_REQUEST);
await mkdir(timingRoot, { recursive: true });
const started = Date.now();
if (["alpha", "beta", "large-alpha", "large-beta"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({
    summary: request.nodeId + " complete",
    outcome: "pass",
    context: { source: request.nodeId, ...(request.nodeId.startsWith("large-") ? { blob: "x".repeat(4000) } : {}) },
    usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.01, costSource: "provider-reported" },
    artifacts: [{ kind: "other", path: "value.txt", label: request.nodeId + " evidence" }]
  }));
} else if (request.nodeId === "join") {
  assert.deepEqual(request.inputs.map((input) => input.nodeId).sort(), ["alpha", "beta"]);
  assert.ok(request.inputs.every((input) => input.structured.context.source === input.nodeId));
  assert.ok(request.inputs.every((input) => input.artifacts[0].path.endsWith("value.txt")));
  assert.ok(request.inputs.every((input) => input.output === ""), "structured handoffs should not duplicate raw stdout");
  console.log(JSON.stringify({ summary: "joined structured findings", outcome: "pass", projectEvidence: { scenarios: [], targetSha256: "a".repeat(64) } }));
} else if (request.nodeId === "large-join") {
  assert.deepEqual(request.inputs.map((input) => input.nodeId).sort(), ["large-alpha", "large-beta"]);
  assert.ok(request.inputs.every((input) => input.structured.context.handoffTruncated === true));
  assert.ok(JSON.stringify(request.inputs).length < 3000, "combined handoff must remain globally bounded");
  console.log(JSON.stringify({ summary: "bounded large handoffs", outcome: "pass" }));
} else if (request.nodeId === "discover") {
  console.log("human-readable prelude");
  console.log(JSON.stringify({ summary: "found hypothesis", outcome: "ready", context: { hypothesis: "raise-value" } }));
} else if (request.nodeId === "builder") {
  const discovery = request.inputs.find((input) => input.nodeId === "discover");
  assert.equal(discovery.structured.context.hypothesis, "raise-value");
  const repairing = request.reason.kind === "repair";
  if (repairing) {
    const review = request.inputs.find((input) => ["reviewer", "alias-reviewer", "requested-alias-reviewer", "needs-work-reviewer", "rejected-reviewer", "visual-reviewer", "checkpoint-reviewer"].includes(input.nodeId));
    assert.ok(["revise", "revision_required", "revision_requested", "needs-work", "rejected"].includes(review.structured.outcome));
  }
  await writeFile("value.txt", repairing ? "repaired\\n" : "implemented\\n", "utf8");
  console.log(JSON.stringify({ summary: repairing ? "repair complete" : "implementation complete", outcome: "complete" }));
  } else if (["reviewer", "alias-reviewer", "requested-alias-reviewer", "needs-work-reviewer", "rejected-reviewer"].includes(request.nodeId)) {
  const value = await readFile("value.txt", "utf8");
    const reportedOutcome = request.nodeId === "alias-reviewer"
      ? "revision_required"
      : request.nodeId === "requested-alias-reviewer"
        ? "revision_requested"
        : request.nodeId === "needs-work-reviewer"
          ? "needs-work"
          : request.nodeId === "rejected-reviewer"
            ? "rejected"
            : "revise";
    console.log(JSON.stringify(value === "repaired\\n"
      ? { summary: "review passed", outcome: "pass" }
      : { summary: "needs repair", outcome: reportedOutcome, findings: [{ issue: "value is not repaired" }] }));
} else if (request.nodeId === "frozen-contract") {
  const value = await readFile("value.txt", "utf8");
  console.log(JSON.stringify(value === "implemented\\n"
    ? { summary: "contract passed", outcome: "pass" }
    : { summary: "contract regressed", outcome: "revise" }));
} else if (["nested-blocker-reviewer", "nested-unknown-blocker-reviewer"].includes(request.nodeId)) {
  console.log(JSON.stringify({
    summary: "scene direction requires another production step",
    outcome: "revise",
    findings: {
      blockers: [{
        classification: "blocker",
        claimIds: [request.nodeId === "nested-unknown-blocker-reviewer" ? "scope.unknown" : "loop.first-errand"],
        finding: "The current scene does not yet prove the accepted visual-comprehension claim."
      }],
      opportunities: [{ classification: "opportunity", finding: "Explore a second coherent direction." }]
    }
  }));
} else if (request.nodeId === "positive-advisory") {
  console.log(JSON.stringify({ summary: "no accepted claim is falsified", outcome: "positive", findings: [{ findingClass: "opportunity", issue: "consider a later polish pass" }] }));
} else if (request.nodeId === "delegated-builder") {
  assert.match(request.instructions, /Authoritative host-driver boundary/);
  assert.ok(request.instructions.includes("host-evidence (fixture.host-evidence)"));
  assert.match(request.instructions, /return complete/);
  await writeFile("value.txt", "delegated implementation complete\\n", "utf8");
  console.log(JSON.stringify({ summary: "implementation complete; host verification pending", outcome: "complete" }));
} else if (["contract-retry-reviewer", "contract-exhausted-reviewer"].includes(request.nodeId)) {
  if (request.attempt > 1) {
    const rejected = request.inputs.find((input) => input.nodeId === request.nodeId);
    assert.match(rejected.summary, /OUTPUT CONTRACT REJECTED/);
  }
  console.log(JSON.stringify(request.nodeId === "contract-retry-reviewer" && request.attempt > 1
    ? { summary: "review contract repaired", outcome: "pass", findings: [] }
    : { summary: "visual concern without claim attribution", outcome: "revise", findings: [{ findingClass: "opportunity", issue: "consider more polish" }] }));
} else if (request.nodeId === "checkpoint-reviewer") {
  const value = await readFile("value.txt", "utf8");
  console.log(JSON.stringify(value === "repaired\\n"
    ? { summary: "repaired checkpoint accepted", outcome: "pass", findings: [] }
    : { summary: "checkpoint invalidated", outcome: "revise", findings: [{ findingClass: "blocker", claimIds: ["loop.first-errand"], issue: "value is not repaired", evidence: ["value.txt"], diagnosticBlob: "x".repeat(4000) }] }));
} else if (request.nodeId === "nested-plan-consumer") {
  const plan = request.inputs.find((input) => input.nodeId === "nested-blocker-reviewer");
  assert.equal(plan.structured.outcome, "revise");
  assert.equal(plan.structured.findings.blockers[0].claimIds[0], "loop.first-errand");
  await writeFile("writer-a.txt", "consumed nested planning handoff\\n", "utf8");
  console.log(JSON.stringify({ summary: "nested planning handoff consumed", outcome: "complete" }));
} else if (request.nodeId === "capture") {
  const value = await readFile("value.txt", "utf8");
  const capturePath = ".factory/capture-" + request.attempt + ".txt";
  await writeFile(capturePath, value, "utf8");
  console.log(JSON.stringify({
    summary: "captured " + value.trim(),
    outcome: "captured",
    context: { value: value.trim() },
    artifacts: [{ kind: "image", path: capturePath, mediaType: "text/plain", label: "derived capture" }]
  }));
} else if (request.nodeId === "visual-reviewer") {
  const capture = request.inputs.find((input) => input.nodeId === "capture");
  const current = await readFile(capture.artifacts[0].path, "utf8");
  console.log(JSON.stringify(current === "repaired\\n"
    ? { summary: "fresh visual evidence passed", outcome: "pass" }
    : { summary: "visual evidence needs repair", outcome: "revise", findings: { captured: current.trim() } }));
} else if (request.nodeId === "conditional") {
  assert.equal(request.inputs[0].outcome, "pass");
  console.log(JSON.stringify({ summary: "conditional branch ran", outcome: "complete" }));
} else if (request.nodeId === "blocked-reviewer") {
  console.log(JSON.stringify({
    summary: "runtime evidence is missing",
    outcome: "blocked_missing_runtime_evidence",
    findings: [{ issue: "no engine capture was supplied" }]
  }));
} else if (["target-owner-reviewer", "spec-owner-reviewer"].includes(request.nodeId)) {
  const owner = request.nodeId === "target-owner-reviewer" ? "target" : "spec";
  console.log(JSON.stringify({
    summary: owner + " contract must be revised outside implementation",
    outcome: owner === "target" ? "target_revision" : "spec_amendment",
    findings: [{ findingClass: "blocker", claimIds: ["loop.first-errand"], owner, issue: "the controlling contract is incoherent", evidence: ["value.txt"] }]
  }));
} else if (request.nodeId === "downstream") {
  assert.equal(await readFile("value.txt", "utf8"), "repaired\\n", "downstream must not run against work rejected by its gate");
  const review = request.inputs.find((input) => input.nodeId === "reviewer");
  assert.equal(review.structured.outcome, "pass");
  await writeFile("downstream.txt", "consumed repaired work\\n", "utf8");
  console.log(JSON.stringify({ summary: "downstream consumed repaired work", outcome: "complete" }));
} else if (["advisor-scout", "advisor-failure"].includes(request.nodeId)) {
  if (request.contributorId === request.nodeId) {
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.reasoningEffort, "high");
    if (request.nodeId === "advisor-failure") {
      console.error("primary scout failed before resolving the evidence");
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify({ summary: "partial Luna exploration", outcome: "needs_advisor", findings: { evidence: ["value.txt"], remainingGap: "requires frontier synthesis" } }));
    }
  } else {
    assert.equal(request.contributorId, request.nodeId + "-advisor");
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.reasoningEffort, "high");
    assert.equal(request.reason.kind, "advisor");
    const primary = request.inputs.find((input) => input.contributorId === request.nodeId);
    assert.ok(primary);
    if (request.nodeId === "advisor-scout") assert.equal(primary.structured.findings.remainingGap, "requires frontier synthesis");
    if (request.nodeId === "advisor-failure") assert.match(primary.output + " " + primary.summary, /failed|scout/i);
    console.log(JSON.stringify({ summary: "Sol advisor resolved the gap", outcome: "pass", findings: { inheritedEvidence: true } }));
  }
} else if (["writer-a", "writer-b", "writer-c"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(request.nodeId + ".txt", (process.argv[2] ?? "written") + "\\n", "utf8");
  console.log(JSON.stringify({ summary: request.nodeId + " complete", outcome: "complete" }));
} else {
  throw new Error("unknown graph fixture node " + request.nodeId);
}
const finished = Date.now();
await writeFile(resolve(timingRoot, "timing.json"), JSON.stringify({ started, finished }), "utf8");
`;

const appServerFixtureSource = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "thread/start") {
    if (message.params.sandbox !== "read-only") return send({ id: message.id, error: { message: "wrong legacy sandbox value" } });
    if (message.params.model === undefined) return send({ id: message.id, result: { thread: { id: "thread-root", modelProvider: "openai" }, modelProvider: "openai", instructionSources: [message.params.cwd + "/AGENTS.md"] } });
    if (message.params.model !== "gpt-5.6-luna" || message.params.reasoningEffort !== undefined) return send({ id: message.id, error: { message: "wrong thread routing fields" } });
    return send({
    id: message.id,
    result: { thread: { id: "thread-real-adapter", modelProvider: "openai" }, model: message.params.model, modelProvider: "openai", reasoningEffort: message.params.reasoningEffort, instructionSources: [message.params.cwd + "/AGENTS.md"] }
    });
  }
  if (message.method === "thread/fork") return send({ id: message.id, result: { thread: { id: "thread-real-adapter", modelProvider: "openai", ephemeral: true }, modelProvider: "openai" } });
  if (message.method === "thread/unsubscribe") return send({ id: message.id, result: { status: "unsubscribed" } });
  if (message.method === "thread/delete" || message.method === "thread/archive") return send({ id: message.id, result: {} });
  if (message.method === "thread/loaded/list") return send({ id: message.id, result: { data: ["thread-root"] } });
  if (message.method !== "turn/start") return;
  if (message.params.model !== "gpt-5.6-luna" || message.params.effort !== "high" || message.params.reasoningEffort !== undefined) return send({ id: message.id, error: { message: "turn lost per-node routing" } });
  const threadId = message.params.threadId;
  const turnId = "turn-real-adapter";
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
  send({ method: "thread/settings/updated", params: { threadId, threadSettings: { model: message.params.model, effort: message.params.effort } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
  for (let index = 0; index < 200; index += 1) send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "x" } });
  send({ method: "item/started", params: { threadId, turnId, item: { id: "cmd-1", type: "commandExecution", status: "inProgress" } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "cmd-1", type: "commandExecution", status: "completed" } } });
  send({ method: "item/started", params: { threadId, turnId, item: { id: "collab-1", type: "collabToolCall", tool: "spawn_agent", status: "inProgress", newThreadId: "thread-subagent" } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "collab-1", type: "collabToolCall", tool: "spawn_agent", status: "completed", newThreadId: "thread-subagent" } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "msg-1", type: "agentMessage", text: JSON.stringify({ summary: "App Server worker finished", outcome: "pass", payload: JSON.stringify({ context: { source: "app-server-fixture" } }) }) } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
});
`;

function command(id: string): { id: string; command: string[] } {
  return { id, command: [process.execPath, "team-fixture.mjs"] };
}

function campaign(projectRoot: string, overrides: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "agent-team-contract",
    objective: "implement the selected change",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["value.txt"],
    acceptance: { primaryMetric: "score", direction: "maximize" },
    parameters: {
      agentTeam: {
        scouts: [command("systems"), command("gameplay")],
        planner: command("lead"),
        implementer: command("builder"),
        critics: [command("safety"), command("quality")],
        ...overrides
      }
    }
  };
}

function graphCampaign(projectRoot: string, nodes: Record<string, unknown>[], graphOverrides: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "agent-team-graph-contract",
    objective: "coordinate a bounded graph",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["value.txt", "writer-a.txt", "writer-b.txt", "writer-c.txt"],
    acceptance: { primaryMetric: "score", direction: "maximize" },
    parameters: {
      agentTeam: {
        maximumParallel: 4,
        maxOutputCharacters: 20_000,
        graph: { nodes, ...graphOverrides }
      }
    }
  };
}

function graphCommand(id: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, command: [process.execPath, "graph-fixture.mjs"], ...options };
}

async function acceptTeamCheckpoints(team: AgentTeam, campaign: Campaign, root: string, experimentId: string, result: AgentResult, dataRoot: string): Promise<void> {
  await team.finalize({
    campaign,
    candidate: { id: experimentId, root, metadata: {} },
    experimentId,
    history: [],
    runtime: { dataRoot },
    signal: new AbortController().signal,
    result,
    evaluations: [{ evaluator: "fixture.final", version: "1", status: "pass", metrics: {}, violations: [], artifacts: [] }],
    accepted: true,
    reason: "test-accepted"
  });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-team-"));
  await writeFile(resolve(root, "team-fixture.mjs"), fixtureSource, "utf8");
  await writeFile(resolve(root, "graph-fixture.mjs"), graphFixtureSource, "utf8");
  await writeFile(resolve(root, "app-server-fixture.mjs"), appServerFixtureSource, "utf8");
  await writeFile(resolve(root, "value.txt"), "baseline\n", "utf8");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "--all"], { cwd: root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function timing(root: string, ...parts: string[]): Promise<{ started: number; finished: number }> {
  return JSON.parse(await readFile(resolve(root, ".factory", "agent-team", ...parts, "timing.json"), "utf8")) as { started: number; finished: number };
}

test("agent team runs parallel read-only stages around a single writer and returns provenance", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-1",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "implemented\n");
    assert.match(result.summary, /implementation complete/);
    assert.equal(result.artifacts?.length, 24);
    assert.deepEqual(result.contributors?.map(({ agentId, role }) => [agentId, role]), [
      ["systems", "scout"],
      ["gameplay", "scout"],
      ["lead", "planner"],
      ["builder", "implementer"],
      ["safety", "critic"],
      ["quality", "critic"]
    ]);
    assert.ok(result.contributors?.every((item) => item.status === "complete" && item.artifacts.length === 4));
    assert.ok(result.contributors?.every((item) => item.metadata?.promptManifest));
    const metadata = result.metadata as { pipeline: string; stages: { scouts: string[]; critics: string[] } };
    assert.equal(metadata.pipeline, "agent.team");
    assert.equal(metadata.stages.scouts.length + metadata.stages.critics.length, 4);

    const systems = await timing(root, "exp-1", "scout", "systems");
    const gameplay = await timing(root, "exp-1", "scout", "gameplay");
    assert.ok(Math.max(systems.started, gameplay.started) < Math.min(systems.finished, gameplay.finished), "scouts should overlap");
    const safety = await timing(root, "exp-1", "critic", "safety");
    const quality = await timing(root, "exp-1", "critic", "quality");
    assert.ok(Math.max(safety.started, quality.started) < Math.min(safety.finished, quality.finished), "critics should overlap");

    const plannerRequest = JSON.parse(await readFile(resolve(root, ".factory", "agent-team", "exp-1", "planner", "lead", "request.json"), "utf8")) as { inputs: Array<{ output: string }>; effectivePromptManifestPath: string };
    assert.equal(plannerRequest.inputs.length, 2);
    assert.ok(plannerRequest.inputs.every((input) => input.output.includes("finding from")));
    const plannerManifest = JSON.parse(await readFile(plannerRequest.effectivePromptManifestPath, "utf8")) as { layers: Array<{ kind: string }> };
    assert.ok(plannerManifest.layers.some((layer) => layer.kind === "role"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team rejects a read-only contributor that changes a meaningful file", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: campaign(root, { scouts: [command("rogue")] }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-rogue",
      history: [],
      signal: new AbortController().signal
    }), /read-only scout stage modified meaningful candidate files/);
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "unauthorized\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team detects a critic changing a file that was already dirty", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: campaign(root, { critics: [command("rogue-critic")] }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-rogue-critic",
      history: [],
      signal: new AbortController().signal
    }), /read-only critic stage modified meaningful candidate files/);
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "critic mutation\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team snapshots a large dirty binary without materializing its Git patch", async () => {
  const root = await repository();
  try {
    await writeFile(resolve(root, "large.bin"), randomBytes(5 * 1024 * 1024));
    await exec("git", ["add", "large.bin"], { cwd: root });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "large binary"], { cwd: root });
    await writeFile(resolve(root, "large.bin"), randomBytes(5 * 1024 * 1024));

    const result = await new AgentTeam().run({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-large-binary",
      history: [],
      signal: new AbortController().signal
    });

    assert.match(result.summary, /implementation complete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team rejects a read-only critic that forges factory verdicts", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: campaign(root, { critics: [command("rogue-factory-critic")] }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-rogue-factory",
      history: [],
      signal: new AbortController().signal
    }), /read-only critic stage modified meaningful candidate files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent team validates contributor identities before launching commands", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: campaign(root, { planner: { id: "../escape", command: [process.execPath, "team-fixture.mjs"] } }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-invalid",
      history: [],
      signal: new AbortController().signal
    }), /planner.id must use only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team rejects unsupported per-node reasoning effort before launching commands", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("alpha", { reasoningEffort: "ultra" })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-invalid-effort",
      history: [],
      signal: new AbortController().signal
    }), /reasoningEffort must be none, low, medium, high, xhigh, or max/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team validates configurable per-node timeout bounds before launching commands", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("alpha", { timeoutSeconds: 0 })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-invalid-timeout",
      history: [],
      signal: new AbortController().signal
    }), /timeoutSeconds must be a positive number/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph rejects node authority that exceeds filesystem permission", () => {
  assert.throws(() => validateAgentTeamConfiguration(graphCampaign(".", [
    graphCommand("writer-a", { role: "implementer", permissions: "write", authority: "observe" })
  ])), /authority observe conflicts with write permission/);
});

test("explicit reviewer authority requires blockers to cite contract claims", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", { role: "critic", permissions: "read", authority: "propose", dependsOn: ["builder"] })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-claimed-blocker", history: [], signal: new AbortController().signal
    }), /without a blocker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit reviewer authority accepts claim-linked nested blocker findings", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("nested-blocker-reviewer", { role: "planner", permissions: "read", authority: "propose", required: false }),
        graphCommand("nested-plan-consumer", {
          role: "implementer",
          permissions: "write",
          dependsOn: ["nested-blocker-reviewer"],
          when: { node: "nested-blocker-reviewer", outcomes: ["revise"] }
        })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-nested-claimed-blocker", history: [], signal: new AbortController().signal
    });
    assert.match(result.summary, /nested planning handoff consumed/);
    assert.equal(await readFile(resolve(root, "writer-a.txt"), "utf8"), "consumed nested planning handoff\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("advisory proposal rejection feeds a required downstream node without becoming a gate", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("nested-blocker-reviewer", { role: "planner", permissions: "read", authority: "propose", advisory: true }),
        graphCommand("nested-plan-consumer", {
          role: "implementer",
          permissions: "write",
          dependsOn: ["nested-blocker-reviewer"]
        })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-advisory-blocker", history: [], signal: new AbortController().signal
    });
    assert.match(result.summary, /nested planning handoff consumed/);
    const node = (result.metadata as { nodes: Record<string, { advisory?: boolean; outcome: string }> }).nodes["nested-blocker-reviewer"];
    assert.equal(node?.advisory, true);
    assert.equal(node?.outcome, "revise");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("advisory positive aliases normalize to pass without invalidating downstream work", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("positive-advisory", { role: "planner", permissions: "read", authority: "propose", advisory: true }),
        graphCommand("writer-a", { role: "implementer", permissions: "write", dependsOn: ["positive-advisory"] })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-positive-advisory", history: [], signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "writer-a.txt"), "utf8"), "written\n");
    const metadata = result.metadata as { nodes: Record<string, { outcome: string }> };
    assert.equal(metadata.nodes["positive-advisory"]?.outcome, "pass");
    const contribution = result.contributors?.find((item) => item.agentId === "positive-advisory");
    assert.equal(contribution?.metadata?.outcome, "pass");
    assert.equal(contribution?.metadata?.reportedOutcome, "positive");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("writer prompts delegate host-only verification to direct downstream agent drivers", async () => {
  const root = await repository();
  const driver: AgentDriver = {
    id: "fixture.host-evidence",
    async run() {
      assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "delegated implementation complete\n");
      return { summary: "host evidence passed", artifacts: [], metadata: { outcome: "pass" } };
    }
  };
  try {
    const result = await new AgentTeam(() => driver).run({
      campaign: graphCampaign(root, [
        graphCommand("delegated-builder", { role: "implementer", permissions: "write" }),
        { id: "host-evidence", adapter: "agent-driver", driver: driver.id, role: "worker", permissions: "read", dependsOn: ["delegated-builder"] }
      ]),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-delegated-host-evidence", history: [], signal: new AbortController().signal
    });
    assert.match(result.summary, /host evidence passed/);
    assert.equal((result.metadata as { nodes: Record<string, { outcome: string }> }).nodes["delegated-builder"]?.outcome, "complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("advisory nodes must be read-only proposal authorities without repair ownership", () => {
  assert.throws(() => validateAgentTeamConfiguration(graphCampaign(".", [
    graphCommand("builder", { role: "implementer", permissions: "write", advisory: true })
  ])), /advisory requires read permission and propose authority/);
  assert.throws(() => validateAgentTeamConfiguration(graphCampaign(".", [
    graphCommand("builder", { role: "implementer", permissions: "write" }),
    graphCommand("reviewer", { role: "critic", permissions: "read", authority: "propose", advisory: true, dependsOn: ["builder"], repair: { target: "builder" } })
  ])), /advisory node reviewer cannot own a repair edge/);
});

test("explicit reviewer authority rejects unknown claims in nested blocker findings", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("nested-unknown-blocker-reviewer", { role: "planner", permissions: "read", authority: "propose" })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-nested-unknown-blocker", history: [], signal: new AbortController().signal
    }), /cites unknown claim\(s\): scope\.unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewer output-contract failures retry locally without rerunning upstream work", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("contract-retry-reviewer", { role: "critic", permissions: "read", authority: "propose", dependsOn: ["builder"] })
      ], { claimIds: ["loop.first-errand"], maximumTotalAttempts: 3 }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-contract-retry", history: [], signal: new AbortController().signal
    });
    const metadata = result.metadata as { executionRetries: number; nodes: Record<string, { attempts: number; outputContractRetries: number }> };
    assert.equal(metadata.nodes.builder?.attempts, 1);
    assert.equal(metadata.nodes["contract-retry-reviewer"]?.attempts, 2);
    assert.equal(metadata.nodes["contract-retry-reviewer"]?.outputContractRetries, 1);
    assert.equal(metadata.executionRetries, 1);
    assert.equal(result.contributors?.filter((item) => item.agentId === "builder").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exhausted reviewer output-contract retries retain upstream work as infrastructure recovery", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("contract-exhausted-reviewer", { role: "critic", permissions: "read", authority: "propose", dependsOn: ["builder"] })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-contract-exhausted", history: [], signal: new AbortController().signal
    }), (error: unknown) => {
      assert.equal((error as { failureClass?: unknown }).failureClass, "infrastructure");
      assert.match((error as Error).message, /without a blocker.*after 1 bounded contract retry/);
      assert.equal((error as AgentTeamExecutionError).runs.filter((run) => run.provenance.contributorId === "builder").length, 1);
      assert.equal((error as AgentTeamExecutionError).runs.filter((run) => run.provenance.contributorId === "contract-exhausted-reviewer").length, 2);
      return true;
    });
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "implemented\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent team rejects unsupported Codex thread retention before launching adapters", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("alpha", { adapter: "codex-app-server", command: [process.execPath, "app-server-fixture.mjs"], threadRetention: "forever" })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-invalid-thread-retention",
      history: [],
      signal: new AbortController().signal
    }), /threadRetention must be ephemeral, archive, or debug/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent team fails closed before launch when a required bound skill is unavailable", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("alpha", { skills: ["missing-gamefactory-skill"] })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-missing-skill",
      history: [],
      signal: new AbortController().signal
    }), /Required skill missing-gamefactory-skill is unavailable/);
    await assert.rejects(() => readFile(resolve(root, ".factory/agent-team/exp-missing-skill/graph/alpha/attempt-1/timing.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph runs independent readers in parallel and honors dependency ordering", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { role: "scout", permissions: "read" }),
        graphCommand("beta", { role: "scout", permissions: "read" }),
        graphCommand("join", { role: "judge", permissions: "read", dependsOn: ["alpha", "beta"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-graph-parallel",
      history: [],
      signal: new AbortController().signal
    });
    assert.match(result.summary, /joined structured findings/);
    const alpha = await timing(root, "exp-graph-parallel", "graph", "alpha", "attempt-1");
    const beta = await timing(root, "exp-graph-parallel", "graph", "beta", "attempt-1");
    const join = await timing(root, "exp-graph-parallel", "graph", "join", "attempt-1");
    assert.ok(Math.max(alpha.started, beta.started) < Math.min(alpha.finished, beta.finished), "independent readers should overlap");
    assert.ok(join.started >= Math.max(alpha.finished, beta.finished), "dependent node should start after both predecessors");
    assert.equal(result.contributors?.length, 3);
    assert.ok(result.contributors?.every((item) => item.artifacts.some((artifact) => artifact.label?.includes("structured output"))));
    const metadata = result.metadata as { mode: string; totalAttempts: number; projectEvidence: { targetSha256: string; writerGenerations: Record<string, number> }; nodes: Record<string, { outcome: string }> };
    assert.equal(metadata.mode, "graph");
    assert.equal(metadata.totalAttempts, 3);
    assert.equal(metadata.nodes.join?.outcome, "pass");
    assert.equal(metadata.projectEvidence.targetSha256, "a".repeat(64));
    assert.deepEqual(metadata.projectEvidence.writerGenerations, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph handoffs share one character and artifact budget across direct dependencies", async () => {
  const root = await repository();
  try {
    const campaign = graphCampaign(root, [
      graphCommand("large-alpha", { role: "scout", permissions: "read" }),
      graphCommand("large-beta", { role: "scout", permissions: "read" }),
      graphCommand("large-join", { role: "judge", permissions: "read", dependsOn: ["large-alpha", "large-beta"] })
    ]);
    campaign.parameters = { ...campaign.parameters, agentTeam: { ...(campaign.parameters!.agentTeam as Record<string, unknown>), handoffCharacters: 512, maximumHandoffArtifacts: 1 } };
    await new AgentTeam().run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-bounded-handoffs",
      history: [],
      signal: new AbortController().signal
    });
    const request = JSON.parse(await readFile(resolve(root, ".factory/agent-team/exp-bounded-handoffs/graph/large-join/attempt-1/request.json"), "utf8")) as { inputs: Array<{ artifacts: unknown[] }> };
    assert.equal(request.inputs.reduce((total, input) => total + input.artifacts.length, 0), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent graph escalates an explicit Luna capability gap to a bounded Sol advisor with preserved evidence", async () => {
  const root = await repository();
  const events: FactoryTraceEventInput[] = [];
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("advisor-scout", {
        role: "scout",
        permissions: "read",
        provider: "openai-codex-app-server",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        billingMode: "subscription",
        advisor: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          outcomes: ["needs_advisor"],
          onFailure: true,
          maximumAttempts: 1
        }
      })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-advisor",
      history: [],
      signal: new AbortController().signal,
      trace: { runId: "run-advisor", campaignId: "agent-team-graph-contract", emit: async (event) => { events.push(event); } }
    });
    assert.match(result.summary, /Sol advisor resolved/);
    assert.deepEqual(result.contributors?.map((item) => [item.agentId, (item.metadata as { reason: { kind: string } }).reason.kind]), [
      ["advisor-scout", "initial"],
      ["advisor-scout-advisor", "advisor"]
    ]);
    assert.equal(result.contributors?.[0]?.usage?.model, "gpt-5.6-luna");
    assert.equal(result.contributors?.[1]?.usage?.model, "gpt-5.6-sol");
    const metadata = result.metadata as { totalAttempts: number; nodes: Record<string, { outcome: string; advisorInvocations: number }> };
    assert.equal(metadata.totalAttempts, 2);
    assert.equal(metadata.nodes["advisor-scout"]?.outcome, "pass");
    assert.equal(metadata.nodes["advisor-scout"]?.advisorInvocations, 1);
    assert.ok(events.some((event) => event.type === "edge:created" && event.role === "advisor"));
    assert.ok(events.some((event) => event.type === "node:progress" && event.message?.includes("Escalating needs_advisor")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph escalates a configured Luna hard failure to Sol", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("advisor-failure", {
        role: "scout",
        permissions: "read",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        advisor: { model: "gpt-5.6-sol", reasoningEffort: "high", onFailure: true }
      })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-advisor-failure",
      history: [],
      signal: new AbortController().signal
    });
    assert.match(result.summary, /Sol advisor resolved/);
    assert.deepEqual(result.contributors?.map((item) => item.status), ["failed", "complete"]);
    assert.deepEqual(result.contributors?.map((item) => (item.metadata as { reason: { kind: string } }).reason.kind), ["initial", "advisor"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor success must satisfy the node required-output contract", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [graphCommand("advisor-scout", {
        role: "scout",
        permissions: "read",
        provider: "openai-codex-app-server",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        billingMode: "subscription",
        requiredOutputFields: ["findings.requiredDecision"],
        advisor: { model: "gpt-5.6-sol", reasoningEffort: "high", outcomes: ["needs_advisor"], maximumAttempts: 1 }
      })]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-advisor-output-contract",
      history: [],
      signal: new AbortController().signal
    }), /missing required fields: findings\.requiredDecision/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph passes structured context to a writer and repairs from critic findings", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read", context: ["value.txt"] }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", {
          role: "critic",
          permissions: "read",
          dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 2 }
        })
      ], { maximumRepairAttempts: 2, maximumTotalAttempts: 12 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-graph-repair",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
    assert.match(result.summary, /repair complete/);
    const metadata = result.metadata as { repairAttempts: number; unresolvedRepairs: string[]; nodes: Record<string, { attempts: number; outcome: string }> };
    assert.equal(metadata.repairAttempts, 1);
    assert.deepEqual(metadata.unresolvedRepairs, []);
    assert.equal(metadata.nodes.builder?.attempts, 2);
    assert.equal(metadata.nodes.reviewer?.attempts, 2);
    const builderContributions = result.contributors?.filter((item) => item.agentId === "builder") ?? [];
    assert.equal(builderContributions.length, 2);
    assert.deepEqual(builderContributions.map((item) => (item.metadata as { reason: { kind: string } }).reason.kind), ["initial", "repair"]);
    const reviewerStructured = ([...(result.contributors ?? [])].reverse().find((item) => item.agentId === "reviewer")?.metadata as { structured?: { outcome?: string; findings?: unknown } }).structured;
    assert.equal(reviewerStructured?.outcome, "pass");
    const repairRequest = JSON.parse(await readFile(resolve(root, ".factory", "agent-team", "exp-graph-repair", "graph", "builder", "attempt-2", "request.json"), "utf8")) as {
      reason: { kind: string };
      inputs: Array<{ nodeId: string; structured: { findings?: unknown } }>;
    };
    assert.equal(repairRequest.reason.kind, "repair");
    assert.ok(repairRequest.inputs.some((input) => input.nodeId === "reviewer" && input.structured.findings));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph fails closed when a required judge requests revision without a repair edge", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", { role: "judge", permissions: "read", dependsOn: ["builder"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-required-revise",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamInvalidatedError);
      assert.equal(error.failureClass, "validation");
      assert.match(error.message, /reviewer: needs repair/);
      assert.ok(error.runs.some((run) => run.provenance.contributorId === "builder"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph repairs a rejected gate before scheduling downstream work", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", {
          role: "critic",
          permissions: "read",
          dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
        }),
        graphCommand("downstream", { role: "implementer", permissions: "write", dependsOn: ["reviewer"] })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 10 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-gate-barrier",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "downstream.txt"), "utf8"), "consumed repaired work\n");
    const order = result.contributors?.map((item) => `${item.agentId}:${(item.metadata as { reason?: { kind?: string } }).reason?.kind}`) ?? [];
    assert.ok(order.indexOf("reviewer:review") < order.indexOf("downstream:initial"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph refreshes derived evidence before reviewing a repaired writer", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("capture", {
          role: "worker",
          permissions: "write",
          dependsOn: ["builder"]
        }),
        graphCommand("visual-reviewer", {
          role: "critic",
          permissions: "read",
          dependsOn: ["builder", "capture"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1 }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 12 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-refresh-evidence",
      history: [],
      signal: new AbortController().signal
    });
    const metadata = result.metadata as { writerGenerations: Record<string, number>; nodes: Record<string, { attempts: number; outcome: string; inputGenerations: Record<string, number> }> };
    assert.equal(metadata.nodes.capture?.attempts, 2);
    assert.equal(metadata.nodes["visual-reviewer"]?.attempts, 2);
    assert.equal(metadata.nodes["visual-reviewer"]?.outcome, "pass");
    assert.equal(metadata.writerGenerations.builder, 2);
    assert.equal(metadata.nodes.capture?.inputGenerations.builder, 2);
    assert.equal(metadata.nodes["visual-reviewer"]?.inputGenerations.builder, 2);
    assert.equal(await readFile(resolve(root, ".factory", "capture-2.txt"), "utf8"), "repaired\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph blocks a repair that escapes its declared path scope", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", {
          role: "critic", permissions: "read", dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["other.txt"] }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 8 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-repair-scope",
      history: [],
      signal: new AbortController().signal
    }), /outside its allowedPaths: value\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph evaluates repair paths relative to a nested candidate root", async () => {
  const repositoryRoot = await repository();
  const root = resolve(repositoryRoot, "game");
  try {
    await mkdir(root);
    await writeFile(resolve(root, "graph-fixture.mjs"), graphFixtureSource, "utf8");
    await writeFile(resolve(root, "value.txt"), "baseline\n", "utf8");
    await exec("git", ["add", "--all"], { cwd: repositoryRoot });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "nested project"], { cwd: repositoryRoot });
    await exec("git", ["config", "status.relativePaths", "false"], { cwd: repositoryRoot });

    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("reviewer", {
          role: "critic", permissions: "read", dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 8 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-nested-repair-scope",
      history: [],
      signal: new AbortController().signal
    });

    assert.match(result.summary, /repair complete/);
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("agent graph canonicalizes a reported revision_required outcome for repair control", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("alias-reviewer", {
          role: "critic", permissions: "read", dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 8 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-repair-outcome-alias",
      history: [],
      signal: new AbortController().signal
    });

    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
    const firstReview = result.contributors?.find((item) => item.agentId === "alias-reviewer");
    assert.equal(firstReview?.metadata?.outcome, "revise");
    assert.equal(firstReview?.metadata?.reportedOutcome, "revision_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph canonicalizes a reported revision_requested outcome for repair control", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("requested-alias-reviewer", {
          role: "critic", permissions: "read", dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 8 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-repair-requested-outcome-alias",
      history: [],
      signal: new AbortController().signal
    });

    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
    const firstReview = result.contributors?.find((item) => item.agentId === "requested-alias-reviewer");
    assert.equal(firstReview?.metadata?.outcome, "revise");
    assert.equal(firstReview?.metadata?.reportedOutcome, "revision_requested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph fails closed on needs-work and rejected critic vocabulary", async (suite) => {
  for (const testCase of [
    { nodeId: "needs-work-reviewer", reported: "needs-work", canonical: "revise" },
    { nodeId: "rejected-reviewer", reported: "rejected", canonical: "reject" }
  ]) {
    await suite.test(testCase.reported, async () => {
      const root = await repository();
      try {
        const result = await new AgentTeam().run({
          campaign: graphCampaign(root, [
            graphCommand("discover", { role: "scout", permissions: "read" }),
            graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
            graphCommand(testCase.nodeId, {
              role: "critic", permissions: "read", dependsOn: ["builder"],
              repair: { target: "builder", outcomes: [testCase.canonical], maximumAttempts: 1, allowedPaths: ["value.txt"] }
            })
          ], { maximumRepairAttempts: 1, maximumTotalAttempts: 8 }),
          candidate: { id: "candidate", root, metadata: {} },
          experimentId: `exp-${testCase.nodeId}`,
          history: [],
          signal: new AbortController().signal
        });

        assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
        const firstReview = result.contributors?.find((item) => item.agentId === testCase.nodeId);
        assert.equal(firstReview?.metadata?.outcome, testCase.canonical);
        assert.equal(firstReview?.metadata?.reportedOutcome, testCase.reported);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("agent graph rechecks and blocks regression of a frozen passed contract", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("discover", { role: "scout", permissions: "read" }),
        graphCommand("builder", { role: "implementer", permissions: "write", dependsOn: ["discover"] }),
        graphCommand("frozen-contract", { role: "critic", permissions: "read", dependsOn: ["builder"] }),
        graphCommand("reviewer", {
          role: "critic", permissions: "read", dependsOn: ["builder"],
          repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"], preserve: ["frozen-contract"] }
        })
      ], { maximumRepairAttempts: 1, maximumTotalAttempts: 10 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-frozen-contract",
      history: [],
      signal: new AbortController().signal
    }), /regressed frozen contract.*pass -> revise/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph rejects invalid dependency cycles before launching commands", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { dependsOn: ["beta"] }),
        graphCommand("beta", { dependsOn: ["alpha"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-graph-cycle",
      history: [],
      signal: new AbortController().signal
    }), /dependency cycle/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph conditions branch on structured predecessor outcomes", async () => {
  const root = await repository();
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { permissions: "read", provider: "openai", model: "test-model", billingMode: "subscription" }),
        graphCommand("conditional", {
          permissions: "read",
          dependsOn: ["alpha"],
          when: { node: "alpha", outcomes: ["pass"] }
        }),
        graphCommand("beta", {
          permissions: "read",
          dependsOn: ["alpha"],
          when: { node: "alpha", outcomes: ["revise"] }
        })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-graph-condition",
      history: [],
      signal: new AbortController().signal
    });
    const conditional = result.contributors?.find((item) => item.agentId === "conditional");
    const skipped = result.contributors?.find((item) => item.agentId === "beta");
    assert.equal(conditional?.status, "complete");
    assert.equal(skipped?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph serializes independent writers in the same candidate", async () => {
  const root = await repository();
  try {
    await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("writer-a", { role: "implementer", permissions: "write" }),
        graphCommand("writer-b", { role: "implementer", permissions: "write" })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-writer-serialization",
      history: [],
      signal: new AbortController().signal
    });
    const first = await timing(root, "exp-writer-serialization", "graph", "writer-a", "attempt-1");
    const second = await timing(root, "exp-writer-serialization", "graph", "writer-b", "attempt-1");
    assert.ok(first.finished <= second.started || second.finished <= first.started, "writers must never overlap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph fails when a required node is dependency-blocked", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("broken", { permissions: "read", required: false, command: [process.execPath, "missing-agent.mjs"] }),
        graphCommand("writer", { role: "implementer", permissions: "write", dependsOn: ["broken"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-required-blocked",
      history: [],
      signal: new AbortController().signal
    }), /required nodes failed.*writer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph canonicalizes qualified blocked outcomes and prevents downstream execution", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("blocked-reviewer", { role: "critic", permissions: "read" }),
        graphCommand("writer", { role: "implementer", permissions: "write", dependsOn: ["blocked-reviewer"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-qualified-blocked",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamInvalidatedError);
      assert.doesNotMatch(error.message, /unknown control outcome/);
      assert.match(error.message, /candidate invalidated.*blocked-reviewer.*writer/);
      const blockedRun = error.runs.find((run) => run.provenance.contributorId === "blocked-reviewer");
      assert.equal(blockedRun?.provenance.outcome, "blocked");
      assert.equal(blockedRun?.provenance.reportedOutcome, "blocked_missing_runtime_evidence");
      assert.equal(error.runs.some((run) => run.provenance.contributorId === "writer"), false);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph blocks target and spec return edges instead of treating them as successful implementation reviews", async () => {
  for (const [reviewer, outcome] of [["target-owner-reviewer", "target_revision"], ["spec-owner-reviewer", "spec_amendment"]] as const) {
    const root = await repository();
    try {
      await assert.rejects(() => new AgentTeam().run({
        campaign: graphCampaign(root, [
          graphCommand(reviewer, { role: "critic", permissions: "read" }),
          graphCommand("writer", { role: "implementer", permissions: "write", dependsOn: [reviewer] })
        ]),
        candidate: { id: "candidate", root, metadata: {} },
        experimentId: `exp-${reviewer}`,
        history: [],
        signal: new AbortController().signal
      }), (error: unknown) => {
        assert.ok(error instanceof AgentTeamInvalidatedError);
        assert.match(error.message, new RegExp(`candidate invalidated.*${reviewer}.*writer`));
        assert.deepEqual(error.projectDisposition, {
          kind: outcome === "target_revision" ? "target-revision" : "spec-amendment",
          rationale: `${reviewer === "target-owner-reviewer" ? "target" : "spec"} contract must be revised outside implementation`,
          claimIds: ["loop.first-errand"],
          evidenceReferences: ["value.txt"]
        });
        const review = error.runs.find((run) => run.provenance.contributorId === reviewer);
        assert.equal(review?.provenance.outcome, outcome);
        assert.equal(error.runs.some((run) => run.provenance.contributorId === "writer"), false);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("agent graph preserves successful upstream evidence when a downstream required node fails", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { permissions: "read" }),
        graphCommand("broken", { permissions: "read", dependsOn: ["alpha"], command: [process.execPath, "missing-agent.mjs"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-downstream-evidence",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamExecutionError);
      assert.equal(error instanceof AgentTeamInvalidatedError, false);
      assert.ok(error.artifacts.some((artifact) => artifact.label?.includes("alpha stdout")));
      assert.ok(error.provenance.contributors instanceof Array);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph preserves completed attempt evidence when the total-attempt cap is reached", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { permissions: "read" }),
        graphCommand("join", { permissions: "read", dependsOn: ["alpha"] })
      ], { maximumTotalAttempts: 1 }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-attempt-cap",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamExecutionError);
      assert.match(error.message, /maximumTotalAttempts/);
      assert.ok(error.artifacts.some((artifact) => artifact.label?.includes("alpha stdout")));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph emits live topology, bounded progress, and attempt completion events", async () => {
  const root = await repository();
  const events: FactoryTraceEventInput[] = [];
  try {
    await new AgentTeam().run({
      campaign: graphCampaign(root, [
        graphCommand("alpha", { permissions: "read", provider: "openai", model: "test-model", billingMode: "subscription" }),
        graphCommand("beta", { permissions: "read" }),
        graphCommand("join", { permissions: "read", dependsOn: ["alpha", "beta"] })
      ]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-live-trace",
      history: [],
      signal: new AbortController().signal,
      trace: {
        runId: "run-live-trace",
        campaignId: "agent-team-graph-contract",
        emit: async (event) => { events.push(event); }
      }
    });
    const alphaAttempt = "agent:exp-live-trace:alpha:attempt-1";
    assert.ok(events.some((event) => event.type === "edge:created" && event.sourceNodeId === "agent-node:exp-live-trace:alpha" && event.targetNodeId === "agent-node:exp-live-trace:join"));
    assert.ok(events.some((event) => event.type === "node:started" && event.nodeId === alphaAttempt));
    assert.ok(events.some((event) => event.type === "node:progress" && event.nodeId === alphaAttempt && event.progress?.unit === "bytes"));
    assert.ok(events.some((event) => event.type === "node:completed" && event.nodeId === alphaAttempt));
    const alphaComplete = events.find((event) => event.type === "node:completed" && event.nodeId === alphaAttempt);
    assert.deepEqual((alphaComplete?.data as { usage?: unknown })?.usage, {
      provider: "openai",
      model: "test-model",
      billingMode: "subscription",
      identitySource: "configured",
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.01,
      costSource: "provider-reported"
    });
    const alphaStart = events.findIndex((event) => event.type === "node:started" && event.nodeId === alphaAttempt);
    const alphaFinish = events.findIndex((event) => event.type === "node:completed" && event.nodeId === alphaAttempt);
    assert.ok(alphaStart >= 0 && alphaFinish > alphaStart);
    assert.equal(events.at(-1)?.type, "node:completed");
    assert.equal(events.at(-1)?.nodeId, "agent-team:exp-live-trace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("polished Godot preset has a valid gated agent graph", async () => {
  const campaign = JSON.parse(await readFile(resolve(process.cwd(), "presets/godot-polished/campaign.template.json"), "utf8")) as Campaign;
  assert.doesNotThrow(() => validateAgentTeamConfiguration(campaign));
  const presetGraph = (campaign.parameters?.agentTeam as { graph?: { nodes?: Array<{ id: string; instructions?: string; driver?: string; dependsOn?: string[]; when?: { node?: string; outcomes?: string[] } | Array<{ node?: string; outcomes?: string[] }>; repair?: { target?: string; outcomes?: string[] } }> } }).graph;
  const approvalRecorder = presetGraph?.nodes?.find((node) => node.id === "scene-target-approval-recorder");
  assert.match(approvalRecorder?.instructions ?? "", /validation\.json.*mirror status/s);
  const productionBuilder = presetGraph?.nodes?.find((node) => node.id === "production-slice-builder");
  assert.match(productionBuilder?.instructions ?? "", /every runtime source file.*structured artifact/s);
  assert.equal(presetGraph?.nodes?.some((node) => node.id === "core-game-director"), false);
  assert.equal(presetGraph?.nodes?.some((node) => node.id === "embodied-prototype-builder"), false);
  assert.equal(presetGraph?.nodes?.some((node) => node.id === "evidence-auditor"), false);
  assert.equal(presetGraph?.nodes?.some((node) => node.id === "component-fidelity-gate"), false);
  assert.equal(presetGraph?.nodes?.some((node) => node.id === "art-director-gate"), false);
  assert.ok(presetGraph?.nodes?.some((node) => node.id === "accepted-core-evidence" && node.driver === "godot.evidence"));
  const productionEvidence = presetGraph?.nodes?.find((node) => node.id === "production-gameplay-evidence");
  assert.equal(productionEvidence?.driver, "godot.evidence");
  assert.ok(productionEvidence?.dependsOn?.includes("production-slice-builder"));
  const productionGemini = presetGraph?.nodes?.find((node) => node.id === "gemini-production-review");
  assert.equal(productionGemini?.driver, "gemini.visual-production");
  assert.equal(productionGemini?.repair?.target, "production-slice-builder");
  assert.ok(productionGemini?.dependsOn?.includes("production-gameplay-evidence"));
  assert.ok(presetGraph?.nodes?.find((node) => node.id === "production-judge")?.dependsOn?.includes("gemini-production-review"));
  assert.equal((campaign.parameters?.godot as { visualReview?: { reviewNode?: string } })?.visualReview?.reviewNode, "gemini-production-review");
  assert.deepEqual(presetGraph?.nodes?.find((node) => node.id === "sam3-component-extraction")?.when, { node: "asset-lane-planner", outcomes: ["segment", "segment_pixel_motion"] });
  assert.deepEqual(presetGraph?.nodes?.find((node) => node.id === "omni-motion-study")?.when, { node: "asset-lane-planner", outcomes: ["motion_study", "pixel_motion", "segment_pixel_motion"] });
  const specCampaign = JSON.parse(await readFile(resolve(process.cwd(), "presets/godot-polished/spec-campaign.template.json"), "utf8")) as Campaign;
  assert.doesNotThrow(() => validateAgentTeamConfiguration(specCampaign));
  const embodiedCampaign = JSON.parse(await readFile(resolve(process.cwd(), "presets/godot-polished/embodied-campaign.template.json"), "utf8")) as Campaign;
  assert.doesNotThrow(() => validateAgentTeamConfiguration(embodiedCampaign));
  const embodiedGraph = (embodiedCampaign.parameters?.agentTeam as { graph?: { nodes?: Array<{ id: string; instructions?: string; driver?: string; dependsOn?: string[]; repair?: { target?: string } }> } }).graph;
  assert.ok(embodiedGraph?.nodes?.some((node) => node.id === "embodied-prototype-builder"));
  assert.match(embodiedGraph?.nodes?.find((node) => node.id === "embodied-prototype-builder")?.instructions ?? "", /factory-owned probe.*shipping InputEvents/s);
  const embodiedGemini = embodiedGraph?.nodes?.find((node) => node.id === "gemini-embodied-review");
  assert.equal(embodiedGemini?.driver, "gemini.visual-embodied");
  assert.equal(embodiedGemini?.repair?.target, "embodied-prototype-builder");
  assert.ok(embodiedGraph?.nodes?.find((node) => node.id === "embodied-judge")?.dependsOn?.includes("gemini-embodied-review"));
});

test("agent graph validates structured output field contracts before launch", () => {
  assert.throws(() => validateAgentTeamConfiguration(graphCampaign(".", [graphCommand("alpha", { role: "scout", permissions: "read", requiredOutputFields: ["bad field"] })])), /invalid field path/);
});

test("agent graph runs through the Codex App Server adapter and exposes native subagents", async () => {
  const root = await repository();
  const events: FactoryTraceEventInput[] = [];
  try {
    const result = await new AgentTeam().run({
      campaign: graphCampaign(root, [{
        id: "real-worker",
        role: "worker",
        adapter: "codex-app-server",
        command: [process.execPath, resolve(root, "app-server-fixture.mjs")],
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        skills: ["frame-core-game"],
        permissions: "read"
      }]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-app-server",
      history: [],
      signal: new AbortController().signal,
      trace: {
        runId: "run-app-server",
        campaignId: "agent-team-graph-contract",
        emit: async (event) => { events.push(event); }
      }
    });
    assert.match(result.summary, /App Server worker finished/);
    assert.equal(result.usage?.totalTokens, 100);
    const contribution = result.contributors?.[0];
    assert.equal(contribution?.usage?.model, "gpt-5.6-luna");
    assert.equal(contribution?.usage?.reasoningEffort, "high");
    const manifest = contribution?.metadata?.promptManifest as { adapter?: string; model?: string; reasoningEffort?: string; skills?: Array<{ name: string; sha256: string; required: boolean }>; layers?: Array<{ id: string; kind: string; content: string }>; providerContext?: { threadId?: string; turnId?: string; requestedModel?: string; actualModel?: string; requestedReasoningEffort?: string; reasoningEffort?: string } };
    assert.equal(manifest.adapter, "codex.app-server");
    assert.equal(manifest.model, "gpt-5.6-luna");
    assert.equal(manifest.reasoningEffort, "high");
    assert.equal(manifest.providerContext?.threadId, "thread-real-adapter");
    assert.equal(manifest.providerContext?.turnId, "turn-real-adapter");
    assert.equal(manifest.providerContext?.requestedModel, "gpt-5.6-luna");
    assert.equal(manifest.providerContext?.actualModel, "gpt-5.6-luna");
    assert.equal(manifest.providerContext?.requestedReasoningEffort, "high");
    assert.equal(manifest.providerContext?.reasoningEffort, "high");
    assert.equal(manifest.skills?.[0]?.name, "frame-core-game");
    assert.equal(manifest.skills?.[0]?.required, true);
    assert.match(manifest.skills?.[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(manifest.layers?.find((layer) => layer.id === "skill-frame-core-game")?.kind, "skill");
    assert.match(manifest.layers?.find((layer) => layer.id === "skill-frame-core-game")?.content ?? "", /repeated consequential decision/);
    assert.deepEqual(
      (manifest.providerContext as { instructionSources?: string[] }).instructionSources?.map((value) => value.replaceAll("\\", "/")),
      [resolve(root, "AGENTS.md").replaceAll("\\", "/")]
    );
    const providerNode = "agent:exp-app-server:real-worker:attempt-1:provider-item:collab-1";
    assert.ok(events.some((event) => event.type === "node:started" && event.nodeId === providerNode && event.role === "subagent"));
    assert.ok(events.some((event) => event.type === "node:completed" && event.nodeId === providerNode));
    const commandNode = "agent:exp-app-server:real-worker:attempt-1:provider-item:cmd-1";
    assert.ok(events.some((event) => event.type === "node:started" && event.nodeId === commandNode && event.role === "tool" && event.label === "Command"));
    assert.ok(events.some((event) => event.type === "node:completed" && event.nodeId === commandNode));
    assert.ok(!events.some((event) => event.type === "node:progress" && event.message === "item/agentMessage/delta"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph can invoke a lazily activated extension agent driver", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.extension",
      async run(request) {
        const output = resolve(request.candidate.root, "writer-a.txt");
        await writeFile(output, "produced by extension\n", "utf8");
        return {
          summary: "extension produced a candidate artifact",
          artifacts: [{ kind: "image", path: output, mediaType: "text/plain", label: "extension output" }],
          metadata: { provider: "fixture", operation: "segment", outcome: "segmented", structured: { findings: [{ id: "edge-halo", severity: "minor" }] } }
        };
      }
    };
    const team = new AgentTeam((id) => {
      assert.equal(id, "fixture.extension");
      return extensionDriver;
    });
    const result = await team.run({
      campaign: graphCampaign(root, [{
        id: "segment-art",
        adapter: "agent-driver",
        driver: "fixture.extension",
        role: "worker",
        permissions: "write"
      }]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-extension-driver",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "writer-a.txt"), "utf8"), "produced by extension\n");
    assert.match(result.summary, /extension produced/);
    const contribution = result.contributors?.[0];
    assert.equal(contribution?.status, "complete");
    assert.equal(contribution?.metadata?.outcome, "segmented");
    assert.deepEqual((contribution?.metadata?.structured as { findings?: unknown[] })?.findings, [{ id: "edge-halo", severity: "minor" }]);
    assert.ok(contribution?.artifacts.some((item) => item.label === "extension output"));
    const manifest = contribution?.metadata?.promptManifest as { adapter?: string };
    assert.equal(manifest.adapter, "agent:fixture.extension");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension drivers may return more artifacts than model structured output permits", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.many-artifacts",
      async run(request) {
        const directory = resolve(request.candidate.root, "evidence");
        await mkdir(directory, { recursive: true });
        const artifacts = await Promise.all(Array.from({ length: 65 }, async (_, index) => {
          const path = resolve(directory, `frame-${index}.txt`);
          await writeFile(path, `${index}\n`, "utf8");
          return { kind: "image" as const, path, mediaType: "text/plain", label: `frame ${index}` };
        }));
        return { summary: "large trusted evidence bundle passed", artifacts, metadata: { outcome: "pass" } };
      }
    };
    const result = await new AgentTeam(() => extensionDriver).run({
      campaign: graphCampaign(root, [{
        id: "many-artifacts",
        adapter: "agent-driver",
        driver: "fixture.many-artifacts",
        role: "worker",
        permissions: "write"
      }]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-many-artifacts",
      history: [],
      signal: new AbortController().signal
    });
    const contribution = result.contributors?.[0];
    assert.equal(contribution?.status, "complete");
    assert.equal(contribution?.metadata?.outcome, "pass");
    assert.equal(contribution?.artifacts.filter((item) => item.label?.startsWith("frame ")).length, 65);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only extension drivers may refresh only explicitly declared candidate evidence", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.evidence",
      writePaths: ["evidence/**"],
      async run(request) {
        const output = resolve(request.candidate.root, "evidence", "result.json");
        await mkdir(resolve(request.candidate.root, "evidence"), { recursive: true });
        await writeFile(output, "{}\n", "utf8");
        return {
          summary: "evidence refreshed",
          artifacts: [{ kind: "test-report", path: output, mediaType: "application/json", label: "fresh evidence" }],
          metadata: { outcome: "pass" }
        };
      }
    };
    const team = new AgentTeam(() => extensionDriver);
    const campaign = graphCampaign(root, [{
      id: "refresh-evidence",
      adapter: "agent-driver",
      driver: "fixture.evidence",
      role: "worker",
      permissions: "read",
      writePaths: ["evidence/**"]
    }]);
    campaign.mutablePaths = ["evidence/**"];
    const result = await team.run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-evidence-driver",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "evidence", "result.json"), "utf8"), "{}\n");
    assert.match(result.summary, /evidence refreshed/);
    assert.deepEqual((result.metadata as { nodes: Record<string, { writePaths?: string[] }> }).nodes["refresh-evidence"]?.writePaths, ["evidence/**"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only extension critics may write factory run evidence and forward structured findings", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.multimodal-review",
      async run(request) {
        const output = resolve(request.candidate.root, ".factory", "runs", request.experimentId, "multimodal-review", "review.json");
        await mkdir(resolve(output, ".."), { recursive: true });
        await writeFile(output, "{}\n", "utf8");
        return {
          summary: "multimodal evidence passed",
          artifacts: [{ kind: "test-report", path: output, mediaType: "application/json", label: "multimodal review" }],
          metadata: { outcome: "pass", structured: { findings: [{ id: "small-type", severity: "minor", evidenceIds: ["runtime-image-001"] }] } }
        };
      }
    };
    const result = await new AgentTeam(() => extensionDriver).run({
      campaign: graphCampaign(root, [{ id: "multimodal-review", adapter: "agent-driver", driver: "fixture.multimodal-review", role: "critic", permissions: "read" }]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-multimodal-review",
      history: [],
      signal: new AbortController().signal
    });
    const contribution = result.contributors?.find((item) => item.agentId === "multimodal-review");
    const structured = contribution?.metadata?.structured as { findings?: Array<{ id?: string }> };
    assert.equal(structured.findings?.[0]?.id, "small-type");
    assert.ok(contribution?.artifacts.some((item) => item.label === "multimodal review"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only extension driver write allowlists fail closed outside declared evidence", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.rogue-evidence",
      writePaths: ["evidence/**"],
      async run(request) {
        await mkdir(resolve(request.candidate.root, "evidence"), { recursive: true });
        await writeFile(resolve(request.candidate.root, "evidence", "result.json"), "{}\n", "utf8");
        await writeFile(resolve(request.candidate.root, "value.txt"), "tampered\n", "utf8");
        return { summary: "evidence refreshed", metadata: { outcome: "pass" } };
      }
    };
    const team = new AgentTeam(() => extensionDriver);
    const configured = graphCampaign(root, [{
      id: "refresh-evidence",
      adapter: "agent-driver",
      driver: "fixture.rogue-evidence",
      role: "worker",
      permissions: "read",
      writePaths: ["evidence/**"]
    }]);
    configured.mutablePaths = ["value.txt", "evidence/**"];
    await assert.rejects(team.run({
      campaign: configured,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-rogue-evidence-driver",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamExecutionError);
      assert.match(error.message, /outside its declared write paths: value\.txt/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict graph preflight requires one write contract for every writer", () => {
  const configured = graphCampaign(".", [
    graphCommand("builder", { role: "implementer", permissions: "write" })
  ], { enforceWriteContracts: true });
  assert.throws(() => validateAgentTeamConfiguration(configured), /builder must declare writePaths/);
});

test("strict graph preflight rejects a repair scope narrower than its writer contract", () => {
  const configured = graphCampaign(".", [
    graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt", "writer-a.txt"] }),
    graphCommand("reviewer", {
      role: "critic",
      permissions: "read",
      dependsOn: ["builder"],
      repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
    })
  ], { enforceWriteContracts: true });
  assert.throws(() => validateAgentTeamConfiguration(configured), /repair allowedPaths do not cover builder\.writePaths: writer-a\.txt/);
});

test("factory-native driver side effects are checked before any node executes", async () => {
  const root = await repository();
  let ran = false;
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.preflight-side-effects",
      writePaths: ["game/**/*.uid"],
      async run() {
        ran = true;
        return { summary: "should not run", metadata: { outcome: "pass" } };
      }
    };
    const configured = graphCampaign(root, [{
      id: "refresh-evidence",
      adapter: "agent-driver",
      driver: extensionDriver.id,
      role: "worker",
      permissions: "read",
      writePaths: ["evidence/**"]
    }], { enforceWriteContracts: true });
    configured.mutablePaths = ["evidence/**", "game/**"];
    await assert.rejects(new AgentTeam(() => extensionDriver).run({
      campaign: configured,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-driver-preflight",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.equal((error as { failureClass?: unknown }).failureClass, "infrastructure");
      assert.match((error as Error).message, /do not cover factory-native driver .* side effects: game\/\*\*\/\*\.uid/);
      return true;
    });
    assert.equal(ran, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable writer checkpoints reuse matching outputs without invoking the writer again", async () => {
  const root = await repository();
  const freshRoot = await repository();
  const changedBaseRoot = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-checkpoints-"));
  try {
    const configured = graphCampaign(root, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "checkpoint-project" } };
    const team = new AgentTeam();
    const first = await team.run({
      campaign: configured,
      candidate: { id: "candidate-1", root, metadata: {} },
      experimentId: "exp-checkpoint-1",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((first.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined);
    await acceptTeamCheckpoints(team, configured, root, "exp-checkpoint-1", first, dataRoot);
    const checkpointFiles = (await readdir(dataRoot, { recursive: true })).filter((path) => path.endsWith(".json") && !path.includes(".files"));
    assert.equal(checkpointFiles.length, 1);

    const second = await team.run({
      campaign: configured,
      candidate: { id: "candidate-2", root, metadata: {} },
      experimentId: "exp-checkpoint-2",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((second.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, true);
    assert.equal(second.contributors?.find((item) => item.agentId === "builder")?.metadata?.checkpointReused, true);

    await writeFile(resolve(root, "external-context.txt"), "new upstream context\n", "utf8");
    const externalContextChanged = await team.run({
      campaign: configured,
      candidate: { id: "candidate-external-context", root, metadata: {} },
      experimentId: "exp-checkpoint-external-context",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((externalContextChanged.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined, "changing a file outside writePaths must invalidate a writer that could have read it");

    const changedObjective = { ...configured, objective: "coordinate a materially revised bounded graph" };
    const instructionChanged = await team.run({
      campaign: changedObjective,
      candidate: { id: "candidate-instruction-change", root, metadata: {} },
      experimentId: "exp-checkpoint-instruction-change",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((instructionChanged.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined);

    const changedCommand = graphCampaign(root, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { command: [process.execPath, "graph-fixture.mjs", "changed-contract"], role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    changedCommand.parameters = { ...changedCommand.parameters, projectSlice: { projectId: "checkpoint-project" } };
    const commandChanged = await team.run({
      campaign: changedCommand,
      candidate: { id: "candidate-command-change", root, metadata: {} },
      experimentId: "exp-checkpoint-command-change",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((commandChanged.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined, "changing the executable contract must invalidate reuse");

    const freshConfigured = graphCampaign(freshRoot, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    freshConfigured.parameters = { ...freshConfigured.parameters, projectSlice: { projectId: "checkpoint-project" } };
    const restored = await team.run({
      campaign: freshConfigured,
      candidate: { id: "candidate-restored", root: freshRoot, metadata: {} },
      experimentId: "exp-checkpoint-restored",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((restored.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, true);
    assert.equal(await readFile(resolve(freshRoot, "value.txt"), "utf8"), "implemented\n");

    await writeFile(resolve(changedBaseRoot, "value.txt"), "newer authored baseline\n", "utf8");
    const changedBaseConfigured = graphCampaign(changedBaseRoot, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    changedBaseConfigured.parameters = { ...changedBaseConfigured.parameters, projectSlice: { projectId: "checkpoint-project" } };
    const changedBase = await team.run({
      campaign: changedBaseConfigured,
      candidate: { id: "candidate-newer-base", root: changedBaseRoot, metadata: {} },
      experimentId: "exp-checkpoint-newer-base",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((changedBase.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined, "a checkpoint must not overwrite a changed pre-image");

    await writeFile(resolve(root, "value.txt"), "externally changed\n", "utf8");
    const third = await team.run({
      campaign: configured,
      candidate: { id: "candidate-3", root, metadata: {} },
      experimentId: "exp-checkpoint-3",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((third.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined);
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "implemented\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(freshRoot, { recursive: true, force: true });
    await rm(changedBaseRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime implementation changes invalidate otherwise matching writer checkpoints", async () => {
  const root = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-runtime-checkpoint-"));
  try {
    const configured = graphCampaign(root, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "runtime-fingerprint-project" } };
    const team = new AgentTeam();
    const first = await team.run({ campaign: configured, candidate: { id: "first", root, metadata: {} }, experimentId: "exp-runtime-1", history: [], runtime: { dataRoot, implementationFingerprint: "runtime-a" }, signal: new AbortController().signal });
    await team.finalize({ campaign: configured, candidate: { id: "first", root, metadata: {} }, experimentId: "exp-runtime-1", history: [], runtime: { dataRoot, implementationFingerprint: "runtime-a" }, signal: new AbortController().signal, result: first, evaluations: [], accepted: true, reason: "test" });
    const second = await team.run({ campaign: configured, candidate: { id: "second", root, metadata: {} }, experimentId: "exp-runtime-2", history: [], runtime: { dataRoot, implementationFingerprint: "runtime-b" }, signal: new AbortController().signal });
    assert.equal((second.metadata as { nodes: Record<string, { checkpointReused?: boolean }> }).nodes.builder?.checkpointReused, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("infrastructure recovery reuses provisional writer work within the same logical experiment", async () => {
  const root = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-provisional-checkpoint-recovery-"));
  let calls = 0;
  const driver: AgentDriver = {
    id: "fixture.transient-review",
    async run() {
      calls += 1;
      if (calls === 1) throw new InfrastructureFailureError("transient provider outage after writer completion");
      return { summary: "review recovered", artifacts: [], metadata: { outcome: "pass", structured: { findings: [] } } };
    }
  };
  try {
    const configured = graphCampaign(root, [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] }),
      { id: "native-review", adapter: "agent-driver", driver: driver.id, role: "critic", permissions: "read", dependsOn: ["builder"] }
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "provisional-recovery-project" } };
    const team = new AgentTeam(() => driver);
    await assert.rejects(() => team.run({
      campaign: configured,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-0001",
      logicalExperimentId: "exp-0001",
      attemptNumber: 1,
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    }), AgentTeamInfrastructureError);
    const recovered = await team.run({
      campaign: configured,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-0001-attempt-0002",
      logicalExperimentId: "exp-0001",
      attemptNumber: 2,
      resumedFromExperimentId: "exp-0001",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal((recovered.metadata as { nodes: Record<string, { checkpointReused?: boolean; checkpointValidationState?: string }> }).nodes.builder?.checkpointReused, true);
    assert.equal(recovered.contributors?.find((contributor) => contributor.agentId === "builder")?.metadata?.checkpointValidationState, "provisional");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("terminal rejection invalidates only explicitly causal writer checkpoints", async () => {
  const root = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-causal-checkpoint-invalidation-"));
  try {
    const configured = graphCampaign(root, [
      graphCommand("writer-a", { role: "implementer", permissions: "write", writePaths: ["writer-a.txt"] }),
      graphCommand("writer-b", { role: "implementer", permissions: "write", writePaths: ["writer-b.txt"], dependsOn: ["writer-a"] }),
      graphCommand("nested-blocker-reviewer", {
        role: "critic",
        permissions: "read",
        authority: "propose",
        dependsOn: ["writer-b"],
        invalidationTargets: { revise: ["writer-b"] }
      })
    ], { claimIds: ["loop.first-errand"], enforceWriteContracts: true, reuseCheckpoints: true });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "causal-invalidation-project" } };
    await assert.rejects(() => new AgentTeam().run({
      campaign: configured,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-causal",
      logicalExperimentId: "exp-causal",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    }), AgentTeamInvalidatedError);
    const manifests = await Promise.all((await readdir(dataRoot, { recursive: true }))
      .filter((path) => path.endsWith(".json") && !path.includes(".files"))
      .map(async (path) => JSON.parse(await readFile(resolve(dataRoot, path), "utf8")) as { nodeId: string; validationState: string }));
    assert.deepEqual(manifests.filter((item) => item.nodeId === "writer-a").map((item) => item.validationState), ["provisional"]);
    assert.deepEqual(manifests.filter((item) => item.nodeId === "writer-b").map((item) => item.validationState), ["invalidated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("external hard-gate finalization invalidates a mapped writer's causal descendants but preserves independent work", async () => {
  const root = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-external-finalization-"));
  try {
    const configured = graphCampaign(root, [
      graphCommand("writer-a", { role: "implementer", permissions: "write", writePaths: ["writer-a.txt"] }),
      graphCommand("writer-b", { role: "implementer", permissions: "write", writePaths: ["writer-b.txt"], dependsOn: ["writer-a"] }),
      graphCommand("writer-c", { role: "implementer", permissions: "write", writePaths: ["writer-c.txt"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true, externalInvalidationTargets: { "fixture.gate#rejected": ["writer-a"] } });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "external-finalization-project" } };
    const team = new AgentTeam();
    const request = { campaign: configured, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-external-finalization", history: [], runtime: { dataRoot }, signal: new AbortController().signal };
    const result = await team.run(request);
    let manifests = await Promise.all((await readdir(dataRoot, { recursive: true }))
      .filter((path) => path.endsWith(".json") && !path.includes(".files"))
      .map(async (path) => JSON.parse(await readFile(resolve(dataRoot, path), "utf8")) as { nodeId: string; validationState: string }));
    assert.ok(manifests.every((manifest) => manifest.validationState === "provisional"));
    await team.finalize({
      ...request,
      result,
      evaluations: [{ evaluator: "fixture.gate", version: "1", status: "fail", metrics: {}, violations: [{ code: "rejected", message: "writer-a failed", severity: "error" }], artifacts: [] }],
      accepted: false,
      reason: "test-hard-gate"
    });
    manifests = await Promise.all((await readdir(dataRoot, { recursive: true }))
      .filter((path) => path.endsWith(".json") && !path.includes(".files"))
      .map(async (path) => JSON.parse(await readFile(resolve(dataRoot, path), "utf8")) as { nodeId: string; validationState: string }));
    assert.deepEqual(manifests.filter((item) => item.nodeId === "writer-a").map((item) => item.validationState), ["invalidated"]);
    assert.deepEqual(manifests.filter((item) => item.nodeId === "writer-b").map((item) => item.validationState), ["invalidated"]);
    assert.deepEqual(manifests.filter((item) => item.nodeId === "writer-c").map((item) => item.validationState), ["accepted"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("downstream checkpoints bind to the actual upstream writer output hash", async () => {
  const root = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-dependency-output-checkpoint-"));
  try {
    const nodes = [
      graphCommand("writer-a", { role: "implementer", permissions: "write", writePaths: ["writer-a.txt"] }),
      graphCommand("writer-b", { role: "implementer", permissions: "write", writePaths: ["writer-b.txt"], dependsOn: ["writer-a"] })
    ];
    const configured = graphCampaign(root, nodes, { enforceWriteContracts: true, reuseCheckpoints: true });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "dependency-output-project" } };
    const team = new AgentTeam();
    const first = await team.run({ campaign: configured, candidate: { id: "first", root, metadata: {} }, experimentId: "exp-dependency-output-1", history: [], runtime: { dataRoot }, signal: new AbortController().signal });
    await acceptTeamCheckpoints(team, configured, root, "exp-dependency-output-1", first, dataRoot);

    const changed = graphCampaign(root, [
      graphCommand("writer-a", { command: [process.execPath, "graph-fixture.mjs", "changed-upstream"], role: "implementer", permissions: "write", writePaths: ["writer-a.txt"] }),
      graphCommand("writer-b", { role: "implementer", permissions: "write", writePaths: ["writer-b.txt"], dependsOn: ["writer-a"] })
    ], { enforceWriteContracts: true, reuseCheckpoints: true });
    changed.parameters = { ...changed.parameters, projectSlice: { projectId: "dependency-output-project" } };
    const second = await team.run({ campaign: changed, candidate: { id: "second", root, metadata: {} }, experimentId: "exp-dependency-output-2", history: [], runtime: { dataRoot }, signal: new AbortController().signal });
    const metadata = second.metadata as { nodes: Record<string, { checkpointReused?: boolean }> };
    assert.equal(metadata.nodes["writer-a"]?.checkpointReused, undefined);
    assert.equal(metadata.nodes["writer-b"]?.checkpointReused, undefined, "downstream work must rerun when its writer dependency changes bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("valid review invalidates the rejected checkpoint and reuses only the accepted repair", async () => {
  const root = await repository();
  const freshRoot = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-invalidated-checkpoints-"));
  try {
    const nodes = [
      graphCommand("discover", { role: "planner", permissions: "read" }),
      graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] }),
      graphCommand("checkpoint-reviewer", {
        role: "critic",
        permissions: "read",
        authority: "propose",
        dependsOn: ["builder"],
        repair: { target: "builder", outcomes: ["revise"], maximumAttempts: 1, allowedPaths: ["value.txt"] }
      })
    ];
    const configured = graphCampaign(root, nodes, {
      claimIds: ["loop.first-errand"],
      maximumRepairAttempts: 1,
      enforceWriteContracts: true,
      reuseCheckpoints: true
    });
    configured.parameters = { ...configured.parameters, projectSlice: { projectId: "invalidated-checkpoint-project" } };
    (configured.parameters!.agentTeam as Record<string, unknown>).handoffCharacters = 512;
    (configured.parameters!.agentTeam as Record<string, unknown>).maximumHandoffArtifacts = 1;
    const first = await new AgentTeam().run({
      campaign: configured,
      candidate: { id: "candidate-1", root, metadata: {} },
      experimentId: "exp-invalidated-checkpoint-1",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(root, "value.txt"), "utf8"), "repaired\n");
    assert.equal((first.metadata as { nodes: Record<string, { attempts: number }> }).nodes.builder?.attempts, 2);
    const repairRequest = JSON.parse(await readFile(resolve(root, ".factory", "agent-team", "exp-invalidated-checkpoint-1", "graph", "builder", "attempt-2", "request.json"), "utf8")) as { inputs: Array<{ nodeId: string; structured?: { context?: unknown } }> };
    assert.equal(repairRequest.inputs.find((input) => input.nodeId === "checkpoint-reviewer")?.structured?.context && (repairRequest.inputs.find((input) => input.nodeId === "checkpoint-reviewer")!.structured!.context as Record<string, unknown>).handoffTruncated, true);
    assert.ok(JSON.stringify(repairRequest.inputs).length < 1800, "repair feedback and dependency inputs must share the final invocation budget");
    await acceptTeamCheckpoints(new AgentTeam(), configured, root, "exp-invalidated-checkpoint-1", first, dataRoot);
    const manifests = await Promise.all((await readdir(dataRoot, { recursive: true }))
      .filter((path) => path.endsWith(".json") && !path.includes(".files"))
      .map(async (path) => JSON.parse(await readFile(resolve(dataRoot, path), "utf8")) as { nodeId: string; validationState: string }));
    assert.deepEqual(manifests.filter((item) => item.nodeId === "builder").map((item) => item.validationState).sort(), ["accepted", "invalidated"]);

    const freshConfigured = graphCampaign(freshRoot, nodes, {
      claimIds: ["loop.first-errand"],
      maximumRepairAttempts: 1,
      enforceWriteContracts: true,
      reuseCheckpoints: true
    });
    freshConfigured.parameters = { ...freshConfigured.parameters, projectSlice: { projectId: "invalidated-checkpoint-project" } };
    (freshConfigured.parameters!.agentTeam as Record<string, unknown>).handoffCharacters = 512;
    (freshConfigured.parameters!.agentTeam as Record<string, unknown>).maximumHandoffArtifacts = 1;
    // A repair checkpoint is a delta against the rejected writer's exact output.
    // Materialize that base before proving the accepted repair can be reused.
    await writeFile(resolve(freshRoot, "value.txt"), "implemented\n", "utf8");
    const reused = await new AgentTeam().run({
      campaign: freshConfigured,
      candidate: { id: "candidate-2", root: freshRoot, metadata: {} },
      experimentId: "exp-invalidated-checkpoint-2",
      history: [],
      runtime: { dataRoot },
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(freshRoot, "value.txt"), "utf8"), "repaired\n");
    assert.equal((reused.metadata as { nodes: Record<string, { checkpointReused?: boolean; attempts: number }> }).nodes.builder?.checkpointReused, true);
    assert.equal((reused.metadata as { nodes: Record<string, { attempts: number }> }).nodes.builder?.attempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(freshRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("factory-native UID allowlists cover root and nested Godot sidecars", async () => {
  const root = await repository();
  try {
    const driver: AgentDriver = {
      id: "fixture.godot-uids",
      writePaths: ["game/**/*.uid"],
      async run(request) {
        await mkdir(resolve(request.candidate.root, "game", "ui"), { recursive: true });
        const rootUid = resolve(request.candidate.root, "game", "runtime.gd.uid");
        const nestedUid = resolve(request.candidate.root, "game", "ui", "hud.gd.uid");
        await writeFile(rootUid, "uid://root\n", "utf8");
        await writeFile(nestedUid, "uid://nested\n", "utf8");
        return { summary: "Godot UID import sidecars created", artifacts: [], metadata: { outcome: "pass" } };
      }
    };
    const campaign = graphCampaign(root, [{
      id: "godot-uids",
      adapter: "agent-driver",
      driver: driver.id,
      role: "worker",
      permissions: "read",
      writePaths: ["game/**/*.uid"]
    }]);
    campaign.mutablePaths = ["game/**"];
    const result = await new AgentTeam(() => driver).run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-godot-uids",
      history: [],
      signal: new AbortController().signal
    });
    assert.match(result.summary, /Godot UID import sidecars created/);
    assert.equal(await readFile(resolve(root, "game", "runtime.gd.uid"), "utf8"), "uid://root\n");
    assert.equal(await readFile(resolve(root, "game", "ui", "hud.gd.uid"), "utf8"), "uid://nested\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-driver provider outages remain infrastructure failures instead of candidate invalidation", async () => {
  const root = await repository();
  try {
    const driver: AgentDriver = {
      id: "fixture.provider-outage",
      async run() { throw new InfrastructureFailureError("provider temporarily unavailable"); }
    };
    await assert.rejects(() => new AgentTeam(() => driver).run({
      campaign: graphCampaign(root, [{ id: "provider-review", adapter: "agent-driver", driver: driver.id, role: "critic", permissions: "read" }]),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-provider-outage",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof AgentTeamInfrastructureError);
      assert.equal(error instanceof AgentTeamInvalidatedError, false);
      assert.match(error.message, /provider-review/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-driver invocations receive provider-neutral graph handoffs", async () => {
  const root = await repository();
  try {
    const driver: AgentDriver = {
      id: "fixture.handoff",
      async run(request) {
        assert.equal(request.invocation?.nodeId, "native-review");
        assert.equal(request.invocation?.attempt, 1);
        assert.equal(request.invocation?.reason.kind, "initial");
        assert.equal(request.invocation?.inputs[0]?.nodeId, "alpha");
        assert.match(request.invocation?.inputs[0]?.summary ?? "", /alpha/);
        assert.equal(request.history.length, 1);
        assert.equal(request.history[0]?.experimentId, "history-2");
        assert.equal(request.history[0]?.evaluations.length, 0);
        assert.ok((request.history[0]?.summary.length ?? 0) < 1000);
        return { summary: "native handoff received", artifacts: [], metadata: { outcome: "pass", structured: { findings: [] } } };
      }
    };
    const campaign = graphCampaign(root, [
      graphCommand("alpha", { permissions: "read" }),
      { id: "native-review", adapter: "agent-driver", driver: driver.id, role: "critic", permissions: "read", dependsOn: ["alpha"] }
    ]);
    const teamSettings = campaign.parameters!.agentTeam as Record<string, unknown>;
    teamSettings.historyLimit = 1;
    teamSettings.handoffCharacters = 1200;
    const result = await new AgentTeam(() => driver).run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-native-handoff",
      history: [1, 2].map((index) => ({ campaignId: campaign.id, experimentId: `history-${index}`, startedAt: new Date(index).toISOString(), finishedAt: new Date(index + 1).toISOString(), status: "discard" as const, summary: "history ".repeat(1000), metrics: { score: index }, evaluations: [{ evaluator: "fixture", version: "1", status: "pass" as const, metrics: { score: index }, violations: [], artifacts: [] }] })),
      signal: new AbortController().signal
    });
    assert.match(result.summary, /native handoff received/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal trusted rejection invalidates the exact writer checkpoint generation", async () => {
  const root = await repository();
  const freshRoot = await repository();
  const dataRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-terminal-rejection-checkpoints-"));
  const nodes = [
    graphCommand("discover", { role: "planner", permissions: "read" }),
    graphCommand("builder", { role: "implementer", permissions: "write", writePaths: ["value.txt"], dependsOn: ["discover"] }),
    graphCommand("nested-blocker-reviewer", { role: "critic", permissions: "read", authority: "propose", dependsOn: ["builder"] })
  ];
  const run = async (candidateRoot: string, experimentId: string) => {
    const campaign = graphCampaign(candidateRoot, nodes, { claimIds: ["loop.first-errand"], enforceWriteContracts: true, reuseCheckpoints: true });
    campaign.parameters = { ...campaign.parameters, projectSlice: { projectId: "terminal-rejection-project" } };
    return new AgentTeam().run({ campaign, candidate: { id: experimentId, root: candidateRoot, metadata: {} }, experimentId, history: [], runtime: { dataRoot }, signal: new AbortController().signal });
  };
  try {
    await assert.rejects(() => run(root, "exp-terminal-rejection-1"), AgentTeamInvalidatedError);
    let second: AgentTeamInvalidatedError | undefined;
    await assert.rejects(() => run(freshRoot, "exp-terminal-rejection-2"), (error: unknown) => {
      assert.ok(error instanceof AgentTeamInvalidatedError);
      second = error;
      return true;
    });
    assert.equal(second?.runs.find((item) => item.provenance.nodeId === "builder")?.provenance.checkpointReused, undefined);
    const manifests = await Promise.all((await readdir(dataRoot, { recursive: true }))
      .filter((path) => path.endsWith(".json") && !path.includes(".files"))
      .map(async (path) => JSON.parse(await readFile(resolve(dataRoot, path), "utf8")) as { nodeId: string; validationState: string }));
    assert.ok(manifests.filter((item) => item.nodeId === "builder").every((item) => item.validationState === "invalidated"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(freshRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
