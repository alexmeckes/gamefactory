import { flattenMetrics, InfrastructureFailureError, isInfrastructureFailure } from "@gamefactory/core";
import type {
  AgentDriver,
  AgentRequest,
  AgentResult,
  ArtifactReference,
  CampaignResult,
  Candidate,
  Evaluation,
  Evaluator,
  ExperimentRecord,
  FactoryTraceEventInput,
  JournalJsonValue,
  WorkspaceDriver,
  WorkflowContext,
  WorkflowJournalPhase
} from "@gamefactory/core";

export async function emitTrace(context: WorkflowContext, event: FactoryTraceEventInput): Promise<void> {
  try {
    await context.trace?.emit(event);
  } catch (error) {
    context.logger.debug("Ignoring observational trace failure", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function traceWorkflowPhase(context: WorkflowContext, experimentId: string, phase: WorkflowJournalPhase, data?: unknown): Promise<void> {
  const nodeId = `experiment:${experimentId}`;
  if (phase === "reserved") {
    await emitTrace(context, { type: "node:created", nodeId, experimentId, parentNodeId: `campaign:${context.trace?.runId ?? context.campaign.id}`, label: experimentId, role: "experiment" });
    await emitTrace(context, { type: "edge:created", nodeId: `edge:campaign:${experimentId}`, experimentId, sourceNodeId: `campaign:${context.trace?.runId ?? context.campaign.id}`, targetNodeId: nodeId, role: "fan-out" });
    return;
  }
  if (phase === "candidate-created") {
    await emitTrace(context, { type: "node:started", nodeId, experimentId, label: experimentId, role: "experiment", message: "Candidate workspace created" });
    return;
  }
  if (phase === "blocked") {
    await emitTrace(context, { type: "node:failed", nodeId, experimentId, label: experimentId, role: "experiment", status: "blocked", message: "Experiment blocked for review" });
    return;
  }
  if (phase === "cleaned") {
    await emitTrace(context, { type: "node:completed", nodeId, experimentId, label: experimentId, role: "experiment", status: "complete", message: "Experiment finalized and cleaned" });
    return;
  }
  const details = data === undefined ? undefined : journalData(data);
  const object = details && typeof details === "object" && !Array.isArray(details) ? details : undefined;
  const action = object && typeof object.action === "string" ? object.action : undefined;
  await emitTrace(context, { type: "node:progress", nodeId, experimentId, label: experimentId, role: "experiment", message: action ? `${phase}: ${action}` : phase, data: { phase, ...(action ? { action } : {}) } });
}

export interface EvaluatorPlan {
  id: string;
  cost: number;
  order: number;
}

export interface EvaluationRun {
  evaluations: Evaluation[];
  error?: string;
}

export interface ResumableCandidate {
  sourceExperimentId: string;
  logicalExperimentId: string;
  attemptNumber: number;
  candidate: Candidate;
  startedAt: string;
  phase: WorkflowJournalPhase;
  reserved: Record<string, unknown>;
  record?: ExperimentRecord;
}

function journalData(value: unknown): JournalJsonValue {
  return JSON.parse(JSON.stringify(value)) as JournalJsonValue;
}

export async function journalPhase(
  context: WorkflowContext,
  experimentId: string,
  phase: WorkflowJournalPhase,
  data?: unknown
): Promise<void> {
  const journal = context.journal;
  if (!journal) {
    await traceWorkflowPhase(context, experimentId, phase, data);
    return;
  }
  const recovery = await journal.recover();
  const state = recovery.experiments.find((item) => item.runId === journal.runId
    && item.campaignId === context.campaign.id
    && item.experimentId === experimentId);
  const reservedCount = state?.entries.filter((entry) => entry.phase === "reserved").length ?? 0;
  const activeAttempt = Boolean(state && state.latestPhase !== "cleaned" && state.latestPhase !== "blocked");
  const attempt = phase === "reserved" && !activeAttempt ? reservedCount + 1 : Math.max(1, reservedCount);
  let lastReservedIndex = -1;
  for (let index = 0; index < (state?.entries.length ?? 0); index += 1) {
    if (state?.entries[index]?.phase === "reserved") lastReservedIndex = index;
  }
  const attemptEntries = state?.entries.slice(lastReservedIndex) ?? [];
  const existing = phase === "reserved"
    ? activeAttempt ? attemptEntries.find((entry) => entry.phase === "reserved") : undefined
    : attemptEntries.find((entry) => entry.phase === phase);
  if (existing) return;
  await journal.append({
    experimentId,
    phase,
    idempotencyKey: `${journal.runId}:${experimentId}:attempt-${attempt}:${phase}`,
    ...(data === undefined ? {} : { data: journalData(data) })
  });
  await traceWorkflowPhase(context, experimentId, phase, data);
}

export function agentJournalData(result: AgentResult): Record<string, unknown> {
  return {
    summary: result.summary,
    usage: result.usage ?? null,
    artifactCount: result.artifacts?.length ?? 0,
    metadata: result.metadata ?? null,
    contributors: (result.contributors ?? []).map((contributor) => ({
      agentId: contributor.agentId,
      role: contributor.role,
      status: contributor.status,
      startedAt: contributor.startedAt,
      finishedAt: contributor.finishedAt,
      summary: contributor.summary,
      artifactCount: contributor.artifacts.length,
      ...(contributor.invocationId ? { invocationId: contributor.invocationId } : {}),
      ...(contributor.parentInvocationId ? { parentInvocationId: contributor.parentInvocationId } : {}),
      ...(contributor.usage ? { usage: contributor.usage } : {})
    }))
  };
}

export function agentFinalizationJournalData(input: {
  agent: AgentDriver;
  request: AgentRequest;
  result: AgentResult;
  evaluations: Evaluation[];
  accepted: boolean;
  reason: string;
}): Record<string, unknown> {
  return {
    agentId: input.agent.id,
    candidate: input.request.candidate,
    accepted: input.accepted,
    reason: input.reason,
    evaluations: input.evaluations,
    result: input.result
  };
}

/** Journal and execute a driver finalization decision as one recoverable protocol. */
export async function finalizeAgentDecision(
  context: WorkflowContext,
  experimentId: string,
  input: {
    agent: AgentDriver;
    request: AgentRequest;
    result: AgentResult;
    evaluations: Evaluation[];
    accepted: boolean;
    reason: string;
  }
): Promise<void> {
  await journalPhase(context, experimentId, "agent-finalization-intent", agentFinalizationJournalData(input));
  await input.agent.finalize?.({
    ...input.request,
    result: input.result,
    evaluations: input.evaluations,
    accepted: input.accepted,
    reason: input.reason
  });
  await journalPhase(context, experimentId, "agent-finalized", {
    agentId: input.agent.id,
    accepted: input.accepted,
    reason: input.reason
  });
}

export function workspaceDecisionOperationId(context: WorkflowContext, experimentId: string, candidate: Candidate): string {
  const workspaceIdentity = typeof candidate.metadata.worktreeRoot === "string" ? candidate.metadata.worktreeRoot : candidate.root;
  return `${context.journal?.runId ?? context.campaign.id}:${experimentId}:${candidate.id}:${candidate.baseRevision ?? "unversioned"}:${workspaceIdentity}:workspace-decision`;
}

/** Apply and durably acknowledge one idempotent workspace decision. */
export async function applyWorkspaceDecision(
  context: WorkflowContext,
  workspace: WorkspaceDriver,
  experimentId: string,
  input: { action: "accept" | "discard"; candidate: Candidate; operationId: string; signal?: AbortSignal }
): Promise<{ revision?: string; candidateRevision?: string; changed?: boolean }> {
  const signal = input.signal ?? new AbortController().signal;
  const result: { revision?: string; candidateRevision?: string; changed?: boolean } = input.action === "accept"
    ? await workspace.acceptCandidate({ campaign: context.campaign, candidate: input.candidate, signal, operationId: input.operationId })
    : await workspace.discardCandidate({ campaign: context.campaign, candidate: input.candidate, signal, operationId: input.operationId }).then(() => ({}));
  if (input.action === "accept" && result.changed === false && !result.revision && input.candidate.baseRevision) {
    result.revision = input.candidate.baseRevision;
  }
  await journalPhase(context, experimentId, "workspace-applied", {
    action: input.action,
    operationId: input.operationId,
    result
  });
  if (input.action === "accept" && result.changed === false) {
    await workspace.discardCandidate({ campaign: context.campaign, candidate: input.candidate, signal, operationId: input.operationId });
  }
  return result;
}

function recoveredDecisionRecord(
  context: WorkflowContext,
  experimentId: string,
  candidate: Candidate,
  finalization: Record<string, unknown>,
  workspaceResult: Record<string, unknown>,
  startedAt: string,
  recoveryMetadata: Record<string, unknown>,
  recoveryArtifacts: ArtifactReference[]
): ExperimentRecord | undefined {
  const result = asObject(finalization.result) as unknown as AgentResult;
  const evaluations = Array.isArray(finalization.evaluations) ? finalization.evaluations as Evaluation[] : undefined;
  if (typeof result.summary !== "string" || !evaluations) return undefined;
  const accepted = finalization.accepted === true;
  const candidateRevision = typeof workspaceResult.candidateRevision === "string" ? workspaceResult.candidateRevision : undefined;
  const artifacts = [...(result.artifacts ?? []), ...recoveryArtifacts].filter((artifact, index, all) => all.findIndex((item) => item.path === artifact.path && item.sha256 === artifact.sha256) === index);
  return {
    campaignId: context.campaign.id,
    experimentId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: accepted ? "keep" : "discard",
    candidateId: candidate.id,
    ...(typeof workspaceResult.revision === "string" ? { revision: workspaceResult.revision } : {}),
    summary: `${result.summary} Recovered durable ${accepted ? "acceptance" : "rejection"} after an interrupted decision.`,
    metrics: flattenMetrics(evaluations),
    evaluations,
    ...((result.contributors?.length ?? 0) > 0 || artifacts.length > 0 ? {
      agent: { summary: result.summary, contributors: result.contributors ?? [], artifacts }
    } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    metadata: {
      ...recoveryMetadata,
      recoveredDecision: true,
      ...(candidateRevision ? { candidateRevision } : {}),
      ...(result.metadata ? { agent: result.metadata } : {})
    }
  };
}

export async function recoverWorkflow(
  context: WorkflowContext,
  workspace: WorkspaceDriver
): Promise<{
  recoveredRecords: ExperimentRecord[];
  resumableCandidates: ResumableCandidate[];
  blocked?: string;
}> {
  const journal = context.journal;
  if (!journal) return { recoveredRecords: [], resumableCandidates: [] };
  const recovery = await journal.recover();
  const incompatible = recovery.experiments.find((item) => item.campaignId === context.campaign.id
    && (item.runId !== journal.runId
      || Object.entries(journal.fingerprints).some(([key, value]) => item.latestEntry.fingerprints[key] !== value)));
  if (incompatible) {
    return { recoveredRecords: [], resumableCandidates: [], blocked: `Campaign ${context.campaign.id} has journal state from an incompatible run or configuration.` };
  }
  const recoveredRecords: ExperimentRecord[] = [];
  const resumableCandidates: ResumableCandidate[] = [];
  const blockers: string[] = [];
  for (const state of recovery.incomplete.filter((item) => item.runId === journal.runId && item.campaignId === context.campaign.id)) {
    let lastReservedIndex = -1;
    for (let index = 0; index < state.entries.length; index += 1) {
      if (state.entries[index]?.phase === "reserved") lastReservedIndex = index;
    }
    const attemptEntries = state.entries.slice(Math.max(0, lastReservedIndex));
    const candidateEntry = attemptEntries.find((entry) => entry.phase === "candidate-created");
    const candidateData = asObject(candidateEntry?.data);
    const candidateValue = asObject(candidateData.candidate);
    const candidate = typeof candidateValue.id === "string" && typeof candidateValue.root === "string"
      ? candidateValue as unknown as Candidate
      : undefined;
    const reservedData = asObject(attemptEntries.find((entry) => entry.phase === "reserved")?.data);
    if (state.latestPhase === "blocked") {
      const blockedData = asObject(state.latestEntry.data);
      const blockedRecord = asObject(blockedData.record);
      const blockedMetadata = asObject(blockedRecord.metadata);
      if (blockedData.resumable === true
        && blockedData.candidateRetained === true
        && (blockedMetadata.failureClass === "infrastructure" || blockedMetadata.failureClass === "validation")
        && candidate
        && typeof blockedRecord.startedAt === "string") {
        const logicalExperimentId = typeof blockedMetadata.logicalExperimentId === "string"
          ? blockedMetadata.logicalExperimentId
          : state.experimentId.replace(/-attempt-\d+$/, "");
        const attemptNumber = typeof blockedMetadata.attemptNumber === "number" && Number.isSafeInteger(blockedMetadata.attemptNumber)
          ? blockedMetadata.attemptNumber
          : 1;
        resumableCandidates.push({
          sourceExperimentId: state.experimentId,
          logicalExperimentId,
          attemptNumber,
          candidate,
          startedAt: blockedRecord.startedAt,
          phase: state.latestPhase,
          reserved: reservedData,
          record: blockedRecord as unknown as ExperimentRecord
        });
        continue;
      }
      blockers.push(`Experiment ${state.experimentId} is blocked with its candidate retained for recovery.`);
      continue;
    }
    if (candidate && ["candidate-created", "agent-finished", "evaluated", "evidence-preserved"].includes(state.latestPhase)) {
      const logicalExperimentId = typeof reservedData.logicalExperimentId === "string"
        ? reservedData.logicalExperimentId
        : state.experimentId.replace(/-attempt-\d+$/, "");
      const attemptNumber = typeof reservedData.attemptNumber === "number" && Number.isSafeInteger(reservedData.attemptNumber)
        ? reservedData.attemptNumber
        : Math.max(1, attemptEntries.filter((entry) => entry.phase === "reserved").length);
      resumableCandidates.push({
        sourceExperimentId: state.experimentId,
        logicalExperimentId,
        attemptNumber,
        candidate,
        startedAt: typeof reservedData.startedAt === "string" ? reservedData.startedAt : state.latestEntry.timestamp,
        phase: state.latestPhase,
        reserved: reservedData
      });
      continue;
    }
    if (["acceptance-intent", "workspace-applied", "agent-finalization-intent", "agent-finalized"].includes(state.latestPhase)) {
      const acceptanceEntry = attemptEntries.find((entry) => entry.phase === "acceptance-intent");
      const acceptanceIntent = asObject(acceptanceEntry?.data);
      const action = acceptanceIntent.action;
      const operationId = acceptanceIntent.operationId;
      const storedFinalization = asObject(acceptanceIntent.finalization);
      const reservedData = asObject(attemptEntries.find((entry) => entry.phase === "reserved")?.data);
      if (!candidate || (action !== "accept" && action !== "discard") || typeof operationId !== "string" || Object.keys(storedFinalization).length === 0) {
        blockers.push(`Experiment ${state.experimentId} has a legacy or incomplete decision intent and requires manual reconciliation.`);
        continue;
      }
      const workspaceEntry = attemptEntries.find((entry) => entry.phase === "workspace-applied");
      const evidenceData = asObject(attemptEntries.find((entry) => entry.phase === "evidence-preserved")?.data);
      const patchArtifact = asObject(evidenceData.patch);
      const recoveryArtifacts = typeof patchArtifact.path === "string" ? [patchArtifact as unknown as ArtifactReference] : [];
      let workspaceData = asObject(workspaceEntry?.data);
      let workspaceResult = asObject(workspaceData.result);
      try {
        if (!workspaceEntry) {
          const result = await applyWorkspaceDecision(context, workspace, state.experimentId, { action, candidate, operationId });
          workspaceData = { action, operationId, result };
          workspaceResult = asObject(result);
        } else if (workspaceData.action !== action || workspaceData.operationId !== operationId) {
          throw new Error("Workspace acknowledgement does not match its decision intent");
        }
        const accepted = action === "accept";
        const reason = accepted
          ? workspaceResult.changed === false
            ? "candidate-accepted-no-change"
            : typeof storedFinalization.reason === "string" ? storedFinalization.reason : "candidate-accepted"
          : typeof storedFinalization.reason === "string" ? storedFinalization.reason : "candidate-rejected";
        const reconciledFinalization = { ...storedFinalization, accepted, reason };
        if (state.latestPhase === "agent-finalized" && asObject(state.latestEntry.data).accepted !== accepted) {
          throw new Error("Agent finalization acknowledgement does not match the applied workspace decision");
        }
        if (state.latestPhase !== "agent-finalized") {
          const agentId = storedFinalization.agentId;
          const result = storedFinalization.result as AgentResult;
          const evaluations = storedFinalization.evaluations as Evaluation[];
          if (typeof agentId !== "string" || !result || !Array.isArray(evaluations)) throw new Error("Decision intent is missing recoverable agent finalization data");
          const agent = context.get<AgentDriver>("agent", agentId);
          const request: AgentRequest = {
            campaign: context.campaign,
            candidate,
            experimentId: state.experimentId,
            history: await context.readRecords(),
            ...(context.runtime ? { runtime: context.runtime } : {}),
            signal: new AbortController().signal,
            ...(context.trace ? { trace: context.trace } : {})
          };
          await finalizeAgentDecision(context, state.experimentId, { agent, request, result, evaluations, accepted, reason });
        }
        const record = recoveredDecisionRecord(
          context,
          state.experimentId,
          candidate,
          reconciledFinalization,
          workspaceResult,
          typeof reservedData.startedAt === "string" ? reservedData.startedAt : state.latestEntry.timestamp,
          asObject(acceptanceIntent.recoveryMetadata),
          recoveryArtifacts
        );
        if (!record) throw new Error("Decision intent cannot reconstruct an experiment record");
        await journalPhase(context, state.experimentId, "applied", { record, recovered: true });
        const existing = (await context.readRecords()).some((item) => item.experimentId === record.experimentId);
        if (!existing) {
          await context.appendRecord(record);
          recoveredRecords.push(record);
        }
        await journalPhase(context, state.experimentId, "recorded", { recovered: true, status: record.status });
        if (!accepted) await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal, operationId });
        await journalPhase(context, state.experimentId, "cleaned", { recovered: true, previousPhase: state.latestPhase });
      } catch (error) {
        blockers.push(`Experiment ${state.experimentId} decision reconciliation failed closed: ${errorMessage(error)}`);
      }
      continue;
    }
    if (state.latestPhase === "applied") {
      const applied = asObject(state.latestEntry.data);
      const record = applied.record as unknown;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        blockers.push(`Experiment ${state.experimentId} was applied without a recoverable record.`);
        continue;
      }
      const recovered = record as ExperimentRecord;
      const existing = (await context.readRecords()).some((item) => item.experimentId === recovered.experimentId && item.finishedAt === recovered.finishedAt);
      if (!existing) {
        await context.appendRecord(recovered);
        recoveredRecords.push(recovered);
      }
      await journalPhase(context, state.experimentId, "recorded", { recovered: true });
    }
    if (candidate && state.latestPhase !== "applied" && state.latestPhase !== "recorded") {
      try {
        await workspace.discardCandidate({ campaign: context.campaign, candidate, signal: new AbortController().signal });
      } catch (error) {
        blockers.push(`Experiment ${state.experimentId} cleanup could not be confirmed: ${errorMessage(error)}`);
        continue;
      }
    }
    await journalPhase(context, state.experimentId, "cleaned", { recovered: true, previousPhase: state.latestPhase });
  }
  return {
    recoveredRecords,
    resumableCandidates,
    ...(blockers.length > 0 ? { blocked: blockers.join(" ") } : {})
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failureAgentResult(error: unknown): AgentResult | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { artifacts?: unknown; provenance?: unknown; projectDisposition?: unknown };
  if (!Array.isArray(value.artifacts)) return undefined;
  const artifacts = value.artifacts.filter((artifact): artifact is ArtifactReference =>
    Boolean(artifact && typeof artifact === "object" && typeof (artifact as { path?: unknown }).path === "string"));
  return {
    summary: errorMessage(error),
    artifacts,
    metadata: {
      failure: value.provenance ?? null,
      ...(value.projectDisposition && typeof value.projectDisposition === "object" && !Array.isArray(value.projectDisposition)
        ? { projectDisposition: value.projectDisposition }
        : {})
    }
  };
}

export function isArtifactPreservationFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "ArtifactPreservationError");
}

