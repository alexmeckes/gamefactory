import { isAbsolute, relative, resolve } from "node:path";
import { decideAcceptance, flattenMetrics, isCandidateInvalidation, isInfrastructureFailure, shouldRetainCandidate } from "@gamefactory/core";
import type {
  AgentDriver,
  AgentRequest,
  AgentResult,
  BudgetReservationLike,
  Campaign,
  CampaignResult,
  Candidate,
  Evaluation,
  ExperimentRecord,
  Workflow,
  WorkflowContext,
  WorkspaceDriver
} from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";
import {
  agentJournalData,
  agentFinalizationJournalData,
  applyWorkspaceDecision,
  asObject,
  campaignResult,
  errorMessage,
  evaluateWaterfall,
  evaluatorPlans,
  failureAgentResult,
  finalizeAgentDecision,
  isArtifactPreservationFailure,
  journalPhase,
  latestAcceptedEvaluations,
  mapBounded,
  positiveInteger,
  preserveAgentResult,
  recoverWorkflow,
  replayBudget,
  workspaceDecisionOperationId,
  type EvaluatorPlan
} from "@gamefactory/workflow-sdk";

export interface TournamentParameters {
  workspace: string;
  agents: string[];
  evaluators: EvaluatorPlan[];
  candidateCount: number;
  concurrency: number;
  director?: TournamentDirectorParameters;
}

export interface TournamentDirectorParameters {
  agent: string;
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  advisorReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutSeconds: number;
  maxOutputCharacters: number;
  context: unknown[];
}

interface DirectorBrief {
  phase: "framing" | "synthesis";
  round: number;
  status: "complete" | "failed";
  summary: string;
  outcome: string;
  configuredModel: string;
  configuredReasoningEffort: string;
  actualModel?: string;
  actualReasoningEffort?: string;
  hypotheses: Array<{ slot: number; title: string; hypothesis: string; assumptions: string[]; successSignals: string[]; avoid: string[] }>;
  learnings: string[];
  recommendation?: string;
  artifactCount: number;
  error?: string;
}

interface CandidateRun {
  experimentId: string;
  round: number;
  slot: number;
  startedAt: string;
  agentId: string;
  agent: AgentDriver;
  agentRequest?: AgentRequest;
  reservation: BudgetReservationLike;
  candidate?: Candidate;
  agentResult?: AgentResult;
  evaluations: Evaluation[];
  error?: string;
  preservationBlocked?: boolean;
  retentionBlocked?: boolean;
  failureClass?: "infrastructure" | "execution" | "validation";
}

interface RankedCandidate {
  run: CandidateRun;
  value: number;
  decision: ReturnType<typeof decideAcceptance>;
}

export function parseTournamentParameters(context: WorkflowContext): TournamentParameters {
  const tournament = asObject(context.campaign.parameters?.tournament);
  const candidateCount = Math.min(64, positiveInteger(tournament.candidateCount, 3));
  const requestedConcurrency = positiveInteger(tournament.concurrency, Math.min(2, candidateCount));
  const agents = Array.isArray(tournament.agents)
    ? tournament.agents.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const rawDirector = tournament.director;
  let director: TournamentDirectorParameters | undefined;
  if (rawDirector !== undefined && rawDirector !== false) {
    const value = asObject(rawDirector === true ? {} : rawDirector);
    const efforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
    const reasoningEffort = typeof value.reasoningEffort === "string" ? value.reasoningEffort : "high";
    if (!efforts.has(reasoningEffort)) throw new Error("parameters.tournament.director.reasoningEffort is unsupported");
    const advisorReasoningEffort = value.advisorReasoningEffort === false ? undefined : typeof value.advisorReasoningEffort === "string" ? value.advisorReasoningEffort : "xhigh";
    if (advisorReasoningEffort !== undefined && !efforts.has(advisorReasoningEffort)) throw new Error("parameters.tournament.director.advisorReasoningEffort is unsupported");
    const rawContext = value.context;
    if (rawContext !== undefined && (!Array.isArray(rawContext) || rawContext.length > 64)) throw new Error("parameters.tournament.director.context must contain at most 64 references");
    director = {
      agent: typeof value.agent === "string" && value.agent.length > 0 ? value.agent : "agent.team",
      model: typeof value.model === "string" && value.model.length > 0 ? value.model : "gpt-5.6-sol",
      reasoningEffort: reasoningEffort as TournamentDirectorParameters["reasoningEffort"],
      ...(advisorReasoningEffort ? { advisorReasoningEffort: advisorReasoningEffort as NonNullable<TournamentDirectorParameters["advisorReasoningEffort"]> } : {}),
      timeoutSeconds: positiveInteger(value.timeoutSeconds, 1800),
      maxOutputCharacters: positiveInteger(value.maxOutputCharacters, 30_000),
      context: rawContext ? [...rawContext] : []
    };
  }
  return {
    workspace: typeof tournament.workspace === "string" && tournament.workspace.length > 0
      ? tournament.workspace
      : "mock.workspace",
    agents: agents.length > 0 ? agents : ["mock.agent"],
    evaluators: evaluatorPlans(tournament.evaluators),
    candidateCount,
    concurrency: Math.min(candidateCount, requestedConcurrency),
    ...(director ? { director } : {})
  };
}

