import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { FactoryRunner, loadCampaign, loadFactoryConfig, resolveCampaignRunIdentity, resolveFactoryStatePath, type Campaign, type CampaignResult, type FactoryConfig, type FactoryTraceEvent, type JournalJsonValue, type Logger } from "@gamefactory/core";
import { acquireProjectLease, ProjectJourneyJournal, type ProjectJourneyIndex } from "./journal.js";
import { projectManifestFingerprint } from "./manifest.js";
import { gameSpecFingerprint, loadGameSpec } from "./spec.js";
import type { GameFactoryProject, GameSpec, LoadedGameFactoryProject, LoadedProjectPhase, LoadedProjectPhaseAttempt, ProjectJourneyEvent, ProjectRunResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ProjectCampaignExecution {
  campaign: Campaign;
  config: FactoryConfig;
  campaignResult: CampaignResult;
  runId: string;
}

export interface ProjectRunnerOptions {
  cwd: string;
  dataRoot?: string;
  worktreeRoot?: string;
  onTraceEvent?: (event: FactoryTraceEvent) => Promise<void> | void;
  journeyIndex?: ProjectJourneyIndex;
  logger: Logger;
  signal?: AbortSignal;
  executeCampaign?: (input: { campaign: Campaign; config: FactoryConfig; signal: AbortSignal }) => Promise<CampaignResult>;
}

async function gitRevision(root: string): Promise<string | undefined> {
  try {
    const { stdout: revision } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { windowsHide: true });
    const { stdout: status } = await execFileAsync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { windowsHide: true });
    if (status.trim()) throw new Error("Project repository is dirty; commit or stash changes before advancing the project.");
    return revision.trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Project repository is dirty")) throw error;
    return undefined;
  }
}

function rawProject(project: LoadedGameFactoryProject): GameFactoryProject {
  const attempts = (values: LoadedProjectPhaseAttempt[]) => values.map(({ campaignPath: _campaignPath, configPath: _configPath, ...attempt }) => attempt);
  if (project.apiVersion === "gamefactory.dev/v2") {
    if (!project.preproduction || !project.slices) throw new Error("Loaded v2 project is missing preproduction or slices");
    const { conceptPath: _conceptPath, specPath: _specPath, attempts: specAttempts, ...preproduction } = project.preproduction;
    return {
      apiVersion: "gamefactory.dev/v2", kind: project.kind, id: project.id, title: project.title, projectRoot: project.projectRoot,
      ...(project.history ? { history: project.history } : {}),
      preproduction: { ...preproduction, attempts: attempts(specAttempts) },
      slices: project.slices.map(({ attempts: sliceAttempts, ...slice }) => ({ ...slice, attempts: attempts(sliceAttempts) }))
    };
  }
  return { apiVersion: "gamefactory.dev/v1", kind: project.kind, id: project.id, title: project.title, projectRoot: project.projectRoot, ...(project.history ? { history: project.history } : {}), phases: project.phases.map(({ attempts: phaseAttempts, workKind: _workKind, ...phase }) => ({ ...phase, attempts: attempts(phaseAttempts) })) };
}

function activeAttempt(phase: LoadedProjectPhase): LoadedProjectPhaseAttempt {
  return phase.attempts.find((item) => (item.status ?? "active") === "active")!;
}