export function evaluatorPlans(value: unknown, fallbackId = "mock.score"): EvaluatorPlan[] {
  if (!Array.isArray(value)) return [{ id: fallbackId, cost: 0, order: 0 }];
  const plans: EvaluatorPlan[] = [];
  for (const [order, item] of value.entries()) {
    if (typeof item === "string" && item.length > 0) {
      plans.push({ id: item, cost: order, order });
      continue;
    }
    const entry = asObject(item);
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const cost = typeof entry.cost === "number" && Number.isFinite(entry.cost) && entry.cost >= 0
      ? entry.cost
      : order;
    plans.push({ id: entry.id, cost, order });
  }
  if (plans.length === 0) return [{ id: fallbackId, cost: 0, order: 0 }];
  return plans.sort((left, right) => left.cost - right.cost || left.order - right.order || left.id.localeCompare(right.id));
}

export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await operation(item, index);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw failure.reason;
  return results.map((item, index) => {
    if (item === undefined) throw new Error(`Worker ${index} did not produce a result.`);
    return item;
  });
}

export async function evaluateWaterfall(
  context: WorkflowContext,
  plans: readonly EvaluatorPlan[],
  candidate: Candidate | null,
  experimentId: string
): Promise<EvaluationRun> {
  const evaluations: Evaluation[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    context.signal.throwIfAborted();
    const evaluator = context.get<Evaluator>("evaluator", plan.id);
    const nodeId = `evaluator:${experimentId}:${index}-${plan.id}`;
    await emitTrace(context, { type: "node:created", nodeId, experimentId, parentNodeId: `experiment:${experimentId}`, label: plan.id, role: "evaluator", attempt: 1 });
    await emitTrace(context, { type: "edge:created", nodeId: `edge:experiment:${experimentId}:${nodeId}`, experimentId, sourceNodeId: `experiment:${experimentId}`, targetNodeId: nodeId, role: "evidence" });
    await emitTrace(context, { type: "node:started", nodeId, experimentId, label: plan.id, role: "evaluator", attempt: 1, message: `Evaluator ${index + 1} of ${plans.length}` });
    try {
      const raw = await evaluator.evaluate({
        campaign: context.campaign,
        candidate,
        experimentId,
        priorEvaluations: [...evaluations],
        signal: context.signal
      });
      const evaluation: Evaluation = {
        ...raw,
        artifacts: await context.preserveArtifacts(raw.artifacts, `${experimentId}/evaluator-${raw.evaluator}`)
      };
      if (evaluation.failureClass === "infrastructure") {
        const message = evaluation.summary ?? `${evaluation.evaluator} was unavailable`;
        await emitTrace(context, { type: "node:failed", nodeId, experimentId, label: plan.id, role: "evaluator", status: "crash", message });
        throw new InfrastructureFailureError(message, { cause: evaluation });
      }
      evaluations.push(evaluation);
      await emitTrace(context, {
        type: evaluation.status === "fail" ? "node:failed" : "node:completed",
        nodeId,
        experimentId,
        label: plan.id,
        role: "evaluator",
        status: evaluation.status,
        message: evaluation.summary ?? `${Object.keys(evaluation.metrics).length} metrics`,
        data: { metrics: evaluation.metrics, violations: evaluation.violations.length, artifacts: evaluation.artifacts.length, ...(evaluation.usage ? { usage: { ...evaluation.usage } } : {}) }
      });
      if (evaluation.artifacts.length > 0) {
        await emitTrace(context, { type: "artifact:produced", nodeId, experimentId, label: plan.id, role: "evaluator", message: `${evaluation.artifacts.length} artifacts preserved`, data: { count: evaluation.artifacts.length } });
      }
      if (evaluation.status === "fail") {
        for (let skippedIndex = index + 1; skippedIndex < plans.length; skippedIndex += 1) {
          const skipped = plans[skippedIndex]!;
          const skippedId = `evaluator:${experimentId}:${skippedIndex}-${skipped.id}`;
          await emitTrace(context, { type: "node:created", nodeId: skippedId, experimentId, parentNodeId: `experiment:${experimentId}`, label: skipped.id, role: "evaluator" });
          await emitTrace(context, { type: "node:skipped", nodeId: skippedId, experimentId, label: skipped.id, role: "evaluator", status: "skipped", message: `Skipped after ${plan.id} failed` });
        }
        break;
      }
    } catch (error) {
      const message = errorMessage(error);
      if (isArtifactPreservationFailure(error)) {
        await emitTrace(context, { type: "node:failed", nodeId, experimentId, label: plan.id, role: "evaluator", status: "blocked", message });
        throw error;
      }
      await emitTrace(context, { type: "node:failed", nodeId, experimentId, label: plan.id, role: "evaluator", status: "crash", message });
      if (isInfrastructureFailure(error)) throw error;
      throw new InfrastructureFailureError(`Evaluator ${evaluator.id} crashed: ${message}`, { cause: error });
    }
  }
  return { evaluations };
}