function nextRound(experiments: ExperimentRecord[]): number {
  const retryRounds = new Set(experiments.flatMap((record) => {
    const tournament = asObject(record.metadata?.tournament);
    return record.metadata?.failureClass === "infrastructure" && typeof tournament.round === "number" ? [tournament.round] : [];
  }));
  let maximum = 0;
  for (const record of experiments) {
    const tournament = asObject(record.metadata?.tournament);
    if (typeof tournament.round === "number" && Number.isSafeInteger(tournament.round) && !retryRounds.has(tournament.round)) maximum = Math.max(maximum, tournament.round);
  }
  return maximum + 1;
}

function retainedRound(item: { record?: ExperimentRecord; reserved: Record<string, unknown> }): number | undefined {
  const tournament = asObject(item.record?.metadata?.tournament);
  const value = typeof tournament.round === "number" ? tournament.round : item.reserved.round;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function retainedSlot(item: { record?: ExperimentRecord; reserved: Record<string, unknown> }): number | undefined {
  const tournament = asObject(item.record?.metadata?.tournament);
  const value = typeof tournament.slot === "number" ? tournament.slot : item.reserved.slot;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function retainedDirectorFraming(
  candidates: Array<{ record?: ExperimentRecord; reserved: Record<string, unknown> }>,
  round: number
): DirectorBrief | undefined {
  for (const item of candidates) {
    const tournament = asObject(item.record?.metadata?.tournament);
    const value = asObject(tournament.directorFraming ?? item.reserved.directorFraming);
    if (value.phase === "framing" && value.round === round && (value.status === "complete" || value.status === "failed")) {
      return value as unknown as DirectorBrief;
    }
  }
  return undefined;
}

function rankCandidates(context: WorkflowContext, baseline: Evaluation[], runs: CandidateRun[]): RankedCandidate[] {
  const primaryMetric = context.campaign.acceptance.primaryMetric;
  const ranked: RankedCandidate[] = [];
  for (const run of runs) {
    if (run.error || !run.candidate || run.evaluations.some((evaluation) => evaluation.status === "fail")) continue;
    const decision = decideAcceptance(context.campaign.acceptance, baseline, run.evaluations, context.campaign.humanGates ? { humanGates: context.campaign.humanGates } : {});
    const value = flattenMetrics(run.evaluations)[primaryMetric];
    if (!decision.accepted || value === undefined || !Number.isFinite(value)) continue;
    ranked.push({ run, value, decision });
  }
  const direction = context.campaign.acceptance.direction;
  return ranked.sort((left, right) => {
    const metricOrder = direction === "maximize" ? right.value - left.value : left.value - right.value;
    return metricOrder || left.run.experimentId.localeCompare(right.run.experimentId);
  });
}

function shortText(value: unknown, fallback = "", maximum = 4000): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function shortList(value: unknown, maximumItems = 12): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maximumItems).map((item) => item.trim().slice(0, 1000))
    : [];
}

function compactContributorEvidence(result: AgentResult | undefined): unknown[] {
  const failure = asObject(asObject(result?.metadata).failure);
  const contributors: unknown[] = (result?.contributors?.length ?? 0) > 0
    ? result!.contributors!
    : Array.isArray(failure.contributors)
      ? failure.contributors
      : [];
  return contributors.slice(-16).map((rawContributor) => {
    const contributor = asObject(rawContributor);
    const metadata = asObject(contributor.metadata);
    const structured = Object.keys(asObject(contributor.structured)).length > 0 ? asObject(contributor.structured) : asObject(metadata.structured);
    const flatFindings = Array.isArray(structured.findings)
      ? structured.findings
      : Object.values(asObject(structured.findings)).flatMap((value) => Array.isArray(value) ? value : []);
    const findings = flatFindings
      .slice(0, 4)
      .flatMap((raw) => {
        const finding = asObject(raw);
        const issue = shortText(finding.issue, shortText(finding.finding), 600);
        if (!issue) return [];
        return [{
          findingClass: shortText(finding.findingClass, shortText(finding.classification), 80),
          claimIds: shortList(finding.claimIds, 6),
          issue,
          evidence: shortList(finding.evidence, 3)
        }];
      });
    return {
      agentId: shortText(contributor.agentId, shortText(contributor.contributorId), 200),
      role: shortText(contributor.role, shortText(contributor.stage), 80),
      status: shortText(contributor.status, "unknown", 80),
      summary: shortText(contributor.summary, "", 500),
      outcome: shortText(structured.outcome, shortText(metadata.outcome, shortText(contributor.outcome)), 80),
      ...(findings.length > 0 ? { findings } : {})
    };
  });
}

