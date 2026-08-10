import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BudgetController, FactoryRunner, MemoryLogger } from "@gamefactory/core";
import type { AgentDriver, Campaign, Candidate, Evaluation, Evaluator, ExperimentRecord, WorkflowContext, WorkspaceDriver } from "@gamefactory/core";
import { TournamentWorkflow } from "./index.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function campaign(projectRoot: string): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "tournament-integration",
    objective: "select the best independent candidate",
    projectRoot,
    workflow: "tournament",
    requires: ["workspace:mock.workspace", "agent:mock.agent", "evaluator:mock.score"],
    parameters: {
      tournament: {
        workspace: "mock.workspace",
        agents: ["mock.agent"],
        evaluators: [{ id: "mock.score", cost: 1 }],
        candidateCount: 3,
        concurrency: 2
      }
    },
    acceptance: { primaryMetric: "score", direction: "maximize", minimumDelta: 0.01 },
    budget: { maximumExperiments: 6 }
  };
}

async function runner(projectRoot: string): Promise<FactoryRunner> {
  const instance = new FactoryRunner({
    cwd: projectRoot,
    config: {
      apiVersion: "gamefactory.dev/v1",
      extensions: [resolve(extensionRoot, "../mock"), extensionRoot],
      resultLog: "results.jsonl"
    },
    logger: new MemoryLogger()
  });
  await instance.initialize();
  return instance;
}

