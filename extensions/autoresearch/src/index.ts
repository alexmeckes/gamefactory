import { decideAcceptance, flattenMetrics } from "@gamefactory/core";
import type { AgentDriver, CampaignResult, Evaluation, Evaluator, ExperimentRecord, Workflow, WorkflowContext, WorkspaceDriver } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

interface LoopParameters {
  workspace: string;
  agent: string;
  evaluators: string[];
}

function parameters(context: WorkflowContext): LoopParameters {
  const value = context.campaign.parameters ?? {};
  const workspace = typeof value.workspace === "string" ? value.workspace : "mock.workspace";
  const agent = typeof value.agent === "string" ? value.agent : "mock.agent";
  const evaluators = Array.isArray(value.evaluators) && value.evaluators.every((item) => typeof item === "string")
    ? value.evaluators
    : ["mock.score"];
  return { workspace, agent, evaluators };
}

async function evaluateAll(context: WorkflowContext, evaluatorIds: string[], candidate: Parameters<Evaluator["evaluate"]>[0]["candidate"], experimentId: string): Promise<Evaluation[]> {
  const evaluations: Evaluation[] = [];
  for (const id of evaluatorIds) {
    const evaluator = context.get<Evaluator>("evaluator", id);
    evaluations.push(await evaluator.evaluate({ campaign: context.campaign, candidate, experimentId, priorEvaluations: evaluations, signal: context.signal }));
    if (evaluations.at(-1)?.status === "fail") break;
  }
  return evaluations;
}

async function preserveEvaluations(context: WorkflowContext, evaluations: Evaluation[], namespace: string): Promise<Evaluation[]> {
  return Promise.all(evaluations.map(async (evaluation) => ({
    ...evaluation,
    artifacts: await context.preserveArtifacts(evaluation.artifacts, `${namespace}/evaluator-${evaluation.evaluator}`)
  })));
}

function campaignResult(context: WorkflowContext, experiments: ExperimentRecord[], status: CampaignResult["status"], summary: string): CampaignResult {
  const kept = experiments.filter((record) => record.status === "baseline" || record.status === "keep");
  return {
    campaignId: context.campaign.id,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    experiments,
    bestMetrics: kept.at(-1)?.metrics ?? {},
    summary
  };
}

export class AutoresearchWorkflow implements Workflow {
  readonly id = "autoresearch";

  async run(context: WorkflowContext): Promise<CampaignResult> {
    const config = parameters(context);
    const workspace = context.get<WorkspaceDriver>("workspace", config.workspace);
    const agent = context.get<AgentDriver>("agent", config.agent);
    const experiments = await context.readRecords();
    for (const experiment of experiments) context.budget.record({ status: experiment.status, ...(experiment.usage?.costUsd !== undefined ? { costUsd: experiment.usage.costUsd } : {}) });
    let baseline = experiments.filter((item) => item.status === "baseline" || item.status === "keep").at(-1)?.evaluations;

    if (!baseline) {
      const startedAt = new Date().toISOString();
      baseline = await preserveEvaluations(context, await evaluateAll(context, config.evaluators, null, "baseline"), "baseline");
      const record: ExperimentRecord = {
        campaignId: context.campaign.id,
        experimentId: "baseline",
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "baseline",
        summary: "Measured the starting revision.",
        metrics: flattenMetrics(baseline),
        evaluations: baseline
      };
      experiments.push(record);
      await context.appendRecord(record);
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }

    const baselineMetrics = flattenMetrics(baseline);
    if (baseline.some((evaluation) => evaluation.status === "fail") || baselineMetrics[context.campaign.acceptance.primaryMetric] === undefined) {
      return campaignResult(context, experiments, "blocked", `Baseline did not pass or produce ${context.campaign.acceptance.primaryMetric}.`);
    }

    while (!context.signal.aborted) {
      const allowance = context.budget.canStart();
      if (!allowance.allowed) return campaignResult(context, experiments, "budget-exhausted", allowance.reason ?? "Budget exhausted.");
      const experimentId = `exp-${String(context.budget.experiments + 1).padStart(4, "0")}`;
      const startedAt = new Date().toISOString();
      await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId, at: startedAt });
      let candidate: Awaited<ReturnType<WorkspaceDriver["createCandidate"]>> | undefined;