function directorBrief(result: AgentResult, config: TournamentDirectorParameters, phase: DirectorBrief["phase"], round: number): DirectorBrief {
  const contribution = [...(result.contributors ?? [])].reverse().find((item) => item.status === "complete");
  const contributionMetadata = asObject(contribution?.metadata);
  const structured = asObject(contributionMetadata.structured);
  const rawHypotheses = Array.isArray(structured.hypotheses) ? structured.hypotheses : [];
  const hypotheses = rawHypotheses.slice(0, 64).flatMap((raw, index) => {
    const item = asObject(raw);
    const slot = typeof item.slot === "number" && Number.isSafeInteger(item.slot) && item.slot > 0 ? item.slot : index + 1;
    const hypothesis = shortText(item.hypothesis);
    if (!hypothesis) return [];
    return [{ slot, title: shortText(item.title, `Candidate ${slot}`, 200), hypothesis, assumptions: shortList(item.assumptions), successSignals: shortList(item.successSignals), avoid: shortList(item.avoid) }];
  });
  return {
    phase,
    round,
    status: "complete",
    summary: shortText(structured.summary, result.summary),
    outcome: shortText(structured.outcome, "complete", 128),
    configuredModel: config.model,
    configuredReasoningEffort: config.reasoningEffort,
    ...(contribution?.usage?.model ? { actualModel: contribution.usage.model } : {}),
    ...(contribution?.usage?.reasoningEffort ? { actualReasoningEffort: contribution.usage.reasoningEffort } : {}),
    hypotheses,
    learnings: shortList(structured.learnings),
    ...(shortText(structured.recommendation) ? { recommendation: shortText(structured.recommendation) } : {}),
    artifactCount: result.artifacts?.length ?? 0
  };
}

function failedDirectorBrief(config: TournamentDirectorParameters, phase: DirectorBrief["phase"], round: number, error: unknown): DirectorBrief {
  const message = errorMessage(error);
  return { phase, round, status: "failed", summary: `Campaign Director ${phase} failed: ${message}`, outcome: "unavailable", configuredModel: config.model, configuredReasoningEffort: config.reasoningEffort, hypotheses: [], learnings: [], artifactCount: 0, error: message };
}

function previousDirectorSynthesis(experiments: ExperimentRecord[]): DirectorBrief | undefined {
  for (let index = experiments.length - 1; index >= 0; index -= 1) {
    const tournament = asObject(experiments[index]?.metadata?.tournament);
    const value = tournament.directorSynthesis;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as unknown as DirectorBrief;
  }
  return undefined;
}

function inheritedDirectorContext(campaign: Campaign, configured: unknown[]): unknown[] {
  if (configured.length > 0) return configured;
  const agentTeam = asObject(campaign.parameters?.agentTeam);
  const graph = asObject(agentTeam.graph);
  return Array.isArray(graph.context) ? graph.context.slice(0, 64) : [];
}

function directorEvidenceContext(projectRoot: string, runs: CandidateRun[]): unknown[] {
  const root = resolve(projectRoot);
  const acceptedKinds = new Set(["image", "video", "replay", "telemetry", "test-report"]);
  const seen = new Set<string>();
  const references: unknown[] = [];
  const artifacts = runs.flatMap((run) => [...(run.agentResult?.artifacts ?? []), ...run.evaluations.flatMap((evaluation) => evaluation.artifacts)]);
  for (const item of artifacts) {
    if (!acceptedKinds.has(item.kind)) continue;
    const target = resolve(item.path);
    const traversal = relative(root, target);
    if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal) || seen.has(target)) continue;
    seen.add(target);
    references.push({ path: traversal.replaceAll("\\", "/"), kind: item.kind, ...(item.mediaType ? { mediaType: item.mediaType } : {}), ...(item.label ? { label: item.label } : {}) });
    if (references.length >= 32) break;
  }
  return references;
}

async function emitDirectorTrace(context: WorkflowContext, event: Parameters<NonNullable<WorkflowContext["trace"]>["emit"]>[0]): Promise<void> {
  try { await context.trace?.emit(event); } catch { /* trace output is observational */ }
}