test("tournament accepts exactly one deterministic winner per bounded parallel round", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-tournament-"));
  const instance = await runner(projectRoot);
  try {
    const result = await instance.run(campaign(projectRoot));
    assert.equal(result.status, "budget-exhausted");
    assert.equal(result.experiments.length, 7);

    const candidates = result.experiments.filter((record) => record.status !== "baseline");
    assert.deepEqual(candidates.map((record) => record.status), ["discard", "discard", "keep", "discard", "discard", "keep"]);
    const winners = candidates.filter((record) => record.status === "keep");
    assert.deepEqual(winners.map((record) => record.experimentId), ["tournament-r0001-c001", "tournament-r0002-c001"]);
    assert.equal(result.bestMetrics.score, 0.6);

    const lines = (await readFile(resolve(projectRoot, "results.jsonl"), "utf8")).trim().split(/\r?\n/);
    assert.equal(lines.length, 7);
  } finally {
    await instance.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tournament resumes from JSONL without repeating its baseline or round ids", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-tournament-resume-"));
  const first = await runner(projectRoot);
  try {
    const firstCampaign = campaign(projectRoot);
    firstCampaign.budget = { maximumExperiments: 3 };
    const result = await first.run(firstCampaign);
    assert.equal(result.experiments.filter((record) => record.status === "baseline").length, 1);
  } finally {
    await first.dispose();
  }

  const resumed = await runner(projectRoot);
  try {
    const result = await resumed.run(campaign(projectRoot));
    assert.equal(result.experiments.filter((record) => record.status === "baseline").length, 1);
    assert.ok(result.experiments.some((record) => record.experimentId === "tournament-r0002-c001"));
    assert.equal(new Set(result.experiments.map((record) => record.experimentId)).size, result.experiments.length);
  } finally {
    await resumed.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tournament bounds agent concurrency, stops its evaluator waterfall, and serializes finalization", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-tournament-contract-"));
  const records: ExperimentRecord[] = [];
  const accepted: string[] = [];
  const discarded: string[] = [];
  const expensiveCalls: string[] = [];
  let activeAgents = 0;
  let maximumActiveAgents = 0;
  let activeFinalizations = 0;
  let maximumActiveFinalizations = 0;

  const workspace: WorkspaceDriver = {
    id: "test.workspace",
    async createCandidate({ experimentId }): Promise<Candidate> {
      return { id: experimentId, root: resolve(projectRoot, experimentId), metadata: {} };
    },
    async acceptCandidate({ candidate }) {
      activeFinalizations += 1;
      maximumActiveFinalizations = Math.max(maximumActiveFinalizations, activeFinalizations);
      await delay(2);
      accepted.push(candidate.id);
      activeFinalizations -= 1;
      return { revision: `accepted-${candidate.id}` };
    },
    async discardCandidate({ candidate }) {
      activeFinalizations += 1;
      maximumActiveFinalizations = Math.max(maximumActiveFinalizations, activeFinalizations);
      await delay(2);
      discarded.push(candidate.id);
      activeFinalizations -= 1;
    }
  };
  const agent: AgentDriver = {
    id: "test.agent",
    async run(request) {
      activeAgents += 1;
      maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
      await delay(10);
      activeAgents -= 1;
      if (request.experimentId.endsWith("c003")) throw new Error("deliberate agent crash");
      request.candidate.metadata.score = request.experimentId.endsWith("c002") ? 2 : 1;
      return { summary: "Generated a scored candidate.", usage: { costUsd: 0.01 } };
    }
  };
  const cheap: Evaluator = {
    id: "test.cheap",
    version: "1.0.0",
    async evaluate(input): Promise<Evaluation> {
      const failsGate = input.experimentId.endsWith("c002");
      return {
        evaluator: "test.cheap",
        version: "1.0.0",
        status: failsGate ? "fail" : "pass",
        metrics: { score: input.candidate ? Number(input.candidate.metadata.score ?? 0) : 0 },
        violations: failsGate ? [{ code: "gate", message: "cheap gate failed", severity: "error" }] : [],
        artifacts: []
      };
    }
  };
  const expensive: Evaluator = {
    id: "test.expensive",
    version: "1.0.0",
    async evaluate(input): Promise<Evaluation> {
      expensiveCalls.push(input.experimentId);
      return { evaluator: "test.expensive", version: "1.0.0", status: "pass", metrics: { detail: 1 }, violations: [], artifacts: [] };
    }
  };
  const testCampaign: Campaign = {
    ...campaign(projectRoot),
    id: "tournament-contract",
    requires: [],
    parameters: {
      tournament: {
        workspace: "test.workspace",
        agents: ["test.agent"],
        evaluators: [{ id: "test.expensive", cost: 100 }, { id: "test.cheap", cost: 1 }],
        candidateCount: 3,
        concurrency: 2
      }
    },
    budget: { maximumExperiments: 3 }
  };
  const capabilities = new Map<string, unknown>([
    ["workspace:test.workspace", workspace],
    ["agent:test.agent", agent],
    ["evaluator:test.cheap", cheap],
    ["evaluator:test.expensive", expensive]
  ]);
  const context: WorkflowContext = {
    campaign: testCampaign,
    signal: new AbortController().signal,
    startedAt: new Date().toISOString(),
    get: <T>(kind: Parameters<WorkflowContext["get"]>[0], id: string) => {
      const value = capabilities.get(`${kind}:${id}`);
      if (!value) throw new Error(`Missing test capability ${kind}:${id}`);
      return value as T;
    },
    getAll: <T>() => [...capabilities.values()] as T[],
    appendRecord: async (record) => { records.push(record); },
    readRecords: async () => [],
    preserveArtifacts: async (artifacts) => artifacts,
    emit: async () => undefined,
    budget: new BudgetController(testCampaign.budget),
    logger: new MemoryLogger()
  };

  try {
    const result = await new TournamentWorkflow().run(context);
    assert.equal(result.status, "budget-exhausted");
    assert.equal(maximumActiveAgents, 2);
    assert.equal(maximumActiveFinalizations, 1);
    assert.deepEqual(expensiveCalls, ["baseline", "tournament-r0001-c001"]);
    assert.deepEqual(accepted, ["tournament-r0001-c001"]);
    assert.deepEqual(discarded.sort(), ["tournament-r0001-c002", "tournament-r0001-c003"]);
    assert.deepEqual(records.map((record) => record.status), ["baseline", "discard", "crash", "keep"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