      try {
        candidate = await workspace.createCandidate({ campaign: context.campaign, experimentId, signal: context.signal });
        const rawAgentResult = await agent.run({ campaign: context.campaign, candidate, experimentId, history: [...experiments], signal: context.signal });
        const agentResult = {
          ...rawAgentResult,
          ...(rawAgentResult.artifacts ? { artifacts: await context.preserveArtifacts(rawAgentResult.artifacts, `${experimentId}/agent`) } : {}),
          ...(rawAgentResult.contributors ? {
            contributors: await Promise.all(rawAgentResult.contributors.map(async (contributor) => ({
              ...contributor,
              artifacts: await context.preserveArtifacts(contributor.artifacts, `${experimentId}/agent-${contributor.agentId}`)
            })))
          } : {})
        };
        const evaluations = await preserveEvaluations(context, await evaluateAll(context, config.evaluators, candidate, experimentId), experimentId);
        const decision = decideAcceptance(context.campaign.acceptance, baseline, evaluations);
        let accepted = decision.accepted;
        const acceptance = accepted
          ? await workspace.acceptCandidate({ campaign: context.campaign, candidate, signal: context.signal })
          : (await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: context.signal }), {});
        if (acceptance.changed === false) accepted = false;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: accepted ? "keep" : "discard",
          candidateId: candidate.id,
          ...(acceptance.revision ? { revision: acceptance.revision } : {}),
          summary: `${agentResult.summary} ${acceptance.changed === false ? "Candidate produced no meaningful change." : decision.reason}`,
          metrics: flattenMetrics(evaluations),
          evaluations,
          ...((agentResult.contributors?.length ?? 0) > 0 || (agentResult.artifacts?.length ?? 0) > 0 ? {
            agent: {
              summary: agentResult.summary,
              contributors: agentResult.contributors ?? [],
              artifacts: agentResult.artifacts ?? []
            }
          } : {}),
          ...(agentResult.usage ? { usage: agentResult.usage } : {}),
          metadata: {
            decision,
            ...(acceptance.candidateRevision ? { candidateRevision: acceptance.candidateRevision } : {}),
            ...(agentResult.metadata ? { agent: agentResult.metadata } : {})
          }
        };
        if (accepted) baseline = evaluations;
        experiments.push(record);
        context.budget.record({ status: record.status, ...(agentResult.usage?.costUsd !== undefined ? { costUsd: agentResult.usage.costUsd } : {}) });
        await context.appendRecord(record);
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
      } catch (error) {
        if (candidate) await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: context.signal }).catch(() => undefined);
        const cancelled = context.signal.aborted;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: cancelled ? "cancelled" : "crash",
          ...(candidate ? { candidateId: candidate.id } : {}),
          summary: error instanceof Error ? error.message : String(error),
          metrics: {},
          evaluations: []
        };
        experiments.push(record);
        context.budget.record({ status: record.status });
        await context.appendRecord(record);
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
        if (cancelled) {
          const reason = context.signal.reason instanceof Error ? context.signal.reason.message : String(context.signal.reason ?? "");
          return campaignResult(
            context,
            experiments,
            reason.includes("wall-time budget") ? "budget-exhausted" : "cancelled",
            reason.includes("wall-time budget") ? "Wall-time budget reached; the active candidate was cleaned up." : "Campaign was cancelled and the active candidate was cleaned up."
          );
        }
      }
    }
    return campaignResult(context, experiments, "cancelled", "Campaign was cancelled.");
  }
}

export default defineExtension((api) => api.register("workflow", "autoresearch", new AutoresearchWorkflow()));
