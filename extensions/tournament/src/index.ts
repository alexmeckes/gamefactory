import { decideAcceptance, flattenMetrics } from "@gamefactory/core";
import type {
  AgentDriver,
  AgentResult,
  BudgetReservationLike,
  CampaignResult,
  Candidate,
  Evaluation,
  Evaluator,
  ExperimentRecord,
  Workflow,
  WorkflowContext,
  WorkspaceDriver
} from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

interface EvaluatorPlan {
  id: string;
  cost: number;
  order: number;
}

export interface TournamentParameters {
  workspace: string;
  agents: string[];
  evaluators: EvaluatorPlan[];
  candidateCount: number;
  concurrency: number;
}

interface EvaluationRun {
  evaluations: Evaluation[];
  error?: string;
}

interface CandidateRun {
  experimentId: string;
  round: number;
  slot: number;
  startedAt: string;
  agentId: string;
  reservation: BudgetReservationLike;
  candidate?: Candidate;
  agentResult?: AgentResult;
  evaluations: Evaluation[];
  error?: string;
}

interface RankedCandidate {
  run: CandidateRun;
  value: number;
  decision: ReturnType<typeof decideAcceptance>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function evaluatorPlans(value: unknown): EvaluatorPlan[] {
  if (!Array.isArray(value)) return [{ id: "mock.score", cost: 0, order: 0 }];
  const plans: EvaluatorPlan[] = [];
  for (const [order, item] of value.entries()) {
    if (typeof item === "string" && item.length > 0) {
      plans.push({ id: item, cost: order, order });
      continue;
    }
    const entry = object(item);
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const cost = typeof entry.cost === "number" && Number.isFinite(entry.cost) ? entry.cost : order;
    plans.push({ id: entry.id, cost, order });
  }
  if (plans.length === 0) return [{ id: "mock.score", cost: 0, order: 0 }];
  return plans.sort((left, right) => left.cost - right.cost || left.order - right.order || left.id.localeCompare(right.id));
}

export function parseTournamentParameters(context: WorkflowContext): TournamentParameters {
  const tournament = object(context.campaign.parameters?.tournament);
  const candidateCount = Math.min(64, positiveInteger(tournament.candidateCount, 3));
  const requestedConcurrency = positiveInteger(tournament.concurrency, Math.min(2, candidateCount));
  const agents = Array.isArray(tournament.agents)
    ? tournament.agents.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    workspace: typeof tournament.workspace === "string" && tournament.workspace.length > 0
      ? tournament.workspace
      : "mock.workspace",
    agents: agents.length > 0 ? agents : ["mock.agent"],
    evaluators: evaluatorPlans(tournament.evaluators),
    candidateCount,
    concurrency: Math.min(candidateCount, requestedConcurrency)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function evaluateWaterfall(
  context: WorkflowContext,
  plans: EvaluatorPlan[],
  candidate: Candidate | null,
  experimentId: string
): Promise<EvaluationRun> {
  const evaluations: Evaluation[] = [];
  for (const plan of plans) {
    const evaluator = context.get<Evaluator>("evaluator", plan.id);
    try {
      const rawEvaluation = await evaluator.evaluate({
        campaign: context.campaign,
        candidate,
        experimentId,
        priorEvaluations: [...evaluations],
        signal: context.signal
      });
      const evaluation: Evaluation = {
        ...rawEvaluation,
        artifacts: await context.preserveArtifacts(rawEvaluation.artifacts, `${experimentId}/evaluator-${rawEvaluation.evaluator}`)
      };
      evaluations.push(evaluation);
      if (evaluation.status === "fail") break;
    } catch (error) {
      const message = errorMessage(error);
      evaluations.push({
        evaluator: evaluator.id,
        version: evaluator.version,
        status: "fail",
        metrics: {},
        violations: [{ code: "evaluator-crash", message, severity: "error" }],
        artifacts: [],
        summary: `Evaluator crashed: ${message}`
      });
      return { evaluations, error: message };
    }
  }
  return { evaluations };
}

async function preserveAgentResult(context: WorkflowContext, result: AgentResult, experimentId: string): Promise<AgentResult> {
  return {
    ...result,
    ...(result.artifacts ? { artifacts: await context.preserveArtifacts(result.artifacts, `${experimentId}/agent`) } : {}),
    ...(result.contributors ? {
      contributors: await Promise.all(result.contributors.map(async (contributor) => ({
        ...contributor,
        artifacts: await context.preserveArtifacts(contributor.artifacts, `${experimentId}/agent-${contributor.agentId}`)
      })))
    } : {})
  };
}

async function mapBounded<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`Tournament worker ${index} did not produce a result.`);
    return result;
  });
}

