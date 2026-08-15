import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { decideAcceptance, flattenMetrics } from "@gamefactory/core";
import type {
  AgentDriver,
  AgentResult,
  ArtifactReference,
  BudgetReservationLike,
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
  asObject,
  campaignResult as createCampaignResult,
  errorMessage,
  evaluateWaterfall,
  evaluatorPlans,
  failureAgentResult,
  isArtifactPreservationFailure,
  journalPhase,
  mapBounded,
  positiveInteger,
  preserveAgentResult,
  recoverWorkflow,
  replayBudget,
  type EvaluatorPlan
} from "@gamefactory/workflow-sdk";

const exec = promisify(execFile);

interface DiscoveryConfig {
  workspace: string;
  agents: string[];
  evaluators: EvaluatorPlan[];
  prototypeCount: number;
  shortlistCount: number;
  concurrency: number;
  selection: "recommend" | "accept";
}

interface PrototypeRun {
  experimentId: string;
  slot: number;
  startedAt: string;
  agentId: string;
  reservation: BudgetReservationLike;
  candidate?: Candidate;
  agentResult?: AgentResult;
  evaluations: Evaluation[];
  patch?: ArtifactReference;
  error?: string;
  preservationBlocked?: boolean;
}

export function parseDiscoveryConfig(context: WorkflowContext): DiscoveryConfig {
  const value = asObject(context.campaign.parameters?.discovery);
  const agents = Array.isArray(value.agents) ? value.agents.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const prototypeCount = Math.min(32, positiveInteger(value.prototypeCount, 3));
  const shortlistCount = Math.min(prototypeCount, positiveInteger(value.shortlistCount, Math.min(3, prototypeCount)));
  const selection = value.selection === "accept" ? "accept" : "recommend";
  return {
    workspace: typeof value.workspace === "string" ? value.workspace : "mock.workspace",
    agents: agents.length > 0 ? agents : ["mock.agent"],
    evaluators: Array.isArray(value.evaluators) ? evaluatorPlans(value.evaluators) : [],
    prototypeCount,
    shortlistCount,
    concurrency: Math.min(prototypeCount, positiveInteger(value.concurrency, Math.min(2, prototypeCount))),
    selection
  };
}

async function capturePatch(candidate: Candidate, experimentId: string): Promise<ArtifactReference | undefined> {
  const [{ stdout: trackedPatch }, { stdout: untrackedOutput }] = await Promise.all([
    exec("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: candidate.root, maxBuffer: 16 * 1024 * 1024 }),
    exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: candidate.root, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 })
  ]);
  const root = resolve(candidate.root);
  let capturedBytes = 0;
  const maximumCapturedBytes = 16 * 1024 * 1024;
  const untrackedFiles = [];
  for (const projectPath of Buffer.from(untrackedOutput).toString("utf8").split("\0").filter(Boolean).sort()) {
    const path = resolve(root, projectPath);
    const traversal = relative(root, path);
    if (!traversal || traversal.startsWith("..")) throw new Error(`Unsafe untracked prototype path: ${projectPath}`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const content = Buffer.from(target, "utf8");
      if (capturedBytes + content.length > maximumCapturedBytes) throw new Error(`Prototype bundle exceeds ${maximumCapturedBytes} bytes; candidate retained for manual evidence recovery.`);
      capturedBytes += content.length;
      untrackedFiles.push({ path: projectPath.replaceAll("\\", "/"), kind: "symlink", target, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length });
      continue;
    }
    if (!info.isFile()) throw new Error(`Unsupported untracked prototype entry: ${projectPath}`);
    const canonical = await realpath(path);
    const canonicalTraversal = relative(await realpath(root), canonical);
    if (!canonicalTraversal || canonicalTraversal.startsWith("..") || isAbsolute(canonicalTraversal)) throw new Error(`Prototype file escapes candidate root: ${projectPath}`);
    const content = await readFile(canonical);
    if (capturedBytes + content.length > maximumCapturedBytes) {
      throw new Error(`Prototype bundle exceeds ${maximumCapturedBytes} bytes; candidate retained for manual evidence recovery.`);
    }
    capturedBytes += content.length;
    untrackedFiles.push({
      path: projectPath.replaceAll("\\", "/"),
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
      base64: content.toString("base64")
    });
  }
  if (trackedPatch.length === 0 && untrackedFiles.length === 0) return undefined;
  const directory = resolve(candidate.root, ".factory", "discovery");
  const path = resolve(directory, `${experimentId}.prototype.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify({
    apiVersion: "gamefactory.prototype-bundle/v1",
    experimentId,
    trackedPatch,
    untrackedFiles,
    complete: true
  }, null, 2)}\n`, "utf8");
  return { path, kind: "other", mediaType: "application/json", label: "Discarded prototype bundle" };
}