function campaignForPhase(campaign: Campaign, phase: LoadedProjectPhase): Campaign {
  if (phase.workKind !== "vertical-slice") return campaign;
  const agentTeam = campaign.parameters?.agentTeam;
  if (!agentTeam || typeof agentTeam !== "object" || Array.isArray(agentTeam)) return campaign;
  const graph = (agentTeam as Record<string, unknown>).graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return campaign;
  const existingPolicy = (graph as Record<string, unknown>).attemptPolicy;
  const policy = existingPolicy && typeof existingPolicy === "object" && !Array.isArray(existingPolicy) ? existingPolicy as Record<string, unknown> : {};
  const attemptPolicy = phase.attemptPolicy;
  return {
    ...campaign,
    parameters: {
      ...campaign.parameters,
      agentTeam: {
        ...(agentTeam as Record<string, unknown>),
        graph: {
          ...(graph as Record<string, unknown>),
          claimIds: phase.consumesClaims ?? [],
          enforceClaimedBlockers: true,
          ...(attemptPolicy ? { attemptPolicy: { ...policy, ...(attemptPolicy.executionRetries !== undefined ? { executionRetries: attemptPolicy.executionRetries } : {}), ...(attemptPolicy.creativeRepairs !== undefined ? { creativeRepairs: attemptPolicy.creativeRepairs } : {}), ...(attemptPolicy.advisorEscalations !== undefined ? { advisorEscalations: attemptPolicy.advisorEscalations } : {}) } } : {})
        }
      }
    }
  };
}

