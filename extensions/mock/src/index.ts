import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { CandidateInvalidatedError, InfrastructureFailureError } from "@gamefactory/core";
import type { AgentDriver, Campaign, Candidate, Evaluation, Evaluator, WorkspaceDriver } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

const BASELINE = ".factory/mock-baseline.json";
const CANDIDATES = ".factory/mock-candidates";
const PROPOSAL = ".factory-candidate.json";
const DECISIONS = ".factory/mock-workspace-decisions";

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

  async acceptCandidate({ campaign, candidate, operationId }: Parameters<WorkspaceDriver["acceptCandidate"]>[0]): Promise<{ revision?: string; changed?: boolean }> {
    const key = createHash("sha256").update(operationId ?? `${campaign.id}/${candidate.id}/${candidate.root}`).digest("hex");
    const decisionPath = resolve(campaign.projectRoot, DECISIONS, `${key}.json`);
    let stored: { score: number; revision: string; applied: boolean } | undefined;
    try {
      stored = JSON.parse(await readFile(decisionPath, "utf8")) as typeof stored;
    } catch {
      stored = undefined;
    }
    if (stored?.applied) return { revision: stored.revision, changed: true };
    const score = stored?.score ?? await readScore(resolve(candidate.root, PROPOSAL));
    const revision = stored?.revision ?? `mock-${candidate.id}`;
    await mkdir(dirname(decisionPath), { recursive: true });
    await writeFile(decisionPath, `${JSON.stringify({ score, revision, applied: false })}\n`, "utf8");
    const path = resolve(campaign.projectRoot, BASELINE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ score }, null, 2)}\n`, "utf8");
    await writeFile(decisionPath, `${JSON.stringify({ score, revision, applied: true })}\n`, "utf8");
    await rm(candidate.root, { recursive: true, force: true });
    return { revision, changed: true };
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
    if (request.campaign.parameters?.mockInfrastructureFailure === true) {
      const marker = resolve(request.candidate.root, ".factory-infrastructure-retry");
      try {
        await readFile(marker, "utf8");
      } catch {
        await writeFile(marker, "retry\n", "utf8");
        throw new InfrastructureFailureError("Simulated recoverable adapter failure");
      }
    }
    if (request.campaign.parameters?.mockCandidateInvalidation === true) {
      const marker = resolve(request.candidate.root, ".factory-validation-retry");
      try {
        await readFile(marker, "utf8");
      } catch {
        await writeFile(marker, "repair required\n", "utf8");
        throw new CandidateInvalidatedError("Simulated evidence-backed candidate invalidation");
      }
    }
    if (request.campaign.parameters?.mockProjectDisposition === true) {
      const evidencePath = resolve(request.candidate.root, "spec-amendment-evidence.json");
      await writeFile(evidencePath, `${JSON.stringify({ claimId: "loop.first-errand", observation: "The preserved loop is inert." })}\n`, "utf8");
      const error = new CandidateInvalidatedError("Simulated evidence-backed spec amendment");
      Object.assign(error, {
        projectDisposition: { kind: "spec-amendment", rationale: "The preserved loop is inert.", claimIds: ["loop.first-errand"], evidenceReferences: ["spec-amendment-evidence.json"] },
        artifacts: [{ kind: "test-report", path: evidencePath, mediaType: "application/json", label: "Spec amendment evidence" }],
        provenance: { contributor: "mock.agent" }
      });
      throw error;
    }
    return { summary: `Proposed deterministic score ${score}.`, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } };
  }
}

export class MockEvaluator implements Evaluator {
  readonly id = "mock.score";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    if (!input.candidate && input.campaign.parameters?.mockMissingBaselineMetric === true) {
      return { evaluator: this.id, version: this.version, status: "inconclusive", metrics: {}, violations: [{ code: "mock.no-candidate", message: "This creation campaign has no candidate at baseline.", severity: "warning" }], artifacts: [], confidence: 1, summary: "No candidate exists yet." };
    }
    const score = input.candidate
      ? await readScore(resolve(input.candidate.root, PROPOSAL))
      : await readScore(resolve(input.campaign.projectRoot, BASELINE));
    const missingArtifact = input.candidate && input.campaign.parameters?.mockMissingArtifact === true
      ? [{ kind: "log" as const, path: resolve(input.candidate.root, "missing-evidence.log"), label: "Deliberately missing evidence" }]
      : [];
    return { evaluator: this.id, version: this.version, status: "pass", metrics: { score }, violations: [], artifacts: missingArtifact, confidence: 1, summary: `score=${score}` };
  }
}

export default defineExtension((api) => combineDisposables(
  api.register("workspace", "mock.workspace", new MockWorkspace()),
  api.register("agent", "mock.agent", new MockAgent()),
  api.register("evaluator", "mock.score", new MockEvaluator())
));
