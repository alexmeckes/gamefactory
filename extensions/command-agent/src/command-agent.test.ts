import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { CommandAgent, CommandAgentExecutionError } from "./index.js";

function campaign(projectRoot: string, script: string, commandAgent: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "agent-contract",
    objective: "write a marker",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    parameters: {
      agentCommand: [process.execPath, script],
      commandAgent,
      agentInstructions: ["Respect hard constraints; choose the implementation hypothesis."],
      design: { intent: { path: "design.intent.json", id: "fixture" } }
    },
    acceptance: { primaryMetric: "score", direction: "maximize" }
  };
}

async function run(project: Campaign, candidateRoot: string, experimentId = "exp-1") {
  return new CommandAgent().run({
    campaign: project,
    candidate: { id: "candidate", root: candidateRoot, metadata: { discovery: { slot: 2 } } },
    experimentId,
    history: [],
    signal: new AbortController().signal
  });
}

async function executionFailure(operation: Promise<unknown>): Promise<CommandAgentExecutionError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof CommandAgentExecutionError);
    return error;
  }
  assert.fail("Expected command agent to fail");
}

function outside(root: string, path: string): boolean {
  const traversal = relative(root, path);
  return traversal.startsWith("..") || isAbsolute(traversal);
}

test("command agent receives an isolated request and captures its audit logs", async () => {
  const candidateRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-"));
  const script = resolve(candidateRoot, "agent.mjs");
  const project = campaign(candidateRoot, script);
  try {
    await writeFile(script, `import { readFile, writeFile } from "node:fs/promises";\nconst request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));\nawait writeFile("marker.txt", request.objective);\nconsole.log("agent fixture complete");\n`, "utf8");
    const result = await run(project, candidateRoot);
    assert.equal(await readFile(resolve(candidateRoot, "marker.txt"), "utf8"), project.objective);
    assert.match(result.summary, /fixture complete/);
    assert.equal(result.artifacts?.length, 3);
    const request = JSON.parse(await readFile(resolve(candidateRoot, ".factory", "agent", "exp-1", "request.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(request.candidateMetadata, { discovery: { slot: 2 } });
    assert.deepEqual(request.instructions, ["Respect hard constraints; choose the implementation hypothesis."]);
    assert.deepEqual(request.designIntent, { path: "design.intent.json", id: "fixture" });
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
});

test("command agent records configured model identity and structured usage", async () => {
  const candidateRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-usage-"));
  const script = resolve(candidateRoot, "agent.mjs");
  try {
    await writeFile(script, `console.log(JSON.stringify({ summary: "model work complete", usage: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 30, reasoningTokens: 12, costUsd: 0.07, costSource: "provider-reported" } }));\n`, "utf8");
    const result = await run(campaign(candidateRoot, script, { provider: "openai", model: "test-model", billingMode: "subscription" }), candidateRoot, "exp-usage");
    assert.equal(result.summary, "model work complete");
    assert.deepEqual(result.usage, {
      provider: "openai",
      model: "test-model",
      billingMode: "subscription",
      identitySource: "configured",
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningTokens: 12,
      costUsd: 0.07,
      costSource: "provider-reported"
    });
    assert.equal(result.contributors?.[0]?.invocationId, "agent:exp-usage:command.agent:attempt-1");
    assert.equal(result.contributors?.[0]?.usage?.model, "test-model");
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
});

test("command agent retains nonzero-exit evidence outside a disposable candidate", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-failure-project-"));
  const candidateRoot = resolve(projectRoot, "candidate");
  const script = resolve(candidateRoot, "agent.mjs");
  try {
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(script, `console.log("partial stdout");\nconsole.error("deliberate failure");\nprocess.exitCode = 7;\n`, "utf8");
    const error = await executionFailure(run(campaign(projectRoot, script), candidateRoot, "exp-nonzero"));
    assert.equal(error.code, "nonzero-exit");
    assert.equal(error.provenance.exitCode, 7);
    assert.equal(error.artifacts.length, 3);
    assert.ok(error.artifacts.every((artifact) => outside(candidateRoot, artifact.path)));

    await rm(candidateRoot, { recursive: true, force: true });
    const stdout = error.artifacts.find((artifact) => artifact.label === "Failed agent stdout");
    const stderr = error.artifacts.find((artifact) => artifact.label === "Failed agent stderr");
    const request = error.artifacts.find((artifact) => artifact.label === "Failed agent request");
    assert.match(await readFile(stdout!.path, "utf8"), /partial stdout/);
    assert.match(await readFile(stderr!.path, "utf8"), /deliberate failure/);
    assert.match(await readFile(request!.path, "utf8"), /write a marker/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("command agent times out and retains bounded evidence", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-timeout-project-"));
  const candidateRoot = resolve(projectRoot, "candidate");
  const script = resolve(candidateRoot, "agent.mjs");
  try {
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(script, `console.log("started");\nsetInterval(() => {}, 1000);\n`, "utf8");
    const started = Date.now();
    const error = await executionFailure(run(campaign(projectRoot, script, { timeoutSeconds: 0.05 }), candidateRoot, "exp-timeout"));
    assert.equal(error.code, "timeout");
    assert.ok(Date.now() - started < 5_000);
    assert.match(await readFile(error.artifacts[0]!.path, "utf8"), /started/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("command agent caps combined output and reports an output-limit failure", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-output-project-"));
  const candidateRoot = resolve(projectRoot, "candidate");
  const script = resolve(candidateRoot, "agent.mjs");
  try {
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(script, `process.stdout.write("x".repeat(100_000));\nsetInterval(() => {}, 1000);\n`, "utf8");
    const error = await executionFailure(run(campaign(projectRoot, script, { maximumOutputBytes: 256 }), candidateRoot, "exp-output"));
    assert.equal(error.code, "output-limit");
    assert.equal(error.provenance.capturedOutputBytes, 256);
    const retainedBytes = (await readFile(error.artifacts[0]!.path)).byteLength + (await readFile(error.artifacts[1]!.path)).byteLength;
    assert.equal(retainedBytes, 256);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("command agent scrubs inherited environment and applies explicit allowlist and additions", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-environment-project-"));
  const candidateRoot = resolve(projectRoot, "candidate");
  const script = resolve(candidateRoot, "agent.mjs");
  const secretName = "GAMEFACTORY_TEST_SECRET";
  const allowedName = "GAMEFACTORY_TEST_ALLOWED";
  const previousSecret = process.env[secretName];
  const previousAllowed = process.env[allowedName];
  process.env[secretName] = "must-not-leak";
  process.env[allowedName] = "explicitly-visible";
  try {
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(script, `import { writeFile } from "node:fs/promises";\nawait writeFile("environment.json", JSON.stringify({ secret: process.env.${secretName}, allowed: process.env.${allowedName}, added: process.env.AGENT_ADDED, request: Boolean(process.env.GAMEFACTORY_REQUEST) }));\n`, "utf8");
    const project = campaign(projectRoot, script, {
      environmentAllowlist: [allowedName],
      environment: { AGENT_ADDED: "configured" }
    });
    await run(project, candidateRoot, "exp-environment");
    const environment = JSON.parse(await readFile(resolve(candidateRoot, "environment.json"), "utf8")) as Record<string, unknown>;
    assert.equal(environment.secret, undefined);
    assert.equal(environment.allowed, "explicitly-visible");
    assert.equal(environment.added, "configured");
    assert.equal(environment.request, true);
  } finally {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
    if (previousAllowed === undefined) delete process.env[allowedName];
    else process.env[allowedName] = previousAllowed;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
