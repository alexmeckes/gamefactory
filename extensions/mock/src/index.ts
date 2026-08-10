import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentDriver, Campaign, Candidate, Evaluation, Evaluator, WorkspaceDriver } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

const BASELINE = ".factory/mock-baseline.json";
const CANDIDATES = ".factory/mock-candidates";
const PROPOSAL = ".factory-candidate.json";

async function readScore(path: string, fallback = 0.5): Promise<number> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { score?: unknown };
    return typeof value.score === "number" ? value.score : fallback;
  } catch {
    return fallback;
  }
}

export class MockWorkspace implements WorkspaceDriver {
  readonly id = "mock.workspace";

  async createCandidate({ campaign, experimentId }: { campaign: Campaign; experimentId: string; signal: AbortSignal }): Promise<Candidate> {
    const root = resolve(campaign.projectRoot, CANDIDATES, experimentId);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    return { id: experimentId, root, metadata: { isolated: true } };
  }

  async acceptCandidate({ campaign, candidate }: { campaign: Campaign; candidate: Candidate; signal: AbortSignal }): Promise<{ revision?: string; changed?: boolean }> {
    const score = await readScore(resolve(candidate.root, PROPOSAL));
    const path = resolve(campaign.projectRoot, BASELINE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ score }, null, 2)}\n`, "utf8");
    await rm(candidate.root, { recursive: true, force: true });
    return { revision: `mock-${candidate.id}`, changed: true };
  }

  async discardCandidate({ candidate }: { campaign: Campaign; candidate: Candidate; signal: AbortSignal }): Promise<void> {
    await rm(candidate.root, { recursive: true, force: true });
  }
}

export class MockAgent implements AgentDriver {
  readonly id = "mock.agent";

  async run(request: Parameters<AgentDriver["run"]>[0]) {
    const baseline = await readScore(resolve(request.campaign.projectRoot, BASELINE));
    const number = request.history.filter((item) => item.status !== "baseline").length + 1;
    const delta = number % 3 === 0 ? -0.02 : 0.05;
    const score = Number((baseline + delta).toFixed(4));
    await writeFile(resolve(request.candidate.root, PROPOSAL), `${JSON.stringify({ score, delta }, null, 2)}\n`, "utf8");
    return { summary: `Proposed deterministic score ${score}.`, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } };
  }
}

export class MockEvaluator implements Evaluator {
  readonly id = "mock.score";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const score = input.candidate
      ? await readScore(resolve(input.candidate.root, PROPOSAL))
      : await readScore(resolve(input.campaign.projectRoot, BASELINE));
    return { evaluator: this.id, version: this.version, status: "pass", metrics: { score }, violations: [], artifacts: [], confidence: 1, summary: `score=${score}` };
  }
}

export default defineExtension((api) => combineDisposables(
  api.register("workspace", "mock.workspace", new MockWorkspace()),
  api.register("agent", "mock.agent", new MockAgent()),
  api.register("evaluator", "mock.score", new MockEvaluator())
));