function gateReasons(phase: LoadedProjectPhase, result: CampaignResult): { reasons: string[]; acceptedRevision?: string } {
  const reasons: string[] = [];
  const accepted = [...result.experiments].reverse().find((record) => record.status === "keep" && record.revision);
  if (phase.gate?.requireAcceptedRevision && !accepted?.revision) reasons.push("Phase requires an accepted revision, but the campaign did not record one.");
  if (phase.gate?.requireHumanApproval) reasons.push("Phase requires human approval before automatic advancement.");
  for (const [metric, bounds] of Object.entries(phase.gate?.requireMetrics ?? {})) {
    const value = result.bestMetrics[metric];
    if (typeof value !== "number") reasons.push(`Required metric ${metric} was not reported.`);
    else {
      if (bounds.minimum !== undefined && value < bounds.minimum) reasons.push(`${metric} ${value} is below ${bounds.minimum}.`);
      if (bounds.maximum !== undefined && value > bounds.maximum) reasons.push(`${metric} ${value} is above ${bounds.maximum}.`);
    }
  }
  if (result.status !== "complete" && result.status !== "budget-exhausted") reasons.push(`Campaign finished with ${result.status}.`);
  return { reasons, ...(accepted?.revision ? { acceptedRevision: accepted.revision } : {}) };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function journalData(value: unknown): JournalJsonValue {
  return JSON.parse(JSON.stringify(value)) as JournalJsonValue;
}

function normalizedText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function keptRecord(result: CampaignResult) {
  return [...result.experiments].reverse().find((record) => record.status === "keep");
}

function evidenceReasons(phase: LoadedProjectPhase, result: CampaignResult): string[] {
  if (phase.workKind !== "vertical-slice" || !phase.evidence) return [];
  const metadata = keptRecord(result)?.metadata?.projectEvidence;
  const evidence = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const reasons: string[] = [];
  const actualScenarios = new Set(Array.isArray(evidence.scenarios) ? evidence.scenarios.filter((item): item is string => typeof item === "string") : []);
  for (const scenario of phase.evidence.scenarios ?? []) if (!actualScenarios.has(scenario) && result.bestMetrics[`scenario.${scenario}.passed`] !== 1) reasons.push(`Required slice scenario ${scenario} was not reported in projectEvidence.`);
  if (phase.evidence.requireInteractionTrace && evidence.interactionTrace !== true && result.bestMetrics.interaction_trace !== 1) reasons.push("Slice requires a real interaction trace.");
  if (phase.evidence.requireEngineCapture && evidence.engineCapture !== true && result.bestMetrics.engine_capture !== 1) reasons.push("Slice requires a current engine capture.");
  if (phase.evidence.requireMotionEvidence && evidence.motionEvidence !== true && result.bestMetrics.motion_evidence !== 1) reasons.push("Slice requires current runtime motion evidence.");
  const actualAssets = new Set(Array.isArray(evidence.runtimeAssets) ? evidence.runtimeAssets.filter((item): item is string => typeof item === "string") : []);
  for (const asset of phase.evidence.requireRuntimeAssets ?? []) if (!actualAssets.has(asset) && result.bestMetrics[`runtime_asset.${asset}`] !== 1) reasons.push(`Required runtime asset family ${asset} was not evidenced in the engine.`);
  return reasons;
}

function eventType(phase: LoadedProjectPhase, state: "started" | "complete" | "blocked"): ProjectJourneyEvent["type"] {
  if (phase.workKind === "spec-convergence") return state === "started" ? "spec-started" : state === "complete" ? "spec-frozen" : "spec-blocked";
  if (phase.workKind === "vertical-slice") return state === "started" ? "slice-started" : state === "complete" ? "slice-completed" : "slice-blocked";
  return state === "started" ? "phase-started" : state === "complete" ? "phase-completed" : "phase-blocked";
}

async function validateFrozenSpec(project: LoadedGameFactoryProject): Promise<{ spec: GameSpec; fingerprint: string }> {
  if (!project.preproduction) throw new Error("Project v2 is missing preproduction configuration");
  const [concept, spec] = await Promise.all([readFile(project.preproduction.conceptPath, "utf8"), loadGameSpec(project.preproduction.specPath, project.id)]);
  if (spec.status !== "frozen") throw new Error(`GameSpec revision ${spec.revision} is not frozen`);
  if (normalizedText(spec.concept) !== normalizedText(concept)) throw new Error("Frozen GameSpec does not preserve the supplied concept verbatim");
  return { spec, fingerprint: gameSpecFingerprint(spec) };
}

async function unitFingerprint(input: { phase: LoadedProjectPhase; campaign: Campaign; config: FactoryConfig; project: LoadedGameFactoryProject; dependencies: Record<string, string | undefined>; frozenSpec?: { spec: GameSpec; fingerprint: string } }): Promise<{ fingerprint: string; spec?: { spec: GameSpec; fingerprint: string }; claimFingerprint?: string }> {
  const runId = resolveCampaignRunIdentity(input.campaign, input.config).runId;
  if (input.phase.workKind === "spec-convergence") {
    const concept = input.project.preproduction ? await readFile(input.project.preproduction.conceptPath, "utf8") : "";
    const maximumConvergencePasses = input.project.preproduction?.maximumConvergencePasses ?? input.project.preproduction?.maximumRevisions ?? 3;
    return { fingerprint: hash({ kind: "spec-convergence", concept: createHash("sha256").update(concept).digest("hex"), runId, maximumConvergencePasses }) };
  }
  if (input.phase.workKind === "vertical-slice") {
    const frozenSpec = input.frozenSpec ?? await validateFrozenSpec(input.project);
    const claims = input.phase.consumesClaims ?? [];
    const unresolvedClaims = claims.filter((id) => frozenSpec.spec.claims.find((claim) => claim.id === id)?.status === "open");
    if (unresolvedClaims.length > 0) throw new Error(`Project slice ${input.phase.id} consumes unresolved GameSpec claims: ${unresolvedClaims.join(", ")}`);
    const claimFingerprint = gameSpecFingerprint(frozenSpec.spec, claims);
    const plan = frozenSpec.spec.slices.find((item) => item.id === input.phase.id);
    if (!plan) throw new Error(`Frozen GameSpec does not define project slice ${input.phase.id}`);
    const missing = claims.filter((claim) => !plan.claimIds.includes(claim));
    if (missing.length > 0) throw new Error(`Project slice ${input.phase.id} consumes claims absent from its frozen spec plan: ${missing.join(", ")}`);
    const implementationDependencies = Object.fromEntries(Object.entries(input.dependencies).filter(([id]) => input.project.phases.find((phase) => phase.id === id)?.workKind !== "spec-convergence"));
    return { fingerprint: hash({ kind: "vertical-slice", runId, claimFingerprint, dependencies: implementationDependencies, playerOutcome: input.phase.playerOutcome, primaryRisk: input.phase.primaryRisk, evidence: input.phase.evidence ?? {} }), spec: frozenSpec, claimFingerprint };
  }
  return { fingerprint: hash({ kind: "legacy-phase", runId, manifest: projectManifestFingerprint(rawProject(input.project)) }) };
}

export class ProjectRunner {
  readonly journal: ProjectJourneyJournal;
  readonly manifestFingerprint: string;
  private historyImport?: Promise<void>;

  constructor(readonly project: LoadedGameFactoryProject, private readonly options: ProjectRunnerOptions) {
    const logicalJournal = join(".factory", "projects", project.id, "journey.jsonl");
    this.journal = new ProjectJourneyJournal(resolveFactoryStatePath({ cwd: project.root, ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}) }, logicalJournal, logicalJournal, "project journey"), options.journeyIndex);
    this.manifestFingerprint = projectManifestFingerprint(rawProject(project));
  }

  private async ensureHistoryImported(): Promise<void> {
    if (!this.project.historyPath) return;
    this.historyImport ??= (async () => {
      const seed = await new ProjectJourneyJournal(this.project.historyPath!).read();
      for (const event of seed) {
        const { version: _version, sequence: _sequence, timestamp: _timestamp, ...input } = event;
        await this.journal.append(input);
      }
    })();
    await this.historyImport;
  }

  async readJourney(): Promise<Awaited<ReturnType<ProjectJourneyJournal["read"]>>> {
    await this.ensureHistoryImported();
    return this.journal.read();
  }

  async doctor(): Promise<Array<{ phaseId: string; attemptId: string; capability: string; ok: boolean; message: string }>> {
    const output: Array<{ phaseId: string; attemptId: string; capability: string; ok: boolean; message: string }> = [];
    for (const phase of [...this.project.phases].sort((a, b) => a.order - b.order)) {
      const attempt = activeAttempt(phase);
      const [loadedCampaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
      const campaign = campaignForPhase(loadedCampaign, phase);
      const runner = new FactoryRunner({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, ...(this.options.signal ? { signal: this.options.signal } : {}) });
      try { await runner.initialize(); for (const check of await runner.doctor(campaign)) output.push({ phaseId: phase.id, attemptId: attempt.id, ...check }); }
      finally { await runner.dispose(); }
    }
    if (this.project.apiVersion === "gamefactory.dev/v2" && this.project.preproduction) {
      try { await readFile(this.project.preproduction.conceptPath, "utf8"); output.push({ phaseId: this.project.preproduction.id ?? "spec-convergence", attemptId: activeAttempt(this.project.phases[0]!).id, capability: "project:concept", ok: true, message: "Concept source is readable." }); }
      catch (error) { output.push({ phaseId: this.project.preproduction.id ?? "spec-convergence", attemptId: activeAttempt(this.project.phases[0]!).id, capability: "project:concept", ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
    return output;
  }

  async run(): Promise<ProjectRunResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(this.options.signal?.reason);
    if (this.options.signal?.aborted) abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    await this.ensureHistoryImported();
    const events = await this.journal.read();
    const latestStart = [...events].reverse().find((event) => event.type === "project-started");
    const terminal = latestStart && events.some((event) => event.projectRunId === latestStart.projectRunId && event.type === "project-finished");
    const projectRunId = latestStart && !terminal && latestStart.manifestFingerprint === this.manifestFingerprint ? latestStart.projectRunId : `${this.project.id}-${randomUUID()}`;
    const startedAt = latestStart?.projectRunId === projectRunId ? latestStart.timestamp : new Date().toISOString();
    const baseRevision = await gitRevision(this.project.root);
    if (latestStart?.projectRunId === projectRunId) {
      const latestRevision = [...events].reverse().find((event) => event.projectRunId === projectRunId && event.resultingRevision)?.resultingRevision ?? latestStart.sourceRevision;
      if (latestRevision && baseRevision && latestRevision !== baseRevision) throw new Error(`Project revision changed outside the recorded journey: expected ${latestRevision}, found ${baseRevision}.`);
    }
    const logicalLease = join(".factory", "projects", this.project.id, "run.lock");
    const leasePath = resolveFactoryStatePath({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) }, logicalLease, logicalLease, "project lease");
    const release = await acquireProjectLease(leasePath, projectRunId);
    const phases: ProjectRunResult["phases"] = [];
    try {
      if (latestStart?.projectRunId !== projectRunId) await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-started", idempotencyKey: `${projectRunId}:started`, manifestFingerprint: this.manifestFingerprint, actor: { kind: "factory" }, ...(baseRevision ? { sourceRevision: baseRevision } : {}), data: { title: this.project.title } });
      const currentEvents = await this.journal.read();
      const completionTypes = new Set<ProjectJourneyEvent["type"]>(["phase-completed", "spec-frozen", "slice-completed", "promotion-applied"]);
      const completedEvents = currentEvents.filter((event) => event.projectRunId === projectRunId && completionTypes.has(event.type));
      const completed = new Set(completedEvents.map((event) => event.phaseId).filter((id): id is string => Boolean(id)));
      const acceptedByPhase = new Map<string, string | undefined>();
      for (const event of completedEvents) if (event.phaseId) acceptedByPhase.set(event.phaseId, event.resultingRevision);
      let frozenSpec: { spec: GameSpec; fingerprint: string } | undefined;
      for (const phase of [...this.project.phases].sort((left, right) => left.order - right.order)) {
        const missing = (phase.dependsOn ?? []).filter((id) => !completed.has(id));
        if (missing.length > 0) {
          const reasons = [`Dependencies are incomplete: ${missing.join(", ")}`];
          phases.push({ phaseId: phase.id, attemptId: activeAttempt(phase).id, status: "blocked", reasons, ...(phase.workKind ? { workKind: phase.workKind } : {}) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${projectRunId}:blocked:${phase.id}:dependencies`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, actor: { kind: "factory" }, data: { reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        const attempt = activeAttempt(phase);
        const [loadedCampaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
        const campaign = campaignForPhase(loadedCampaign, phase);
        const runId = resolveCampaignRunIdentity(campaign, config).runId;
        const dependencies = Object.fromEntries((phase.dependsOn ?? []).map((id) => [id, acceptedByPhase.get(id)]));
        const unit = await unitFingerprint({ phase, campaign, config, project: this.project, dependencies, ...(frozenSpec ? { frozenSpec } : {}) });
        const phaseKind = phase.workKind ?? "legacy-phase";
        const currentCompletion = [...currentEvents].reverse().find((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && completionTypes.has(event.type) && (phaseKind === "legacy-phase" || event.unitFingerprint === unit.fingerprint));
        let reusable = currentCompletion;
        if (!reusable && phaseKind !== "legacy-phase") reusable = [...currentEvents].reverse().find((event) => event.phaseId === phase.id && completionTypes.has(event.type) && event.unitFingerprint === unit.fingerprint);
        if (reusable && phaseKind === "spec-convergence") {
          try { frozenSpec = await validateFrozenSpec(this.project); if (reusable.specFingerprint !== frozenSpec.fingerprint) reusable = undefined; }
          catch { reusable = undefined; }
        }
        if (reusable) {
          completed.add(phase.id);
          acceptedByPhase.set(phase.id, reusable.resultingRevision);
          const reusedAcrossRuns = reusable.projectRunId !== projectRunId;
          if (reusedAcrossRuns) await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "complete"), idempotencyKey: `${projectRunId}:${phase.id}:reused:${unit.fingerprint}`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(reusable.specRevision !== undefined ? { specRevision: reusable.specRevision } : {}), ...(reusable.specFingerprint ? { specFingerprint: reusable.specFingerprint } : {}), ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(reusable.resultingRevision ? { resultingRevision: reusable.resultingRevision } : {}), data: { reused: true, reusedFromProjectRunId: reusable.projectRunId } });
          phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "complete", ...(reusable.resultingRevision ? { acceptedRevision: reusable.resultingRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint, reused: reusedAcrossRuns });
          continue;
        }
        const startType = eventType(phase, "started");
        const terminalTypes = new Set<ProjectJourneyEvent["type"]>([eventType(phase, "complete"), eventType(phase, "blocked")]);
        const phaseStarts = currentEvents.filter((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.phaseAttemptId === attempt.id && event.type === startType && (phaseKind === "legacy-phase" || event.unitFingerprint === unit.fingerprint));
        const latestPhaseStart = phaseStarts.at(-1);
        const latestPhaseTerminal = latestPhaseStart && currentEvents.some((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.sequence > latestPhaseStart.sequence && terminalTypes.has(event.type));
        const execution = latestPhaseStart && !latestPhaseTerminal ? phaseStarts.length : phaseStarts.length + 1;
        const phaseKey = `${projectRunId}:${phase.id}:${attempt.id}:e${String(execution).padStart(4, "0")}`;
        if (!latestPhaseStart || latestPhaseTerminal) {
          const phaseRevision = await gitRevision(this.project.root);
          await this.journal.append({ projectId: this.project.id, projectRunId, type: startType, idempotencyKey: `${phaseKey}:started`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(phaseRevision ? { sourceRevision: phaseRevision } : {}), data: journalData({ ...(phase.playerOutcome ? { playerOutcome: phase.playerOutcome } : {}), ...(phase.primaryRisk ? { primaryRisk: phase.primaryRisk } : {}), ...(phase.attemptPolicy ? { attemptPolicy: phase.attemptPolicy } : {}) }) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "campaign-linked", idempotencyKey: `${phaseKey}:campaign-linked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, campaignId: campaign.id, runId, actor: { kind: "factory" } });
        }
        let campaignResult: CampaignResult;
        if (this.options.executeCampaign) campaignResult = await this.options.executeCampaign({ campaign, config, signal: controller.signal });
        else {
          const runner = new FactoryRunner({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, signal: controller.signal });
          try { await runner.initialize(); campaignResult = await runner.run(campaign); }
          finally { await runner.dispose(); }
        }
        const gate = gateReasons(phase, campaignResult);
        gate.reasons.push(...evidenceReasons(phase, campaignResult));
        if (phaseKind === "spec-convergence" && gate.reasons.length === 0) {
          try { frozenSpec = await validateFrozenSpec(this.project); }
          catch (error) { gate.reasons.push(error instanceof Error ? error.message : String(error)); }
        }
        if (gate.reasons.length > 0) {
          phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "blocked", campaignResult, reasons: gate.reasons, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "blocked"), idempotencyKey: `${phaseKey}:blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: { reasons: gate.reasons, campaignStatus: campaignResult.status } });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${phaseKey}:project-blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, data: { reasons: gate.reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        completed.add(phase.id);
        acceptedByPhase.set(phase.id, gate.acceptedRevision);
        phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "complete", campaignResult, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint });
        await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "complete"), idempotencyKey: `${phaseKey}:completed`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(frozenSpec ? { specRevision: frozenSpec.spec.revision, specFingerprint: frozenSpec.fingerprint } : {}), ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: journalData({ bestMetrics: campaignResult.bestMetrics, ...(unit.claimFingerprint ? { claimFingerprint: unit.claimFingerprint } : {}), ...(phaseKind === "spec-convergence" && frozenSpec?.spec.change ? { specChange: frozenSpec.spec.change } : {}), ...(phaseKind === "spec-convergence" && frozenSpec?.spec.supersedes ? { supersedes: frozenSpec.spec.supersedes } : {}) }) });
      }
      const resultingRevision = await gitRevision(this.project.root);
      await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-finished", idempotencyKey: `${projectRunId}:finished`, manifestFingerprint: this.manifestFingerprint, actor: { kind: "factory" }, ...(resultingRevision ? { resultingRevision } : {}) });
      return { projectId: this.project.id, projectRunId, status: "complete", startedAt, finishedAt: new Date().toISOString(), phases };
    } catch (error) {
      if (controller.signal.aborted) return { projectId: this.project.id, projectRunId, status: "cancelled", startedAt, finishedAt: new Date().toISOString(), phases };
      throw error;
    } finally {
      this.options.signal?.removeEventListener("abort", abort);
      await release();
    }
  }
}
