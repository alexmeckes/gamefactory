import { decideAcceptance, flattenMetrics, isCandidateInvalidation, isInfrastructureFailure, shouldRetainCandidate } from "@gamefactory/core";
import type { AgentDriver, ArtifactReference, CampaignResult, ExperimentRecord, Workflow, WorkflowContext, WorkspaceDriver } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";
import {
  agentJournalData,
  agentFinalizationJournalData,
  applyWorkspaceDecision,
  campaignResult,
  evaluateWaterfall,
  failureAgentResult,
  finalizeAgentDecision,
  isArtifactPreservationFailure,
  journalPhase,
  latestAcceptedEvaluations,
  preserveAgentResult,
  recoverWorkflow,
  replayBudget,
  workspaceDecisionOperationId
} from "@gamefactory/workflow-sdk";

interface LoopParameters {
  workspace: string;
  agent: string;
  evaluators: string[];
  stopAfterAccepted: boolean;
}

function parameters(context: WorkflowContext): LoopParameters {
  const value = context.campaign.parameters ?? {};
  const rawSettings = value.autoresearch;
  if (rawSettings !== undefined && (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings))) throw new Error("parameters.autoresearch must be an object");
  const settings = rawSettings as Record<string, unknown> | undefined;
  if (settings?.stopAfterAccepted !== undefined && typeof settings.stopAfterAccepted !== "boolean") throw new Error("parameters.autoresearch.stopAfterAccepted must be a boolean");
  const workspace = typeof value.workspace === "string" ? value.workspace : "mock.workspace";
  const agent = typeof value.agent === "string" ? value.agent : "mock.agent";
  const evaluators = Array.isArray(value.evaluators) && value.evaluators.every((item) => typeof item === "string")
    ? value.evaluators
    : ["mock.score"];
  return { workspace, agent, evaluators, stopAfterAccepted: settings?.stopAfterAccepted === true };
}

