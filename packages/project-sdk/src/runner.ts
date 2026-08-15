import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { FactoryRunner, loadCampaign, loadFactoryConfig, resolveCampaignRunIdentity, resolveFactoryStatePath, type Campaign, type CampaignResult, type FactoryConfig, type FactoryTraceEvent, type Logger } from "@gamefactory/core";
import { acquireProjectLease, ProjectJourneyJournal, type ProjectJourneyIndex } from "./journal.js";
import { projectManifestFingerprint } from "./manifest.js";
import type { GameFactoryProject, LoadedGameFactoryProject, LoadedProjectPhase, LoadedProjectPhaseAttempt, ProjectRunResult } from "./types.js";

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
  return { apiVersion: project.apiVersion, kind: project.kind, id: project.id, title: project.title, projectRoot: project.projectRoot, ...(project.history ? { history: project.history } : {}), phases: project.phases.map(({ attempts, ...phase }) => ({ ...phase, attempts: attempts.map(({ campaignPath: _campaignPath, configPath: _configPath, ...attempt }) => attempt) })) };
}

function activeAttempt(phase: LoadedProjectPhase): LoadedProjectPhaseAttempt {
  return phase.attempts.find((item) => (item.status ?? "active") === "active")!;
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
  if (result.status !== "complete") reasons.push(`Campaign finished with ${result.status}.`);
  return { reasons, ...(accepted?.revision ? { acceptedRevision: accepted.revision } : {}) };
}

export class ProjectRunner {
  readonly journal: ProjectJourneyJournal;
  readonly manifestFingerprint: string;
  private historyImport?: Promise<void>;

  constructor(readonly project: LoadedGameFactoryProject, private readonly options: ProjectRunnerOptions) {
    const logicalJournal = relative(options.cwd, join(project.root, ".factory", "projects", project.id, "journey.jsonl"));
    this.journal = new ProjectJourneyJournal(resolveFactoryStatePath({ cwd: options.cwd, ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}) }, logicalJournal, logicalJournal, "project journey"), options.journeyIndex);
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
      const [campaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
      const runner = new FactoryRunner({ cwd: this.options.cwd, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, ...(this.options.signal ? { signal: this.options.signal } : {}) });
      try { await runner.initialize(); for (const check of await runner.doctor(campaign)) output.push({ phaseId: phase.id, attemptId: attempt.id, ...check }); }
      finally { await runner.dispose(); }
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
    const logicalLease = relative(this.options.cwd, join(this.project.root, ".factory", "projects", this.project.id, "run.lock"));
    const leasePath = resolveFactoryStatePath({ cwd: this.options.cwd, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) }, logicalLease, logicalLease, "project lease");
    const release = await acquireProjectLease(leasePath, projectRunId);
    const phases: ProjectRunResult["phases"] = [];
    try {
      if (latestStart?.projectRunId !== projectRunId) await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-started", idempotencyKey: `${projectRunId}:started`, manifestFingerprint: this.manifestFingerprint, actor: { kind: "factory" }, ...(baseRevision ? { sourceRevision: baseRevision } : {}), data: { title: this.project.title } });
      const currentEvents = await this.journal.read();
      const completed = new Set(currentEvents.filter((event) => event.projectRunId === projectRunId && event.type === "phase-completed").map((event) => event.phaseId));
      for (const phase of [...this.project.phases].sort((left, right) => left.order - right.order)) {
        if (completed.has(phase.id)) continue;
        const missing = (phase.dependsOn ?? []).filter((id) => !completed.has(id));
        if (missing.length > 0) {
          const reasons = [`Dependencies are incomplete: ${missing.join(", ")}`];
          phases.push({ phaseId: phase.id, attemptId: activeAttempt(phase).id, status: "blocked", reasons });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${projectRunId}:blocked:${phase.id}:dependencies`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, actor: { kind: "factory" }, data: { reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        const attempt = activeAttempt(phase);
        const [campaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
        const runId = resolveCampaignRunIdentity(campaign, config).runId;
        const phaseStarts = currentEvents.filter((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.phaseAttemptId === attempt.id && event.type === "phase-started");
        const latestPhaseStart = phaseStarts.at(-1);
        const latestPhaseTerminal = latestPhaseStart && currentEvents.some((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.sequence > latestPhaseStart.sequence && (event.type === "phase-completed" || event.type === "phase-blocked"));
        const execution = latestPhaseStart && !latestPhaseTerminal ? phaseStarts.length : phaseStarts.length + 1;
        const phaseKey = `${projectRunId}:${phase.id}:${attempt.id}:e${String(execution).padStart(4, "0")}`;
        if (!latestPhaseStart || latestPhaseTerminal) {
          const phaseRevision = await gitRevision(this.project.root);
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "phase-started", idempotencyKey: `${phaseKey}:started`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(phaseRevision ? { sourceRevision: phaseRevision } : {}) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "campaign-linked", idempotencyKey: `${phaseKey}:campaign-linked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" } });
        }
        let campaignResult: CampaignResult;
        if (this.options.executeCampaign) campaignResult = await this.options.executeCampaign({ campaign, config, signal: controller.signal });
        else {
          const runner = new FactoryRunner({ cwd: this.options.cwd, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, signal: controller.signal });
          try { await runner.initialize(); campaignResult = await runner.run(campaign); }
          finally { await runner.dispose(); }
        }
        const gate = gateReasons(phase, campaignResult);
        if (gate.reasons.length > 0) {
          phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "blocked", campaignResult, reasons: gate.reasons, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "phase-blocked", idempotencyKey: `${phaseKey}:blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: { reasons: gate.reasons, campaignStatus: campaignResult.status } });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${phaseKey}:project-blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, data: { reasons: gate.reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        completed.add(phase.id);
        phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "complete", campaignResult, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}) });
        await this.journal.append({ projectId: this.project.id, projectRunId, type: "phase-completed", idempotencyKey: `${phaseKey}:completed`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: { bestMetrics: campaignResult.bestMetrics } });
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
