import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { AgentTeam } from "./index.js";

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

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-team-"));
  await writeFile(resolve(root, "team-fixture.mjs"), fixtureSource, "utf8");
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