function discoveryResult(context: WorkflowContext, experiments: ExperimentRecord[], bestMetrics: Record<string, number>, summary: string) {
  return createCampaignResult(context, experiments, context.signal.aborted ? "cancelled" : "complete", summary, bestMetrics);
}

export class DiscoveryWorkflow implements Workflow {
  readonly id = "discovery";

  async run(context: WorkflowContext): Promise<CampaignResult> {
    const config = parseDiscoveryConfig(context);
    if (config.evaluators.length === 0) throw new Error("parameters.discovery.evaluators must contain at least one evaluator");
    const workspace = context.get<WorkspaceDriver>("workspace", config.workspace);
    const recovery = await recoverWorkflow(context, workspace);
    const experiments = await context.readRecords();
    if (recovery.blocked) return createCampaignResult(context, experiments, "blocked", recovery.blocked);
    replayBudget(context, experiments);
    const previous = experiments.filter((record) => asObject(record.metadata?.discovery).prototype === true);
    if (previous.length >= config.prototypeCount) {
      const recommended = previous.find((record) => asObject(record.metadata?.discovery).recommended === true);
      return discoveryResult(context, experiments, recommended?.metrics ?? {}, "Discovery batch already completed; no prototypes were repeated.");
    }
    const available = Math.min(config.prototypeCount - previous.length, context.budget.remainingExperiments());
    const specifications: Array<{ slot: number; experimentId: string; agentId: string; agent: AgentDriver; reservation: BudgetReservationLike }> = [];
    for (let index = 0; index < available; index += 1) {
      const slot = previous.length + index + 1;
      const experimentId = `discovery-p${String(slot).padStart(3, "0")}`;
      const reservation = context.budget.tryReserve({ experimentId });
      if (!reservation) break;
      const agentId = config.agents[index % config.agents.length]!;
      specifications.push({ slot, experimentId, agentId, agent: context.get<AgentDriver>("agent", agentId), reservation });
    }
    const runs = await mapBounded(specifications, config.concurrency, async (specification): Promise<PrototypeRun> => {
      const startedAt = new Date().toISOString();
      let candidate: Candidate | undefined;
      try {
        await journalPhase(context, specification.experimentId, "reserved", { startedAt, slot: specification.slot });
        await context.emit({ type: "experiment:start", campaignId: context.campaign.id, experimentId: specification.experimentId, at: startedAt });
        candidate = await workspace.createCandidate({ campaign: context.campaign, experimentId: specification.experimentId, signal: context.signal, ...(context.runtime ? { runtime: context.runtime } : {}) });
        candidate = {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            discovery: {
              slot: specification.slot,
              prototypeCount: config.prototypeCount,
              directive: "Develop a materially distinct design hypothesis. Preserve hard boundaries, treat preferences as negotiable, explore declared open space, and do not optimize only for the visible score."
            }
          }
        };
        await journalPhase(context, specification.experimentId, "candidate-created", { candidate });
        const agentResult = await preserveAgentResult(context, await specification.agent.run({ campaign: context.campaign, candidate, experimentId: specification.experimentId, history: [...experiments], signal: context.signal, ...(context.trace ? { trace: context.trace } : {}) }), specification.experimentId);
        await journalPhase(context, specification.experimentId, "agent-finished", agentJournalData(agentResult));
        let preservedPatch: ArtifactReference | undefined;
        try {
          const patch = await capturePatch(candidate, specification.experimentId);
          preservedPatch = patch ? (await context.preserveArtifacts([patch], `${specification.experimentId}/prototype`))[0] : undefined;
        } catch (evidenceError) {
          return {
            experimentId: specification.experimentId,
            slot: specification.slot,
            startedAt,
            agentId: specification.agentId,
            reservation: specification.reservation,
            candidate,
            agentResult,
            evaluations: [],
            error: errorMessage(evidenceError),
            preservationBlocked: true
          };
        }
        const evaluations = (await evaluateWaterfall(context, config.evaluators, candidate, specification.experimentId)).evaluations;
        await journalPhase(context, specification.experimentId, "evaluated", { evaluations });
        await journalPhase(context, specification.experimentId, "evidence-preserved", { patch: preservedPatch ?? null });
        return {
          experimentId: specification.experimentId,
          slot: specification.slot,
          startedAt,
          agentId: specification.agentId,
          reservation: specification.reservation,
          candidate,
          agentResult,
          evaluations,
          ...(preservedPatch ? { patch: preservedPatch } : {})
        };
      } catch (error) {
        const failure = failureAgentResult(error);
        let outcomeError: unknown = error;
        let agentResult: AgentResult | undefined;
        try {
          agentResult = failure ? await preserveAgentResult(context, failure, specification.experimentId) : undefined;
        } catch (preservationError) {
          outcomeError = preservationError;
        }
        return {
          experimentId: specification.experimentId,
          slot: specification.slot,
          startedAt,
          agentId: specification.agentId,
          reservation: specification.reservation,
          ...(candidate ? { candidate } : {}),
          ...(agentResult ? { agentResult } : {}),
          evaluations: [],
          error: errorMessage(outcomeError),
          ...(isArtifactPreservationFailure(outcomeError) ? { preservationBlocked: true } : {})
        };
      }
    });
    const ranked = runs.flatMap((run) => {
      if (run.error || !run.candidate || run.evaluations.some((evaluation) => evaluation.status === "fail")) return [];
      const decision = decideAcceptance(context.campaign.acceptance, [], run.evaluations, context.campaign.humanGates ? { humanGates: context.campaign.humanGates } : {});
      const value = flattenMetrics(run.evaluations)[context.campaign.acceptance.primaryMetric];
      return decision.accepted && value !== undefined && Number.isFinite(value) ? [{ run, value, decision }] : [];
    }).sort((left, right) => {
      const order = context.campaign.acceptance.direction === "maximize" ? right.value - left.value : left.value - right.value;
      return order || left.run.experimentId.localeCompare(right.run.experimentId);
    });
    const recommendation = ranked[0];
    const shortlist = ranked.slice(0, config.shortlistCount);
    const cleanupSignal = new AbortController().signal;
    let workflowBlocked = runs.some((run) => run.preservationBlocked);
    const orderedRuns = [...runs].sort((left, right) => left.slot - right.slot);
    if (recommendation) {
      const winnerIndex = orderedRuns.indexOf(recommendation.run);
      if (winnerIndex >= 0) orderedRuns.push(...orderedRuns.splice(winnerIndex, 1));
    }
    for (const run of orderedRuns) {
      const recommended = recommendation?.run === run;
      const shortlisted = shortlist.some((item) => item.run === run);
      const shouldAccept = recommended && config.selection === "accept" && !workflowBlocked;
      let status: ExperimentRecord["status"] = run.preservationBlocked ? "blocked" : run.error ? "crash" : "discard";
      let revision: string | undefined;
      let candidateRevision: string | undefined;
      let finalizationError: string | undefined;
      if (run.candidate && !run.preservationBlocked) {
        try {
          await journalPhase(context, run.experimentId, "acceptance-intent", {
            action: shouldAccept ? "accept" : "discard",
            recommended,
            shortlisted
          });
          if (shouldAccept) {
            const accepted = await workspace.acceptCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal });
            if (accepted.changed !== false) {
              status = "keep";
              revision = accepted.revision;
              candidateRevision = accepted.candidateRevision;
            } else {
              await workspace.discardCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal });
            }
          } else {
            await workspace.discardCandidate({ campaign: context.campaign, candidate: run.candidate, signal: cleanupSignal });
          }
        } catch (error) {
          status = "blocked";
          finalizationError = error instanceof Error ? error.message : String(error);
          workflowBlocked = true;
        }
      }
      const rank = ranked.findIndex((item) => item.run === run);
      const record: ExperimentRecord = {
        campaignId: context.campaign.id,
        experimentId: run.experimentId,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        status,
        ...(run.candidate ? { candidateId: run.candidate.id } : {}),
        ...(revision ? { revision } : {}),
        summary: [run.agentResult?.summary, run.error, finalizationError, recommended
          ? status === "keep" ? "Selected and accepted." : config.selection === "accept" ? "Ranked first, but acceptance was blocked; candidate state was retained or safely discarded." : "Ranked first for human direction review; candidate discarded after preserving evidence."
          : shortlisted ? "Shortlisted for human direction review; candidate discarded after preserving evidence." : "Not shortlisted."].filter(Boolean).join(" "),
        metrics: flattenMetrics(run.evaluations),
        evaluations: run.evaluations,
        ...((run.agentResult?.contributors?.length ?? 0) > 0 || (run.agentResult?.artifacts?.length ?? 0) > 0 || run.patch ? {
          agent: {
            summary: run.agentResult?.summary ?? "",
            contributors: run.agentResult?.contributors ?? [],
            artifacts: [...(run.agentResult?.artifacts ?? []), ...(run.patch ? [run.patch] : [])]
          }
        } : {}),
        ...(run.agentResult?.usage ? { usage: run.agentResult.usage } : {}),
        metadata: {
          discovery: {
            prototype: true,
            slot: run.slot,
            agent: run.agentId,
            selection: config.selection,
            recommended,
            shortlisted,
            ...(rank >= 0 ? { rank: rank + 1 } : {}),
            ...(candidateRevision ? { candidateRevision } : {}),
            ...(finalizationError ? { finalizationError } : {})
          }
        }
      };
      const candidateBlocked = Boolean(run.preservationBlocked || finalizationError);
      if (candidateBlocked) {
        workflowBlocked = true;
        await journalPhase(context, run.experimentId, "blocked", { record, candidateRetained: Boolean(run.candidate) });
      } else {
        await journalPhase(context, run.experimentId, "applied", { record });
      }
      experiments.push(record);
      run.reservation.settle({ status, ...(run.agentResult?.usage?.costUsd !== undefined ? { actualCostUsd: run.agentResult.usage.costUsd } : {}) });
      await context.appendRecord(record);
      if (!candidateBlocked) {
        await journalPhase(context, run.experimentId, "recorded", { status });
        await journalPhase(context, run.experimentId, "cleaned");
      }
      await context.emit({ type: "experiment:finish", record, at: record.finishedAt });
    }
    if (workflowBlocked) return createCampaignResult(context, experiments, "blocked", "At least one prototype was retained because evidence preservation or finalization could not be confirmed.");
    if (!recommendation) return discoveryResult(context, experiments, {}, "Discovery completed, but no prototype passed every evaluator and required gate.");
    const bestMetrics = flattenMetrics(recommendation.run.evaluations);
    return discoveryResult(
      context,
      experiments,
      bestMetrics,
      config.selection === "accept"
        ? `Accepted ${recommendation.run.experimentId} after divergent comparison.`
        : `Shortlisted ${shortlist.length} divergent prototype${shortlist.length === 1 ? "" : "s"}; ${recommendation.run.experimentId} ranked first on the configured proxy, and all worktrees were discarded after evidence preservation for human direction review.`
    );
  }
}

export default defineExtension((api) => api.register("workflow", "discovery", new DiscoveryWorkflow()));