async function runDirector(input: {
  context: WorkflowContext;
  driver: AgentDriver;
  config: TournamentDirectorParameters;
  phase: DirectorBrief["phase"];
  round: number;
  roundSize: number;
  history: ExperimentRecord[];
  baseline: Evaluation[];
  runs?: CandidateRun[];
  ranked?: RankedCandidate[];
}): Promise<DirectorBrief> {
  const { context, driver, config, phase, round, roundSize, history } = input;
  const experimentId = `campaign-director-r${String(round).padStart(4, "0")}-${phase}`;
  const rootNode = `experiment:${experimentId}`;
  const previous = previousDirectorSynthesis(history);
  const recentHistory = history.slice(-16).map((record) => ({ id: record.experimentId, status: record.status, summary: record.summary, metrics: record.metrics }));
  const roundEvidence = (input.runs ?? []).map((run) => ({ experimentId: run.experimentId, slot: run.slot, agentSummary: run.agentResult?.summary ?? "", error: run.error, failureClass: run.failureClass, contributors: compactContributorEvidence(run.agentResult), evaluations: run.evaluations.map((evaluation) => ({ evaluator: evaluation.evaluator, status: evaluation.status, metrics: evaluation.metrics, summary: evaluation.summary, violations: evaluation.violations.map((item) => item.message) })) }));
  const ranked = (input.ranked ?? []).map((item, index) => ({ rank: index + 1, experimentId: item.run.experimentId, slot: item.run.slot, primaryMetric: item.value, decision: item.decision.reason }));
  const evidence = JSON.stringify({ originalObjective: context.campaign.objective, round, roundSize, baseline: flattenMetrics(input.baseline), recentHistory, previousSynthesis: previous, roundEvidence, deterministicRanking: ranked }, null, 2).slice(0, 60_000);
  const framingInstructions = `Act as the read-only Sol Campaign Director across candidate teams and rounds. Frame ${roundSize} genuinely contrasting, bounded candidate hypotheses for round ${round}. Use prior results and the baseline, but do not optimize the visible metric blindly. Decide where specialists or optional capabilities may be useful without forcing them. You advise; the deterministic tournament alone owns budgets, evaluation, acceptance, cleanup, and recovery. Return JSON only with summary, outcome (ready or needs_advisor), and hypotheses: an array of exactly ${roundSize} objects containing slot, title, hypothesis, assumptions, successSignals, and avoid. A candidate assignment must preserve creative latitude rather than prescribe an implementation. Evidence:\n${evidence}`;
  const synthesisInstructions = `Act as the read-only Sol Campaign Director after round ${round}. Synthesize what the candidate evidence actually taught us. The deterministic ranking shown below is authoritative; do not choose or accept a winner. Identify transferable learnings, failed assumptions, capability gaps, and whether the next round should continue, deepen, or pivot. Never call synthetic evaluation proof of fun. Return JSON only with summary, outcome (continue, deepen, pivot, stop_recommended, or needs_advisor), learnings as an array, and recommendation. Evidence:\n${evidence}`;
  const node: Record<string, unknown> = {
    id: `campaign-director-${phase}`,
    adapter: "codex-app-server",
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    timeoutSeconds: config.timeoutSeconds,
    role: "planner",
    permissions: "read",
    instructions: phase === "framing" ? framingInstructions : synthesisInstructions
  };
  if (config.advisorReasoningEffort && config.advisorReasoningEffort !== config.reasoningEffort) {
    node.advisor = { model: config.model, reasoningEffort: config.advisorReasoningEffort, outcomes: ["needs_advisor"], onFailure: true, maximumAttempts: 1 };
  }
  const directorCampaign: Campaign = {
    ...context.campaign,
    objective: `Direct the factory campaign without taking control-plane authority. Original objective: ${context.campaign.objective}`,
    mutablePaths: [],
    immutablePaths: ["**"],
    parameters: {
      ...context.campaign.parameters,
      agentTeam: {
        maximumParallel: 1,
        maxOutputCharacters: config.maxOutputCharacters,
        provider: "openai-codex-app-server",
        billingMode: "subscription",
        graph: { maximumTotalAttempts: config.advisorReasoningEffort ? 2 : 1, maximumRepairAttempts: 0, context: [...inheritedDirectorContext(context.campaign, config.context), ...directorEvidenceContext(context.campaign.projectRoot, input.runs ?? [])].slice(0, 64), nodes: [node] }
      }
    }
  };
  await emitDirectorTrace(context, { type: "node:created", nodeId: rootNode, parentNodeId: `campaign:${context.trace?.runId ?? context.campaign.id}`, label: `Campaign Director - round ${round} ${phase}`, role: "campaign-director", message: phase === "framing" ? "Frames contrasting candidate hypotheses" : "Synthesizes round learning", data: { configuredModel: config.model, reasoningEffort: config.reasoningEffort, advisoryOnly: true } });
  await emitDirectorTrace(context, { type: "node:started", nodeId: rootNode, label: `Campaign Director - round ${round} ${phase}`, role: "campaign-director" });
  try {
    const result = await preserveAgentResult(context, await driver.run({ campaign: directorCampaign, candidate: { id: experimentId, root: context.campaign.projectRoot, metadata: { director: true, phase, round } }, experimentId, history: [...history], signal: context.signal, ...(context.trace ? { trace: context.trace } : {}) }), experimentId);
    const brief = directorBrief(result, config, phase, round);
    await emitDirectorTrace(context, { type: "node:completed", nodeId: rootNode, label: `Campaign Director - round ${round} ${phase}`, role: "campaign-director", status: "complete", message: brief.summary, data: { outcome: brief.outcome, hypotheses: brief.hypotheses.length, learnings: brief.learnings.length, advisoryOnly: true } });
    return brief;
  } catch (error) {
    const failure = failureAgentResult(error);
    if (failure) {
      try { await preserveAgentResult(context, failure, experimentId); } catch { /* original director failure remains advisory */ }
    }
    const brief = failedDirectorBrief(config, phase, round, error);
    await emitDirectorTrace(context, { type: "node:failed", nodeId: rootNode, label: `Campaign Director - round ${round} ${phase}`, role: "campaign-director", status: "failed", message: brief.summary, data: { advisoryOnly: true } });
    context.logger.warn(brief.summary, { round, phase });
    return brief;
  }
}

