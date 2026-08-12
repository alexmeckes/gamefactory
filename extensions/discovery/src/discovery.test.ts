import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { BudgetController, type AgentDriver, type Campaign, type Evaluator, type ExperimentRecord, type WorkflowContext, type WorkspaceDriver } from "@gamefactory/core";
import { DiscoveryWorkflow } from "./index.js";

const run = promisify(execFile);

test("discovery ranks divergent prototypes but defaults to recommendation without acceptance", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-discovery-"));
  try {
    await run("git", ["init"], { cwd: root, windowsHide: true });
    await writeFile(resolve(root, "baseline.txt"), "baseline\n", "utf8");
    await run("git", ["add", "baseline.txt"], { cwd: root, windowsHide: true });
    await run("git", ["-c", "user.name=GameFactory Test", "-c", "user.email=test@gamefactory.local", "commit", "-m", "baseline"], { cwd: root, windowsHide: true });
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "discovery-test",
      objective: "compare prototypes",
      projectRoot: root,
      workflow: "discovery",
      requires: [],
      parameters: {
        discovery: {
          workspace: "fixture.workspace",
          agents: ["fixture.agent"],
          evaluators: ["fixture.score"],
          prototypeCount: 3,
          shortlistCount: 2,
          concurrency: 2,
          selection: "recommend"
        }
      },
      acceptance: { primaryMetric: "learning_value", direction: "maximize" },
      budget: { maximumExperiments: 3 }
    };
    let accepted = 0;
    let discarded = 0;
    const workspace: WorkspaceDriver = {
      id: "fixture.workspace",
      async createCandidate(input) {
        const slot = Number(input.experimentId.match(/(\d+)$/)?.[1] ?? 0);
        return { id: input.experimentId, root, metadata: { slot } };
      },
      async acceptCandidate() { accepted += 1; return { changed: true }; },
      async discardCandidate() { discarded += 1; }
    };
    const agent: AgentDriver = {
      id: "fixture.agent",
      async run(input) {
        return { summary: `Explored prototype ${input.candidate.metadata.slot}` };
      }
    };
    const evaluator: Evaluator = {
      id: "fixture.score",
      version: "1",
      async evaluate(input) {
        return {
          evaluator: this.id,
          version: this.version,
          status: "pass",
          metrics: { learning_value: Number(input.candidate?.metadata.slot ?? 0) },
          violations: [],
          artifacts: []
        };
      }
    };
    const records: ExperimentRecord[] = [];
    const capabilities = new Map<string, unknown>([
      ["workspace:fixture.workspace", workspace],
      ["agent:fixture.agent", agent],
      ["evaluator:fixture.score", evaluator]
    ]);
    const context: WorkflowContext = {
      campaign,
      signal: new AbortController().signal,
      startedAt: new Date(0).toISOString(),
      get: <T>(kind: Parameters<WorkflowContext["get"]>[0], id: string) => capabilities.get(`${kind}:${id}`) as T,
      getAll: () => [],
      async appendRecord(record) { records.push(record); },
      async readRecords() { return []; },
      async preserveArtifacts(artifacts) { return artifacts; },
      async emit() {},
      budget: new BudgetController(campaign.budget),
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    };
    const result = await new DiscoveryWorkflow().run(context);
    assert.equal(result.status, "complete");
    assert.equal(result.bestMetrics.learning_value, 3);
    assert.equal(accepted, 0);
    assert.equal(discarded, 3);
    assert.equal(records.length, 3);
    assert.equal(records.find((record) => (record.metadata?.discovery as { recommended?: boolean } | undefined)?.recommended)?.experimentId, "discovery-p003");
    assert.deepEqual(records.filter((record) => (record.metadata?.discovery as { shortlisted?: boolean } | undefined)?.shortlisted).map((record) => record.experimentId), ["discovery-p002", "discovery-p003"]);
    assert.match(result.summary, /Shortlisted 2 divergent prototypes/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
