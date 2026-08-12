import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { AgentTeam, AgentTeamExecutionError } from "./index.js";

const exec = promisify(execFile);

const fixtureSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
assert.equal(process.env.GAMEFACTORY_STAGE, request.stage);
assert.equal(process.env.GAMEFACTORY_CONTRIBUTOR, request.contributorId);
const timingRoot = ".factory/timing";
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
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log("review from " + request.contributorId);
}
const finished = Date.now();
await writeFile(timingRoot + "/" + request.stage + "-" + request.contributorId + ".json", JSON.stringify({ started, finished }), "utf8");
`;

const graphFixtureSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
assert.equal(process.env.GAMEFACTORY_NODE, request.nodeId);
assert.equal(Number(process.env.GAMEFACTORY_ATTEMPT), request.attempt);
const timingRoot = ".factory/graph-timing";
await mkdir(timingRoot, { recursive: true });
const started = Date.now();
if (["alpha", "beta"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({
    summary: request.nodeId + " complete",
    outcome: "pass",
    context: { source: request.nodeId },
    artifacts: [{ kind: "other", path: "value.txt", label: request.nodeId + " evidence" }]
  }));
} else if (request.nodeId === "join") {
  assert.deepEqual(request.inputs.map((input) => input.nodeId).sort(), ["alpha", "beta"]);
  assert.ok(request.inputs.every((input) => input.structured.context.source === input.nodeId));
  assert.ok(request.inputs.every((input) => input.artifacts[0].path.endsWith("value.txt")));
  console.log(JSON.stringify({ summary: "joined structured findings", outcome: "pass" }));
} else if (request.nodeId === "discover") {
  console.log("human-readable prelude");
  console.log(JSON.stringify({ summary: "found hypothesis", outcome: "ready", context: { hypothesis: "raise-value" } }));
} else if (request.nodeId === "builder") {
  const discovery = request.inputs.find((input) => input.nodeId === "discover");
  assert.equal(discovery.structured.context.hypothesis, "raise-value");
  const repairing = request.reason.kind === "repair";
  if (repairing) {
    const review = request.inputs.find((input) => input.nodeId === "reviewer");
    assert.equal(review.structured.outcome, "revise");
  }
  await writeFile("value.txt", repairing ? "repaired\\n" : "implemented\\n", "utf8");
  console.log(JSON.stringify({ summary: repairing ? "repair complete" : "implementation complete", outcome: "complete" }));
} else if (request.nodeId === "reviewer") {
  const value = await readFile("value.txt", "utf8");
  console.log(JSON.stringify(value === "repaired\\n"
    ? { summary: "review passed", outcome: "pass" }
    : { summary: "needs repair", outcome: "revise", findings: [{ issue: "value is not repaired" }] }));
} else if (request.nodeId === "conditional") {
  assert.equal(request.inputs[0].outcome, "pass");
  console.log(JSON.stringify({ summary: "conditional branch ran", outcome: "complete" }));
} else if (["writer-a", "writer-b"].includes(request.nodeId)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(request.nodeId + ".txt", "written\\n", "utf8");
  console.log(JSON.stringify({ summary: request.nodeId + " complete", outcome: "complete" }));
} else {
  throw new Error("unknown graph fixture node " + request.nodeId);
}
const finished = Date.now();
await writeFile(timingRoot + "/" + request.nodeId + "-" + request.attempt + ".json", JSON.stringify({ started, finished }), "utf8");
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
  await writeFile(resolve(root, "value.txt"), "baseline\n", "utf8");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "--all"], { cwd: root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function timing(root: string, name: string): Promise<{ started: number; finished: number }> {
  return JSON.parse(await readFile(resolve(root, ".factory", "timing", name), "utf8")) as { started: number; finished: number };
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
    assert.equal(result.artifacts?.length, 18);
    assert.deepEqual(result.contributors?.map(({ agentId, role }) => [agentId, role]), [
      ["systems", "scout"],
      ["gameplay", "scout"],
      ["lead", "planner"],
      ["builder", "implementer"],
      ["safety", "critic"],
      ["quality", "critic"]
    ]);
    assert.ok(result.contributors?.every((item) => item.status === "complete" && item.artifacts.length === 3));
    const metadata = result.metadata as { pipeline: string; stages: { scouts: string[]; critics: string[] } };
    assert.equal(metadata.pipeline, "agent.team");
    assert.equal(metadata.stages.scouts.length + metadata.stages.critics.length, 4);

    const systems = await timing(root, "scout-systems.json");
    const gameplay = await timing(root, "scout-gameplay.json");
    assert.ok(Math.max(systems.started, gameplay.started) < Math.min(systems.finished, gameplay.finished), "scouts should overlap");
    const safety = await timing(root, "critic-safety.json");
    const quality = await timing(root, "critic-quality.json");
    assert.ok(Math.max(safety.started, quality.started) < Math.min(safety.finished, quality.finished), "critics should overlap");

    const plannerRequest = JSON.parse(await readFile(resolve(root, ".factory", "agent-team", "exp-1", "planner", "lead", "request.json"), "utf8")) as { inputs: Array<{ output: string }> };
    assert.equal(plannerRequest.inputs.length, 2);
    assert.ok(plannerRequest.inputs.every((input) => input.output.includes("finding from")));
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
    const alpha = await timing(root, "../graph-timing/alpha-1.json");
    const beta = await timing(root, "../graph-timing/beta-1.json");
    const join = await timing(root, "../graph-timing/join-1.json");
    assert.ok(Math.max(alpha.started, beta.started) < Math.min(alpha.finished, beta.finished), "independent readers should overlap");
    assert.ok(join.started >= Math.max(alpha.finished, beta.finished), "dependent node should start after both predecessors");
    assert.equal(result.contributors?.length, 3);
    assert.ok(result.contributors?.every((item) => item.artifacts.some((artifact) => artifact.label?.includes("structured output"))));
    const metadata = result.metadata as { mode: string; totalAttempts: number; nodes: Record<string, { outcome: string }> };
    assert.equal(metadata.mode, "graph");
    assert.equal(metadata.totalAttempts, 3);
    assert.equal(metadata.nodes.join?.outcome, "pass");
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
        graphCommand("alpha", { permissions: "read" }),
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
    const first = await timing(root, "../graph-timing/writer-a-1.json");
    const second = await timing(root, "../graph-timing/writer-b-1.json");
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