function directedCampaign(campaign: Campaign, framing: DirectorBrief | undefined, slot: number): Campaign {
  if (!framing || framing.status !== "complete") return campaign;
  const assignment = framing.hypotheses.find((item) => item.slot === slot);
  if (!assignment) return campaign;
  const direction = JSON.stringify({ title: assignment.title, hypothesis: assignment.hypothesis, assumptions: assignment.assumptions, successSignals: assignment.successSignals, avoid: assignment.avoid }, null, 2);
  return { ...campaign, objective: `${campaign.objective}\n\nCampaign Director assignment for candidate slot ${slot}:\n${direction}\n\nTreat this as a bounded hypothesis and evidence target, not a predetermined solution. You retain room to explore and should revise unsupported assumptions.` };
}

async function executeCandidate(
  context: WorkflowContext,
  workspace: WorkspaceDriver,
  agent: AgentDriver,
  agentId: string,
  evaluatorConfig: EvaluatorPlan[],
  experimentId: string,
  round: number,
  slot: number,
  history: ExperimentRecord[],
  reservation: BudgetReservationLike,
  agentCampaign: Campaign = context.campaign,
  resume?: { sourceExperimentId: string; logicalExperimentId: string; attemptNumber: number; candidate: Candidate; startedAt: string }
): Promise<CandidateRun> {
  const startedAt = resume?.startedAt ?? new Date().toISOString();
  let candidate: Candidate | undefined = resume?.candidate;
  let agentResult: AgentResult | undefined;
  let evaluations: Evaluation[] = [];
  let agentRequest: AgentRequest | undefined;
  try {
    context.signal.throwIfAborted();
    candidate ??= await workspace.createCandidate({ campaign: context.campaign, experimentId, signal: context.signal, ...(context.runtime ? { runtime: context.runtime } : {}) });
    await journalPhase(context, experimentId, "candidate-created", { candidate });
    context.signal.throwIfAborted();
    agentRequest = {
      campaign: agentCampaign,
      candidate,
      experimentId,
      logicalExperimentId: resume?.logicalExperimentId ?? experimentId,
      attemptNumber: (resume?.attemptNumber ?? 0) + 1,
      ...(resume ? { resumedFromExperimentId: resume.sourceExperimentId } : {}),
      history: [...history],
      ...(context.runtime ? { runtime: context.runtime } : {}),
      signal: context.signal,
      ...(context.trace ? { trace: context.trace } : {})
    };
    agentResult = await preserveAgentResult(context, await agent.run(agentRequest), experimentId);
    await journalPhase(context, experimentId, "agent-finished", agentJournalData(agentResult));
    context.signal.throwIfAborted();
    const evaluationRun = await evaluateWaterfall(context, evaluatorConfig, candidate, experimentId);
    evaluations = evaluationRun.evaluations;
    await journalPhase(context, experimentId, "evaluated", { evaluations });
    await journalPhase(context, experimentId, "evidence-preserved");
    return {
      experimentId,
      round,
      slot,
      startedAt,
      agentId,
      agent,
      agentRequest,
      reservation,
      candidate,
      agentResult,
      evaluations,
      ...(evaluationRun.error ? { error: evaluationRun.error } : {})
    };
  } catch (error) {
    const failure = failureAgentResult(error);
    let outcomeError: unknown = error;
    try {
      if (failure) agentResult = await preserveAgentResult(context, failure, experimentId);
    } catch (preservationError) {
      outcomeError = preservationError;
    }
    return {
      experimentId,
      round,
      slot,
      startedAt,
      agentId,
      agent,
      ...(agentRequest ? { agentRequest } : {}),
      reservation,
      ...(candidate ? { candidate } : {}),
      ...(agentResult ? { agentResult } : {}),
      evaluations,
      error: errorMessage(outcomeError),
      ...(isArtifactPreservationFailure(outcomeError) ? { preservationBlocked: true } : {}),
      ...(shouldRetainCandidate(outcomeError) ? { retentionBlocked: true } : {}),
      failureClass: isInfrastructureFailure(outcomeError)
        ? "infrastructure" as const
        : isCandidateInvalidation(outcomeError)
          ? "validation" as const
          : "execution" as const
    };
  }
}

export class TournamentWorkflow implements Workflow {
  readonly id = "tournament";