function dispositionEvidenceHashes(disposition: Record<string, unknown>, artifacts: ArtifactReference[]): string[] {
  const references = Array.isArray(disposition.evidenceReferences)
    ? disposition.evidenceReferences.filter((reference): reference is string => typeof reference === "string" && reference.trim().length > 0)
    : [];
  const normalized = references.map((reference) => reference.replaceAll("\\", "/").toLowerCase());
  return [...new Set(artifacts.flatMap((artifact) => {
    if (!artifact.sha256) return [];
    if (normalized.includes(artifact.sha256.toLowerCase())) return [artifact.sha256];
    const source = typeof artifact.metadata?.sourcePath === "string" ? artifact.metadata.sourcePath.replaceAll("\\", "/").toLowerCase() : "";
    const sourceName = typeof artifact.metadata?.sourceName === "string" ? artifact.metadata.sourceName.toLowerCase() : "";
    const label = artifact.label?.toLowerCase() ?? "";
    return normalized.some((reference) => source.endsWith(reference) || sourceName === reference || label === reference) ? [artifact.sha256] : [];
  }))];
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
    if (recovery.resumableCandidates.length > 1) {
      return campaignResult(context, experiments, "blocked", `Autoresearch found multiple retained candidates (${recovery.resumableCandidates.map((item) => item.sourceExperimentId).join(", ")}); refusing to choose one implicitly.`);
    }
    replayBudget(context, experiments);
    let resumable = recovery.resumableCandidates[0];
    let baseline = latestAcceptedEvaluations(experiments);
    const resumedBaseline = [...experiments].reverse().find((record) => record.status === "baseline" && record.evaluations.length > 0);
    const resumedMetadata = resumedBaseline?.metadata?.autoresearch;
    let baselineError = resumedMetadata && typeof resumedMetadata === "object" && !Array.isArray(resumedMetadata) && typeof (resumedMetadata as Record<string, unknown>).baselineError === "string"
      ? (resumedMetadata as Record<string, unknown>).baselineError as string
      : undefined;

    if (!baseline) {
      const startedAt = new Date().toISOString();
      await journalPhase(context, "baseline", "reserved", { startedAt });
      let baselineRun;
      try {
        baselineRun = await evaluateWaterfall(
          context,
          config.evaluators.map((id, order) => ({ id, cost: order, order })),
          null,
          "baseline"
        );
      } catch (error) {
        if (!isInfrastructureFailure(error)) throw error;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId: "baseline",
          startedAt,
          finishedAt: new Date().toISOString(),
          status: "blocked",
          summary: error instanceof Error ? error.message : String(error),
          metrics: {},
          evaluations: [],
          metadata: { failureClass: "infrastructure", autoresearch: { baselineError: error instanceof Error ? error.message : String(error) } }
        };
        experiments.push(record);
        await context.appendRecord(record);
        await journalPhase(context, "baseline", "blocked", { record, candidateRetained: false, resumable: false, failureClass: "infrastructure" });
        await journalPhase(context, "baseline", "cleaned", { retryableBaselineInfrastructureFailure: true });
        return campaignResult(context, experiments, "blocked", record.summary);
      }
      baseline = baselineRun.evaluations;
      baselineError = baselineRun.error;
      await journalPhase(context, "baseline", "evaluated", { evaluations: baseline });
      const record: ExperimentRecord = {
        campaignId: context.campaign.id,
        experimentId: "baseline",
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "baseline",
        summary: baselineError ? `Baseline evaluation crashed: ${baselineError}` : "Measured the starting revision.",
        metrics: flattenMetrics(baseline),
        evaluations: baseline,
        ...(baselineError ? { metadata: { autoresearch: { baselineError } } } : {})
      };
      experiments.push(record);
      await context.appendRecord(record);
      await journalPhase(context, "baseline", "recorded", { record });
      await journalPhase(context, "baseline", "cleaned");
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }

    if (baselineError) return campaignResult(context, experiments, "blocked", `Baseline evaluation crashed: ${baselineError}`);
    if (config.stopAfterAccepted) {
      const accepted = [...experiments].reverse().find((record) => record.status === "keep");
      if (accepted) return campaignResult(context, experiments, "complete", `Accepted ${accepted.experimentId}; completion policy stops after the first durable accepted revision.`);
    }

    while (!context.signal.aborted) {
      const allowance = context.budget.canStart();
      if (!allowance.allowed) return campaignResult(context, experiments, "budget-exhausted", allowance.reason ?? "Budget exhausted.");
      const nextNumber = experiments.reduce((maximum, record) => {
        const metadataLogicalId = typeof record.metadata?.logicalExperimentId === "string" ? record.metadata.logicalExperimentId : record.experimentId;
        const match = /^exp-(\d+)$/.exec(metadataLogicalId);
        return Math.max(maximum, match ? Number(match[1]) : 0);
      }, 0) + 1;
      const logicalExperimentId = resumable?.logicalExperimentId ?? `exp-${String(nextNumber).padStart(4, "0")}`;
      const attemptNumber = resumable ? resumable.attemptNumber + 1 : 1;
      const experimentId = attemptNumber === 1 ? logicalExperimentId : `${logicalExperimentId}-attempt-${String(attemptNumber).padStart(4, "0")}`;
      const reservation = context.budget.tryReserve({ experimentId });
      if (!reservation) return campaignResult(context, experiments, "budget-exhausted", "Unable to reserve the next experiment within budget.");
      const attemptStartedAt = new Date().toISOString();
      const startedAt = resumable?.startedAt ?? attemptStartedAt;
      if (resumable) {
        await journalPhase(context, resumable.sourceExperimentId, "cleaned", { resumedAs: experimentId, candidateRetained: true });
      }
      await journalPhase(context, experimentId, "reserved", { startedAt, logicalExperimentId, attemptNumber, attemptStartedAt, ...(resumable ? { resumedInfrastructureCandidate: true, resumedAt: attemptStartedAt, resumedFrom: resumable.sourceExperimentId } : {}) });
      await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId, at: attemptStartedAt });
      let candidate: Awaited<ReturnType<WorkspaceDriver["createCandidate"]>> | undefined = resumable?.candidate;
      const resumedFromExperimentId = resumable?.sourceExperimentId;
      resumable = undefined;
      let finalizationStarted = false;
      let appliedRecord: ExperimentRecord | undefined;

      try {
        candidate ??= await workspace.createCandidate({ campaign: context.campaign, experimentId, signal: context.signal, ...(context.runtime ? { runtime: context.runtime } : {}) });
        await journalPhase(context, experimentId, "candidate-created", { candidate });
        const agentRequest = {
          campaign: context.campaign,
          candidate,
          experimentId,
          logicalExperimentId,
          attemptNumber,
          ...(resumedFromExperimentId ? { resumedFromExperimentId } : {}),
          history: [...experiments],
          ...(context.runtime ? { runtime: context.runtime } : {}),
          signal: context.signal,
          ...(context.trace ? { trace: context.trace } : {})
        };
        const agentResult = await preserveAgentResult(context, await agent.run(agentRequest), experimentId);
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
        const finalizationReason = accepted
          ? "candidate-accepted"
          : `candidate-rejected:${evaluations.filter((evaluation) => evaluation.status !== "pass").map((evaluation) => evaluation.evaluator).join(",") || "acceptance"}`;
        const operationId = workspaceDecisionOperationId(context, experimentId, candidate);
        await journalPhase(context, experimentId, "acceptance-intent", {
          action: accepted ? "accept" : "discard",
          operationId,
          decision,
          recoveryMetadata: {
            logicalExperimentId,
            attemptNumber,
            attemptStartedAt,
            decision,
            ...(agentResult.metadata ? { agent: agentResult.metadata } : {})
          },
          finalization: agentFinalizationJournalData({ agent, request: agentRequest, result: agentResult, evaluations, accepted, reason: finalizationReason })
        });
        finalizationStarted = true;
        let acceptance: Awaited<ReturnType<WorkspaceDriver["acceptCandidate"]>> | Record<string, never>;
        if (accepted) {
          acceptance = await applyWorkspaceDecision(context, workspace, experimentId, { action: "accept", candidate, operationId });
          await finalizeAgentDecision(context, experimentId, {
            agent,
            request: agentRequest,
            result: agentResult,
            evaluations,
            accepted: true,
            reason: acceptance.changed === false ? "candidate-accepted-no-change" : "candidate-accepted"
          });
        } else {
          acceptance = await applyWorkspaceDecision(context, workspace, experimentId, { action: "discard", candidate, operationId });
          await finalizeAgentDecision(context, experimentId, { agent, request: agentRequest, result: agentResult, evaluations, accepted: false, reason: finalizationReason });
        }
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: accepted ? "keep" : "discard",
          candidateId: candidate.id,
          ...(acceptance.revision ? { revision: acceptance.revision } : {}),
          summary: `${agentResult.summary} ${acceptance.changed === false ? "The current revision already satisfies the accepted evidence contract." : decision.reason}`,
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
            logicalExperimentId,
            attemptNumber,
            attemptStartedAt,
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
        if (accepted && config.stopAfterAccepted) return campaignResult(context, experiments, "complete", `Accepted ${experimentId}; completion policy stops after the first durable accepted revision.`);
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
        const originalCandidateInvalidation = isCandidateInvalidation(error);
        const retainCandidate = shouldRetainCandidate(error);
        const preservationBlocked = isArtifactPreservationFailure(failure);
        let cleanupBlocked = false;
        if (candidate && !retainCandidate && !preservationBlocked && !finalizationStarted) {
          try {
            await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal });
          } catch (cleanupError) {
            failure = cleanupError;
            cleanupBlocked = true;
          }
        }
        const blocked = retainCandidate || preservationBlocked || finalizationStarted || cleanupBlocked;
        const failureClass = originalCandidateInvalidation
          ? "validation" as const
          : blocked
            ? "infrastructure" as const
            : "execution" as const;
        const cancelled = context.signal.aborted;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: blocked ? "blocked" : cancelled ? "cancelled" : "crash",
          ...(candidate ? { candidateId: candidate.id } : {}),
          summary: `${failure instanceof Error ? failure.message : String(failure)}${blocked ? originalCandidateInvalidation ? " Candidate invalidated and retained only as a repair base; invalidated checkpoints cannot be promoted unchanged." : " Candidate state retained for infrastructure recovery; completed node checkpoints remain reusable." : ""}`,
          metrics: {},
          evaluations: [],
          ...(preservedFailure?.artifacts?.length ? {
            agent: { summary: preservedFailure.summary, contributors: [], artifacts: preservedFailure.artifacts }
          } : {}),
          metadata: {
            logicalExperimentId,
            attemptNumber,
            attemptStartedAt,
            failureClass,
            resumable: blocked && Boolean(candidate),
            ...(preservedFailure?.metadata?.projectDisposition && typeof preservedFailure.metadata.projectDisposition === "object" && !Array.isArray(preservedFailure.metadata.projectDisposition)
              ? {
                  projectDisposition: {
                    ...(preservedFailure.metadata.projectDisposition as Record<string, unknown>),
                    evidenceArtifactSha256: dispositionEvidenceHashes(preservedFailure.metadata.projectDisposition as Record<string, unknown>, preservedFailure.artifacts ?? [])
                  }
                }
              : {}),
            ...(preservedFailure?.metadata ? { agent: preservedFailure.metadata } : {})
          }
        };
        experiments.push(record);
        if (blocked && failureClass === "infrastructure") reservation.cancel();
        else if (blocked) reservation.settle({ status: record.status });
        else reservation.settle({ status: record.status });
        await context.appendRecord(record);
        if (blocked) {
          await journalPhase(context, experimentId, "blocked", { record, candidateRetained: Boolean(candidate), failureClass, resumable: Boolean(candidate) });
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
