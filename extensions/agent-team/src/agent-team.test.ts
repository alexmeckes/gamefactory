import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentDriver, Campaign, FactoryTraceEventInput } from "@gamefactory/core";
import { AgentTeam, AgentTeamExecutionError, validateAgentTeamConfiguration } from "./index.js";

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
if (["alpha", "beta"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({
    summary: request.nodeId + " complete",
    outcome: "pass",
    context: { source: request.nodeId },
    usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.01, costSource: "provider-reported" },
    artifacts: [{ kind: "other", path: "value.txt", label: request.nodeId + " evidence" }]
  }));
} else if (request.nodeId === "join") {
  assert.deepEqual(request.inputs.map((input) => input.nodeId).sort(), ["alpha", "beta"]);
  assert.ok(request.inputs.every((input) => input.structured.context.source === input.nodeId));
  assert.ok(request.inputs.every((input) => input.artifacts[0].path.endsWith("value.txt")));
  assert.ok(request.inputs.every((input) => input.output === ""), "structured handoffs should not duplicate raw stdout");
  console.log(JSON.stringify({ summary: "joined structured findings", outcome: "pass", projectEvidence: { scenarios: [], targetSha256: "a".repeat(64) } }));
} else if (request.nodeId === "discover") {
  console.log("human-readable prelude");
  console.log(JSON.stringify({ summary: "found hypothesis", outcome: "ready", context: { hypothesis: "raise-value" } }));
} else if (request.nodeId === "builder") {
  const discovery = request.inputs.find((input) => input.nodeId === "discover");
  assert.equal(discovery.structured.context.hypothesis, "raise-value");
  const repairing = request.reason.kind === "repair";
  if (repairing) {
    const review = request.inputs.find((input) => ["reviewer", "alias-reviewer", "requested-alias-reviewer", "needs-work-reviewer", "rejected-reviewer", "visual-reviewer"].includes(input.nodeId));
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
} else if (["writer-a", "writer-b"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(request.nodeId + ".txt", "written\\n", "utf8");
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
    mutablePaths: ["value.txt", "writer-a.txt", "writer-b.txt"],
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

    const plannerRequest = JSON.parse(await readFile(resolve(root, ".factory", "agent-team", "exp-1", "planner", "lead", "request.json"), "utf8")) as { inputs: Array<{ output: string }>; effectivePrompt: { layers: Array<{ kind: string }> } };
    assert.equal(plannerRequest.inputs.length, 2);
    assert.ok(plannerRequest.inputs.every((input) => input.output.includes("finding from")));
    assert.ok(plannerRequest.effectivePrompt.layers.some((layer) => layer.kind === "role"));
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
        graphCommand("nested-plan-consumer", { role: "implementer", permissions: "write", dependsOn: ["nested-blocker-reviewer"] })
      ], { claimIds: ["loop.first-errand"] }),
      candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-nested-claimed-blocker", history: [], signal: new AbortController().signal
    });
    assert.match(result.summary, /nested planning handoff consumed/);
    assert.equal(await readFile(resolve(root, "writer-a.txt"), "utf8"), "consumed nested planning handoff\n");
  } finally { await rm(root, { recursive: true, force: true }); }
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
      assert.ok(error instanceof AgentTeamExecutionError);
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
  const specCampaign = JSON.parse(await readFile(resolve(process.cwd(), "presets/godot-polished/spec-campaign.template.json"), "utf8")) as Campaign;
  assert.doesNotThrow(() => validateAgentTeamConfiguration(specCampaign));
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
          metadata: { provider: "fixture", operation: "segment", outcome: "segmented" }
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
    assert.ok(contribution?.artifacts.some((item) => item.label === "extension output"));
    const manifest = contribution?.metadata?.promptManifest as { adapter?: string };
    assert.equal(manifest.adapter, "agent:fixture.extension");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only extension drivers may refresh only explicitly declared candidate evidence", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.evidence",
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
      driverWritePaths: ["evidence/**"]
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
    assert.deepEqual((result.metadata as { nodes: Record<string, { driverWritePaths?: string[] }> }).nodes["refresh-evidence"]?.driverWritePaths, ["evidence/**"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only extension driver write allowlists fail closed outside declared evidence", async () => {
  const root = await repository();
  try {
    const extensionDriver: AgentDriver = {
      id: "fixture.rogue-evidence",
      async run(request) {
        await mkdir(resolve(request.candidate.root, "evidence"), { recursive: true });
        await writeFile(resolve(request.candidate.root, "evidence", "result.json"), "{}\n", "utf8");
        await writeFile(resolve(request.candidate.root, "value.txt"), "tampered\n", "utf8");
        return { summary: "evidence refreshed", metadata: { outcome: "pass" } };
      }
    };
    const team = new AgentTeam(() => extensionDriver);
    await assert.rejects(team.run({
      campaign: graphCampaign(root, [{
        id: "refresh-evidence",
        adapter: "agent-driver",
        driver: "fixture.rogue-evidence",
        role: "worker",
        permissions: "read",
        driverWritePaths: ["evidence/**"]
      }]),
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