  async run(context: WorkflowContext): Promise<CampaignResult> {
    const config = parseTournamentParameters(context);
    const workspace = context.get<WorkspaceDriver>("workspace", config.workspace);
    const agents = config.agents.map((id) => ({ id, driver: context.get<AgentDriver>("agent", id) }));
    const directorDriver = config.director ? context.get<AgentDriver>("agent", config.director.agent) : undefined;
    const recovery = await recoverWorkflow(context, workspace);
    const experiments = await context.readRecords();
    if (recovery.blocked) return campaignResult(context, experiments, "blocked", recovery.blocked);
    replayBudget(context, experiments);

    let baseline = latestAcceptedEvaluations(experiments);
    const resumedBaselineRecord = [...experiments].reverse().find((record) => (record.status === "keep" || record.status === "baseline") && record.evaluations.length > 0);
    let baselineError = resumedBaselineRecord?.status === "baseline" && typeof asObject(resumedBaselineRecord.metadata?.tournament).baselineError === "string"
      ? asObject(resumedBaselineRecord.metadata?.tournament).baselineError as string
      : undefined;
    if (!baseline) {
      const startedAt = new Date().toISOString();
      await journalPhase(context, "baseline", "reserved", { startedAt });
      await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId: "baseline", at: startedAt });
      let baselineRun;
      try {
        baselineRun = await evaluateWaterfall(context, config.evaluators, null, "baseline");
      } catch (error) {
        if (!isInfrastructureFailure(error)) throw error;
        const message = errorMessage(error);
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId: "baseline",
          startedAt,
          finishedAt: new Date().toISOString(),
          status: "blocked",
          summary: message,
          metrics: {},
          evaluations: [],
          metadata: { failureClass: "infrastructure", tournament: { baseline: true, baselineError: message } }
        };
        experiments.push(record);
        await context.appendRecord(record);
        await journalPhase(context, "baseline", "blocked", { record, candidateRetained: false, resumable: false, failureClass: "infrastructure" });
        await journalPhase(context, "baseline", "cleaned", { retryableBaselineInfrastructureFailure: true });
        return campaignResult(context, experiments, "blocked", message);
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
        summary: baselineRun.error ? `Baseline evaluation crashed: ${baselineRun.error}` : "Measured the starting revision once.",
        metrics: flattenMetrics(baseline),
        evaluations: baseline,
        metadata: { tournament: { baseline: true, evaluatorOrder: config.evaluators.map((item) => item.id), ...(baselineRun.error ? { baselineError: baselineRun.error } : {}) } }
      };
      experiments.push(record);
      await context.appendRecord(record);
      await journalPhase(context, "baseline", "recorded", { record });
      await journalPhase(context, "baseline", "cleaned");
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }

    const baselineMetrics = flattenMetrics(baseline);
    if (baselineError) return campaignResult(context, experiments, "blocked", `Baseline evaluation crashed: ${baselineError}`);
    if (baselineMetrics[context.campaign.acceptance.primaryMetric] === undefined) {
      return campaignResult(context, experiments, "blocked", `Baseline did not produce ${context.campaign.acceptance.primaryMetric}.`);
    }
    let activeBaseline: Evaluation[] = baseline;

    const pendingRounds = recovery.resumableCandidates.flatMap((item) => {
      const value = retainedRound(item);
      return value === undefined ? [] : [value];
    });
    let round = pendingRounds.length > 0 ? Math.min(...pendingRounds) : nextRound(experiments);
    while (!context.signal.aborted) {
      const resumableBySlot = new Map(recovery.resumableCandidates.flatMap((item) => {
        const itemRound = retainedRound(item);
        const slot = retainedSlot(item);
        return itemRound === round && slot !== undefined ? [[slot, item] as const] : [];
      }));
      const remaining = context.budget.remainingExperiments();
      const requestedRoundSize = Math.min(config.candidateCount, Math.max(remaining, resumableBySlot.size));
      const roundSlotSet = new Set(resumableBySlot.keys());
      for (let slot = 1; roundSlotSet.size < requestedRoundSize && slot <= config.candidateCount; slot += 1) roundSlotSet.add(slot);
      const roundSlots = [...roundSlotSet].sort((left, right) => left - right);
      const roundSize = roundSlots.length;
      if (roundSize <= 0) return campaignResult(context, experiments, "budget-exhausted", "maximum experiments reached");
      const allowance = context.budget.canStart(roundSize);
      if (!allowance.allowed) return campaignResult(context, experiments, "budget-exhausted", allowance.reason ?? "Budget exhausted.");

      const history = [...experiments];
      const framing = resumableBySlot.size > 0
        ? retainedDirectorFraming([...resumableBySlot.values()], round)
        : config.director && directorDriver
          ? await runDirector({ context, driver: directorDriver, config: config.director, phase: "framing", round, roundSize, history, baseline: activeBaseline })
          : undefined;
      const specifications = roundSlots.map((slot) => {
        const resume = resumableBySlot.get(slot);
        const retainedAgentId = asObject(resume?.record?.metadata?.tournament).agent;
        const agent = typeof retainedAgentId === "string"
          ? { id: retainedAgentId, driver: context.get<AgentDriver>("agent", retainedAgentId) }
          : agents[(slot - 1) % agents.length];
        if (!agent) throw new Error("Tournament has no agent driver.");
        return {
          experimentId: resume ? `${resume.logicalExperimentId}-attempt-${String(resume.attemptNumber + 1).padStart(4, "0")}` : `tournament-r${String(round).padStart(4, "0")}-c${String(slot).padStart(3, "0")}`,
          slot,
          agent,
          campaign: directedCampaign(context.campaign, framing, slot),
          ...(resume ? { resume } : {})
        };
      });

      const reservations: BudgetReservationLike[] = [];
      let reservationFailed = false;
      for (const specification of specifications) {
        const reservation = context.budget.tryReserve({ experimentId: specification.experimentId });
        if (!reservation) {
          reservationFailed = true;
          break;
        }
        reservations.push(reservation);
      }
      if (reservationFailed) {
        for (const reservation of reservations) reservation.cancel();
        return campaignResult(context, experiments, "budget-exhausted", "Unable to reserve the next tournament round within budget.");
      }

      for (const specification of specifications) {
        if (specification.resume) await journalPhase(context, specification.resume.sourceExperimentId, "cleaned", { resumedAs: specification.experimentId, candidateRetained: true });
        const attemptStartedAt = new Date().toISOString();
        await journalPhase(context, specification.experimentId, "reserved", { round, slot: specification.slot, startedAt: specification.resume?.startedAt ?? attemptStartedAt, attemptStartedAt, logicalExperimentId: specification.resume?.logicalExperimentId ?? specification.experimentId, attemptNumber: (specification.resume?.attemptNumber ?? 0) + 1, ...(framing ? { directorFraming: framing } : {}) });
        await context.emit({
          type: "experiment:start",
          campaignId: context.campaign.id,
          experimentId: specification.experimentId,
          at: attemptStartedAt
        });
      }

      const runs = await mapBounded(specifications, Math.min(config.concurrency, roundSize), async (specification, index) =>
        executeCandidate(
          context,
          workspace,
          specification.agent.driver,
          specification.agent.id,
          config.evaluators,
          specification.experimentId,
          round,
          specification.slot,
          history,
          reservations[index]!,
          specification.campaign,
          specification.resume
        ));

      const ranked: RankedCandidate[] = context.signal.aborted ? [] : rankCandidates(context, activeBaseline, runs);
      const synthesis = config.director && directorDriver && !context.signal.aborted
        ? await runDirector({ context, driver: directorDriver, config: config.director, phase: "synthesis", round, roundSize, history, baseline: activeBaseline, runs, ranked })
        : undefined;
      const roundRetryRequired = runs.some((run) => run.preservationBlocked || run.retentionBlocked);
      const roundFailureClass = runs.some((run) => run.preservationBlocked || run.failureClass === "infrastructure")
        ? "infrastructure" as const
        : runs.some((run) => run.failureClass === "validation")
          ? "validation" as const
          : undefined;
      const winner: RankedCandidate | undefined = context.signal.aborted || roundRetryRequired ? undefined : ranked[0];
      const cleanupSignal = new AbortController().signal;
      const losers: CandidateRun[] = runs.filter((run) => run !== winner?.run).sort((left, right) => left.slot - right.slot);
      const finalizationOrder: CandidateRun[] = winner ? [...losers, winner.run] : losers;
      let roundBlocked = roundRetryRequired;

      for (const run of finalizationOrder) {
        const ranking = ranked.findIndex((item) => item.run === run);
        const decision = ranking >= 0 ? ranked[ranking]?.decision : undefined;
        const isWinner = winner?.run === run;
        const shouldAccept = isWinner && !roundBlocked;
        let status: ExperimentRecord["status"] = roundRetryRequired || run.preservationBlocked || run.retentionBlocked ? "blocked" : context.signal.aborted ? "cancelled" : run.error ? "crash" : shouldAccept ? "keep" : "discard";
        let revision: string | undefined;
        let candidateRevision: string | undefined;
        let finalizationError: string | undefined;

        if (run.candidate && !roundRetryRequired && !run.preservationBlocked && !run.retentionBlocked) {
          try {
            const predictedReason = shouldAccept ? "tournament-winner-accepted" : `tournament-candidate-rejected:round-${round}`;
            const operationId = workspaceDecisionOperationId(context, run.experimentId, run.candidate);
            await journalPhase(context, run.experimentId, "acceptance-intent", {
              action: shouldAccept ? "accept" : "discard",
              operationId,
              round,
              slot: run.slot,
              recoveryMetadata: {
                tournament: {
                  round,
                  slot: run.slot,
                  roundSize,
                  agent: run.agentId,
                  evaluatorOrder: config.evaluators.map((item) => item.id),
                  winner: shouldAccept,
                  ...(ranking >= 0 ? { rank: ranking + 1 } : {}),
                  ...(decision ? { decision } : {}),
                  ...(framing ? { directorFraming: framing } : {}),
                  ...(synthesis ? { directorSynthesis: synthesis } : {})
                },
                ...(run.agentResult?.metadata ? { agent: run.agentResult.metadata } : {}),
                ...(run.failureClass ? { failureClass: run.failureClass } : {})
              },
              ...(run.agentRequest && run.agentResult ? {
                finalization: agentFinalizationJournalData({ agent: run.agent, request: run.agentRequest, result: run.agentResult, evaluations: run.evaluations, accepted: shouldAccept, reason: predictedReason })
              } : {})
            });
            if (shouldAccept) {
              const acceptance = await applyWorkspaceDecision(context, workspace, run.experimentId, { action: "accept", candidate: run.candidate, operationId, signal: cleanupSignal });
              revision = acceptance.revision;
              candidateRevision = acceptance.candidateRevision;
              if (acceptance.changed === false) status = "discard";
              if (run.agentRequest && run.agentResult) {
                await finalizeAgentDecision(context, run.experimentId, {
                  agent: run.agent,
                  request: run.agentRequest,
                  result: run.agentResult,
                  evaluations: run.evaluations,
                  accepted: status === "keep",
                  reason: status === "keep" ? predictedReason : "tournament-winner-produced-no-change"
                });
              }
            } else {
              await applyWorkspaceDecision(context, workspace, run.experimentId, { action: "discard", candidate: run.candidate, operationId, signal: cleanupSignal });
              if (run.agentRequest && run.agentResult) {
                await finalizeAgentDecision(context, run.experimentId, { agent: run.agent, request: run.agentRequest, result: run.agentResult, evaluations: run.evaluations, accepted: false, reason: predictedReason });
              }
            }
          } catch (error) {
            finalizationError = errorMessage(error);
            status = "blocked";
            roundBlocked = true;
          }
        }

        const winnerSummary = winner
          ? isWinner
            ? status === "keep"
              ? `Won round ${round}. ${winner.decision.reason}`
              : `Ranked first in round ${round}, but the candidate was not accepted.`
            : `Lost round ${round} to ${winner.run.experimentId}.`
          : `Round ${round} produced no passing candidate that improved the baseline.`;
        const record: ExperimentRecord = {
          campaignId: context.campaign.id,
          experimentId: run.experimentId,
          startedAt: run.startedAt,
          finishedAt: new Date().toISOString(),
          status,
          ...(run.candidate ? { candidateId: run.candidate.id } : {}),
          ...(revision ? { revision } : {}),
          summary: [run.agentResult?.summary, run.error, finalizationError, winnerSummary].filter(Boolean).join(" "),
          metrics: flattenMetrics(run.evaluations),
          evaluations: run.evaluations,
          ...((run.agentResult?.contributors?.length ?? 0) > 0 || (run.agentResult?.artifacts?.length ?? 0) > 0 ? {
            agent: {
              summary: run.agentResult?.summary ?? "",
              contributors: run.agentResult?.contributors ?? [],
              artifacts: run.agentResult?.artifacts ?? []
            }
          } : {}),
          ...(run.agentResult?.usage ? { usage: run.agentResult.usage } : {}),
          metadata: {
            tournament: {
              round,
              slot: run.slot,
              roundSize,
              agent: run.agentId,
              evaluatorOrder: config.evaluators.map((item) => item.id),
              winner: isWinner && status === "keep",
              ...(ranking >= 0 ? { rank: ranking + 1 } : {}),
              ...(decision ? { decision } : {}),
              ...(finalizationError ? { finalizationError } : {}),
              ...(candidateRevision ? { candidateRevision } : {}),
              ...(framing ? { directorFraming: framing } : {}),
              ...(synthesis ? { directorSynthesis: synthesis } : {})
            },
            ...(run.agentResult?.metadata ? { agent: run.agentResult.metadata } : {}),
            ...(roundFailureClass ? { failureClass: roundFailureClass } : run.failureClass ? { failureClass: run.failureClass } : {})
          }
        };

        if (status === "keep") activeBaseline = run.evaluations;
        const candidateBlocked = Boolean(roundRetryRequired || run.preservationBlocked || run.retentionBlocked || finalizationError);
        if (candidateBlocked) {
          roundBlocked = true;
          await journalPhase(context, run.experimentId, "blocked", { record, candidateRetained: Boolean(run.candidate), resumable: Boolean(run.candidate && roundRetryRequired), ...(roundFailureClass ? { failureClass: roundFailureClass } : run.failureClass ? { failureClass: run.failureClass } : {}) });
        } else {
          await journalPhase(context, run.experimentId, "applied", { record });
        }
        experiments.push(record);
        if (roundFailureClass === "infrastructure") run.reservation.cancel();
        else run.reservation.settle({ status, ...(run.agentResult?.usage?.costUsd !== undefined ? { actualCostUsd: run.agentResult.usage.costUsd } : {}) });
        await context.appendRecord(record);
        if (!candidateBlocked) {
          await journalPhase(context, run.experimentId, "recorded", { status });
          await journalPhase(context, run.experimentId, "cleaned");
        }
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
      }

      if (roundBlocked) return campaignResult(context, experiments, "blocked", roundFailureClass === "validation"
        ? "At least one candidate was invalidated by trusted review and retained as a bounded repair base; it cannot be promoted unchanged."
        : "At least one candidate was retained because evidence preservation, infrastructure, or finalization could not be confirmed.");

      round += 1;
    }
    return campaignResult(context, experiments, "cancelled", "Campaign was cancelled; all completed candidate workspaces were discarded.");
  }
}

export default defineExtension((api) => api.register("workflow", "tournament", new TournamentWorkflow()));