export async function preserveAgentResult(
  context: WorkflowContext,
  result: AgentResult,
  experimentId: string
): Promise<AgentResult> {
  return {
    ...result,
    ...(result.artifacts ? {
      artifacts: await context.preserveArtifacts(result.artifacts, `${experimentId}/agent`)
    } : {}),
    ...(result.contributors ? {
      contributors: await Promise.all(result.contributors.map(async (contributor) => ({
        ...contributor,
        artifacts: await context.preserveArtifacts(contributor.artifacts, `${experimentId}/agent-${contributor.agentId}`)
      })))
    } : {})
  };
}

export function replayBudget(context: WorkflowContext, experiments: readonly ExperimentRecord[]): void {
  for (const experiment of experiments) {
    if (experiment.metadata?.failureClass === "infrastructure") continue;
    context.budget.record({
      status: experiment.status,
      ...(experiment.usage?.costUsd !== undefined ? { costUsd: experiment.usage.costUsd } : {})
    });
  }
}

export function latestAcceptedEvaluations(experiments: readonly ExperimentRecord[]): Evaluation[] | undefined {
  for (let index = experiments.length - 1; index >= 0; index -= 1) {
    const record = experiments[index];
    if (record?.status === "keep" || record?.status === "baseline") return record.evaluations;
  }
  return undefined;
}

export function campaignResult(
  context: WorkflowContext,
  experiments: ExperimentRecord[],
  status: CampaignResult["status"],
  summary: string,
  bestMetrics?: Record<string, number>
): CampaignResult {
  const accepted = experiments.filter((record) => record.status === "baseline" || record.status === "keep");
  return {
    campaignId: context.campaign.id,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    experiments,
    bestMetrics: bestMetrics ?? accepted.at(-1)?.metrics ?? {},
    summary
  };
}
