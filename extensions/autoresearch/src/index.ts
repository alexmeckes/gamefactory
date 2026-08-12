import { decideAcceptance, flattenMetrics } from "@gamefactory/core";
import type { AgentDriver, CampaignResult, ExperimentRecord, Workflow, WorkflowContext, WorkspaceDriver } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";
import {
  agentJournalData,
  campaignResult,
  evaluateWaterfall,
  failureAgentResult,
  isArtifactPreservationFailure,
  journalPhase,
  latestAcceptedEvaluations,
  preserveAgentResult,
  recoverWorkflow,
  replayBudget
} from "@gamefactory/workflow-sdk";

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

export class AutoresearchWorkflow implements Workflow {
  readonly id = "autoresearch";

  async run(context: WorkflowContext): Promise<CampaignResult> {
    const config = parameters(context);
    const workspace = context.get<WorkspaceDriver>("workspace", config.workspace);
    const agent = context.get<AgentDriver>("agent", config.agent);
    const recovery = await recoverWorkflow(context, workspace);
    const experiments = await context.readRecords();
    if (recovery.blocked) return campaignResult(context, experiments, "blocked", recovery.blocked);
    replayBudget(context, experiments);
    let baseline = latestAcceptedEvaluations(experiments);

    if (!baseline) {
      const startedAt = new Date().toISOString();
      await journalPhase(context, "baseline", "reserved", { startedAt });
      baseline = (await evaluateWaterfall(
        context,
        config.evaluators.map((id, order) => ({ id, cost: order, order })),
        null,
        "baseline"
      )).evaluations;
      await journalPhase(context, "baseline", "evaluated", { evaluations: baseline });
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
      await journalPhase(context, "baseline", "recorded", { record });
      await journalPhase(context, "baseline", "cleaned");
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }

    const baselineMetrics = flattenMetrics(baseline);
    if (baseline.some((evaluation) => evaluation.status === "fail") || baselineMetrics[context.campaign.acceptance.primaryMetric] === undefined) {
      return campaignResult(context, experiments, "blocked", `Baseline did not pass or produce ${context.campaign.acceptance.primaryMetric}.`);
    }

    while (!context.signal.aborted) {
      const allowance = context.budget.canStart();
      if (!allowance.allowed) return campaignResult(context, experiments, "budget-exhausted", allowance.reason ?? "Budget exhausted.");
      const nextNumber = experiments.reduce((maximum, record) => {
        const match = /^exp-(\d+)$/.exec(record.experimentId);
        return Math.max(maximum, match ? Number(match[1]) : 0);
      }, 0) + 1;
      const experimentId = `exp-${String(nextNumber).padStart(4, "0")}`;
      const reservation = context.budget.tryReserve({ experimentId });
      if (!reservation) return campaignResult(context, experiments, "budget-exhausted", "Unable to reserve the next experiment within budget.");
      const startedAt = new Date().toISOString();
      await journalPhase(context, experimentId, "reserved", { startedAt });
      await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId, at: startedAt });
      let candidate: Awaited<ReturnType<WorkspaceDriver["createCandidate"]>> | undefined;
      let finalizationStarted = false;
      let appliedRecord: ExperimentRecord | undefined;

      try {
        candidate = await workspace.createCandidate({ campaign: context.campaign, experimentId, signal: context.signal });
        await journalPhase(context, experimentId, "candidate-created", { candidate });
        const agentResult = await preserveAgentResult(context, await agent.run({
          campaign: context.campaign,
          candidate,
          experimentId,
          history: [...experiments],
          signal: context.signal,
          ...(context.trace ? { trace: context.trace } : {})
        }), experimentId);
        await journalPhase(context, experimentId, "agent-finished", agentJournalData(agentResult));
        const evaluations = (await evaluateWaterfall(
          context,
          config.evaluators.map((id, order) => ({ id, cost: order, order })),
          candidate,
          experimentId
        )).evaluations;
        await journalPhase(context, experimentId, "evaluated", { evaluations });
        await journalPhase(context, experimentId, "evidence-preserved");
        const decision = decideAcceptance(context.campaign.acceptance, baseline, evaluations, context.campaign.humanGates ? { humanGates: context.campaign.humanGates } : {});
        let accepted = decision.accepted;
        await journalPhase(context, experimentId, "acceptance-intent", { action: accepted ? "accept" : "discard", decision });
        finalizationStarted = true;
        const acceptance = accepted
          ? await workspace.acceptCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal })
          : (await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal }), {});
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
        await journalPhase(context, experimentId, "applied", { record });
        appliedRecord = record;
        experiments.push(record);
        reservation.settle({ status: record.status, ...(agentResult.usage?.costUsd !== undefined ? { actualCostUsd: agentResult.usage.costUsd } : {}) });
        await context.appendRecord(record);
        await journalPhase(context, experimentId, "recorded", { status: record.status });
        await journalPhase(context, experimentId, "cleaned");
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
      } catch (error) {
        if (appliedRecord) throw error;
        const failedAgent = failureAgentResult(error);
        let failure: unknown = error;
        let preservedFailure;
        try {
          preservedFailure = failedAgent ? await preserveAgentResult(context, failedAgent, experimentId) : undefined;
        } catch (preservationError) {
          failure = preservationError;
        }
        const preservationBlocked = isArtifactPreservationFailure(failure);
        let cleanupBlocked = false;
        if (candidate && !preservationBlocked && !finalizationStarted) {
          try {
            await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal });
          } catch (cleanupError) {
            failure = cleanupError;
            cleanupBlocked = true;
          }
        }
        const blocked = preservationBlocked || finalizationStarted || cleanupBlocked;
        const cancelled = context.signal.aborted;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: blocked ? "blocked" : cancelled ? "cancelled" : "crash",
          ...(candidate ? { candidateId: candidate.id } : {}),
          summary: `${failure instanceof Error ? failure.message : String(failure)}${blocked ? " Candidate state retained because evidence preservation or finalization could not be confirmed." : ""}`,
          metrics: {},
          evaluations: [],
          ...(preservedFailure?.artifacts?.length ? {
            agent: { summary: preservedFailure.summary, contributors: [], artifacts: preservedFailure.artifacts }
          } : {}),
          ...(preservedFailure?.metadata ? { metadata: { agent: preservedFailure.metadata } } : {})
        };
        experiments.push(record);
        reservation.settle({ status: record.status });
        await context.appendRecord(record);
        if (blocked) {
          await journalPhase(context, experimentId, "blocked", { record, candidateRetained: Boolean(candidate) });
        } else {
          await journalPhase(context, experimentId, "applied", { record });
          await journalPhase(context, experimentId, "recorded", { status: record.status });
          await journalPhase(context, experimentId, "cleaned");
        }
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
        if (blocked) return campaignResult(context, experiments, "blocked", record.summary);
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