function latestBaseline(experiments: ExperimentRecord[]): Evaluation[] | undefined {
  for (let index = experiments.length - 1; index >= 0; index -= 1) {
    const record = experiments[index];
    if (record?.status === "keep" || record?.status === "baseline") return record.evaluations;
  }
  return undefined;
}

function nextRound(experiments: ExperimentRecord[]): number {
  let maximum = 0;
  for (const record of experiments) {
    const tournament = object(record.metadata?.tournament);
    if (typeof tournament.round === "number" && Number.isSafeInteger(tournament.round)) maximum = Math.max(maximum, tournament.round);
  }
  return maximum + 1;
}

function result(
  context: WorkflowContext,
  experiments: ExperimentRecord[],
  status: CampaignResult["status"],
  summary: string
): CampaignResult {
  const accepted = experiments.filter((record) => record.status === "baseline" || record.status === "keep");
  return {
    campaignId: context.campaign.id,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    experiments,
    bestMetrics: accepted.at(-1)?.metrics ?? {},
    summary
  };
}

function rankCandidates(context: WorkflowContext, baseline: Evaluation[], runs: CandidateRun[]): RankedCandidate[] {
  const primaryMetric = context.campaign.acceptance.primaryMetric;
  const ranked: RankedCandidate[] = [];
  for (const run of runs) {
    if (run.error || !run.candidate || run.evaluations.some((evaluation) => evaluation.status === "fail")) continue;
    const decision = decideAcceptance(context.campaign.acceptance, baseline, run.evaluations);
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
  reservation: BudgetReservationLike
): Promise<CandidateRun> {
  const startedAt = new Date().toISOString();
  let candidate: Candidate | undefined;
  let agentResult: AgentResult | undefined;
  let evaluations: Evaluation[] = [];
  try {
    context.signal.throwIfAborted();
    candidate = await workspace.createCandidate({ campaign: context.campaign, experimentId, signal: context.signal });
    context.signal.throwIfAborted();
    agentResult = await preserveAgentResult(context, await agent.run({
      campaign: context.campaign,
      candidate,
      experimentId,
      history: [...history],
      signal: context.signal
    }), experimentId);
    context.signal.throwIfAborted();
    const evaluationRun = await evaluateWaterfall(context, evaluatorConfig, candidate, experimentId);
    evaluations = evaluationRun.evaluations;
    return {
      experimentId,
      round,
      slot,
      startedAt,
      agentId,
      reservation,
      candidate,
      agentResult,
      evaluations,
      ...(evaluationRun.error ? { error: evaluationRun.error } : {})
    };
  } catch (error) {
    return {
      experimentId,
      round,
      slot,
      startedAt,
      agentId,
      reservation,
      ...(candidate ? { candidate } : {}),
      ...(agentResult ? { agentResult } : {}),
      evaluations,
      error: errorMessage(error)
    };
  }
}

export class TournamentWorkflow implements Workflow {
  readonly id = "tournament";

  async run(context: WorkflowContext): Promise<CampaignResult> {
    const config = parseTournamentParameters(context);
    const workspace = context.get<WorkspaceDriver>("workspace", config.workspace);
    const agents = config.agents.map((id) => ({ id, driver: context.get<AgentDriver>("agent", id) }));
    const experiments = await context.readRecords();
    for (const experiment of experiments) {
      context.budget.record({
        status: experiment.status,
        ...(experiment.usage?.costUsd !== undefined ? { costUsd: experiment.usage.costUsd } : {})
      });
    }

    let baseline = latestBaseline(experiments);
    if (!baseline) {
      const startedAt = new Date().toISOString();
      await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId: "baseline", at: startedAt });
      const baselineRun = await evaluateWaterfall(context, config.evaluators, null, "baseline");
      baseline = baselineRun.evaluations;
      const record: ExperimentRecord = {
        campaignId: context.campaign.id,
        experimentId: "baseline",
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "baseline",
        summary: baselineRun.error ? `Baseline evaluation crashed: ${baselineRun.error}` : "Measured the starting revision once.",
        metrics: flattenMetrics(baseline),
        evaluations: baseline,
        metadata: { tournament: { baseline: true, evaluatorOrder: config.evaluators.map((item) => item.id) } }
      };
      experiments.push(record);
      await context.appendRecord(record);
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }

    const baselineMetrics = flattenMetrics(baseline);
    if (baseline.some((evaluation) => evaluation.status === "fail") || baselineMetrics[context.campaign.acceptance.primaryMetric] === undefined) {
      return result(context, experiments, "blocked", `Baseline did not pass or produce ${context.campaign.acceptance.primaryMetric}.`);
    }
    let activeBaseline: Evaluation[] = baseline;

    let round = nextRound(experiments);
    while (!context.signal.aborted) {
      const remaining = context.budget.remainingExperiments();
      const roundSize = Math.min(config.candidateCount, remaining);
      if (roundSize <= 0) return result(context, experiments, "budget-exhausted", "maximum experiments reached");
      const allowance = context.budget.canStart(roundSize);
      if (!allowance.allowed) return result(context, experiments, "budget-exhausted", allowance.reason ?? "Budget exhausted.");

      const history = [...experiments];
      const specifications = Array.from({ length: roundSize }, (_, index) => {
        const slot = index + 1;
        const agent = agents[index % agents.length];
        if (!agent) throw new Error("Tournament has no agent driver.");
        return {
          experimentId: `tournament-r${String(round).padStart(4, "0")}-c${String(slot).padStart(3, "0")}`,
          slot,
          agent
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
        return result(context, experiments, "budget-exhausted", "Unable to reserve the next tournament round within budget.");
      }

      for (const specification of specifications) {
        await context.emit({
          type: "experiment:start",
          campaignId: context.campaign.id,
          experimentId: specification.experimentId,
          at: new Date().toISOString()
        });
      }

      const runs = await mapBounded(specifications, Math.min(config.concurrency, roundSize), async (specification) =>
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
          reservations[specification.slot - 1]!
        ));

      const ranked: RankedCandidate[] = context.signal.aborted ? [] : rankCandidates(context, activeBaseline, runs);
      const winner: RankedCandidate | undefined = ranked[0];
      const cleanupSignal = new AbortController().signal;
      const losers: CandidateRun[] = runs.filter((run) => run !== winner?.run).sort((left, right) => left.slot - right.slot);
      const finalizationOrder: CandidateRun[] = winner ? [...losers, winner.run] : losers;

      for (const run of finalizationOrder) {
        const ranking = ranked.findIndex((item) => item.run === run);
        const decision = ranking >= 0 ? ranked[ranking]?.decision : undefined;
        const isWinner = winner?.run === run;
        let status: ExperimentRecord["status"] = context.signal.aborted ? "cancelled" : run.error ? "crash" : isWinner ? "keep" : "discard";
        let revision: string | undefined;
        let candidateRevision: string | undefined;
        let finalizationError: string | undefined;

        if (run.candidate) {
          try {
            if (isWinner) {
              const acceptance = await workspace.acceptCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal });
              revision = acceptance.revision;
              candidateRevision = acceptance.candidateRevision;
              if (acceptance.changed === false) status = "discard";
            } else {
              await workspace.discardCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal });
            }
          } catch (error) {
            finalizationError = errorMessage(error);
            status = "crash";
            if (isWinner) {
              await workspace.discardCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal }).catch(() => undefined);
            }
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
              ...(candidateRevision ? { candidateRevision } : {})
            },
            ...(run.agentResult?.metadata ? { agent: run.agentResult.metadata } : {})
          }
        };

        if (status === "keep") activeBaseline = run.evaluations;
        experiments.push(record);
        run.reservation.settle({ status, ...(run.agentResult?.usage?.costUsd !== undefined ? { actualCostUsd: run.agentResult.usage.costUsd } : {}) });
        await context.appendRecord(record);
        await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
      }

      round += 1;
    }
    return result(context, experiments, "cancelled", "Campaign was cancelled; all completed candidate workspaces were discarded.");
  }
}

export default defineExtension((api) => api.register("workflow", "tournament", new TournamentWorkflow()));
