import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadCampaign, loadFactoryConfig, resolveFactoryStatePath, type Campaign, type FactoryConfig } from "@gamefactory/core";
import { ProjectJourneyJournal, type LoadedGameFactoryProject, type ProjectJourneyEvent } from "@gamefactory/project-sdk";
import { createFactorySnapshot, factoryTraceSignature, readFactoryTrace, type FactoryTrace, type FactoryViewerOptions, type FactoryViewerSnapshot, type ViewerUsageSummary } from "./trace.js";

export interface ProjectViewerSelection {
  phaseId?: string;
  attemptId?: string;
  runId?: string;
}

export interface FactoryProjectAttemptTrace {
  key: string;
  phaseId: string;
  attemptId: string;
  status: "active" | "superseded" | "archived";
  campaign: Campaign;
  config: FactoryConfig;
  options: FactoryViewerOptions;
  trace: FactoryTrace;
}

export interface FactoryProjectTrace {
  project: LoadedGameFactoryProject;
  journey: ProjectJourneyEvent[];
  attempts: Map<string, FactoryProjectAttemptTrace>;
}

export interface FactoryProjectSnapshot {
  version: 3;
  generatedAt: string;
  project: {
    id: string;
    title: string;
    projectRunId: string;
    status: "live" | "complete" | "blocked" | "paused" | "interrupted" | "history";
  };
  phases: Array<{
    id: string;
    title: string;
    order: number;
    status: "pending" | "live" | "complete" | "blocked";
    acceptedRevision?: string;
    attempts: Array<{
      id: string;
      campaignId: string;
      status: "active" | "superseded" | "archived";
      runs: FactoryViewerSnapshot["runs"];
      selectedRunId: string;
    }>;
  }>;
  journey: ProjectJourneyEvent[];
  selection: { phaseId: string; attemptId: string; campaignId: string; runId: string };
  totals: {
    durationMs: number;
    campaigns: number;
    runs: number;
    experiments: number;
    invocations: number;
    totalTokens: number;
    costUsd: number;
  };
  run: FactoryViewerSnapshot;
}

function key(phaseId: string, attemptId: string): string { return `${phaseId}/${attemptId}`; }

function journalPath(project: LoadedGameFactoryProject, cwd: string, dataRoot?: string): string {
  const logical = relative(cwd, resolve(project.root, ".factory", "projects", project.id, "journey.jsonl"));
  return resolveFactoryStatePath({ cwd, ...(dataRoot ? { dataRoot } : {}) }, logical, logical, "project journey");
}

export async function readFactoryProjectTrace(project: LoadedGameFactoryProject, cwd: string, previous?: FactoryProjectTrace, dataRoot?: string): Promise<FactoryProjectTrace> {
  const attempts = new Map<string, FactoryProjectAttemptTrace>();
  for (const phase of project.phases) {
    for (const attempt of phase.attempts) {
      const attemptKey = key(phase.id, attempt.id);
      const [campaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
      const options = { cwd, ...(dataRoot ? { dataRoot } : {}), campaign, config } satisfies FactoryViewerOptions;
      const trace = await readFactoryTrace(options, previous?.attempts.get(attemptKey)?.trace);
      attempts.set(attemptKey, { key: attemptKey, phaseId: phase.id, attemptId: attempt.id, status: attempt.status ?? "active", campaign, config, options, trace });
    }
  }
  return { project, journey: await new ProjectJourneyJournal(journalPath(project, cwd, dataRoot)).read(), attempts };
}

async function signature(path: string): Promise<string> {
  try { const value = await stat(path); return `${value.size}:${value.mtimeMs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

export async function factoryProjectTraceSignature(project: LoadedGameFactoryProject, cwd: string, dataRoot?: string): Promise<string> {
  const values = [await signature(journalPath(project, cwd, dataRoot))];
  for (const phase of project.phases) {
    for (const attempt of phase.attempts) {
      const [campaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
      values.push(`${phase.id}/${attempt.id}:${await factoryTraceSignature({ cwd, ...(dataRoot ? { dataRoot } : {}), campaign, config })}`);
    }
  }
  return values.join("|");
}

function addUsage(total: ViewerUsageSummary, value: ViewerUsageSummary): void {
  total.invocations += value.invocations;
  total.tokenInvocations += value.tokenInvocations;
  total.pricedInvocations += value.pricedInvocations;
  total.unpricedInvocations += value.unpricedInvocations;
  total.totalTokens += value.totalTokens;
  total.inputTokens += value.inputTokens;
  total.cachedInputTokens += value.cachedInputTokens;
  total.outputTokens += value.outputTokens;
  total.reasoningTokens += value.reasoningTokens;
  total.costUsd += value.costUsd;
}

export function createFactoryProjectSnapshot(trace: FactoryProjectTrace, requested: ProjectViewerSelection = {}): FactoryProjectSnapshot {
  const starts = trace.journey.filter((event) => event.type === "project-started");
  const projectRunId = starts.at(-1)?.projectRunId ?? `${trace.project.id}-history`;
  const journey = trace.journey.filter((event) => event.projectRunId === projectRunId);
  const attemptSnapshots = new Map<string, FactoryViewerSnapshot>();
  for (const [attemptKey, attempt] of trace.attempts) {
    const requestedRunId = attempt.phaseId === requested.phaseId && attempt.attemptId === requested.attemptId ? requested.runId : undefined;
    attemptSnapshots.set(attemptKey, createFactorySnapshot(attempt.trace, attempt.campaign, requestedRunId));
  }
  const latestPhaseId = [...journey].reverse().find((event) => event.phaseId)?.phaseId;
  const selectedPhase = trace.project.phases.find((phase) => phase.id === requested.phaseId)
    ?? trace.project.phases.find((phase) => phase.id === latestPhaseId)
    ?? trace.project.phases[0]!;
  const selectedAttempt = selectedPhase.attempts.find((attempt) => attempt.id === requested.attemptId)
    ?? selectedPhase.attempts.find((attempt) => (attempt.status ?? "active") === "active")
    ?? selectedPhase.attempts[0]!;
  const selectedKey = key(selectedPhase.id, selectedAttempt.id);
  const run = attemptSnapshots.get(selectedKey)!;
  const phases = trace.project.phases.map((phase) => {
    const events = journey.filter((event) => event.phaseId === phase.id);
    const completed = [...events].reverse().find((event) => event.type === "phase-completed" || event.type === "promotion-applied");
    const blocked = [...events].reverse().find((event) => event.type === "phase-blocked");
    const started = [...events].reverse().find((event) => event.type === "phase-started");
    const status = completed ? "complete" : blocked ? "blocked" : started ? "live" : "pending";
    return {
      id: phase.id,
      title: phase.title,
      order: phase.order,
      status: status as "pending" | "live" | "complete" | "blocked",
      ...(completed?.resultingRevision ? { acceptedRevision: completed.resultingRevision } : {}),
      attempts: phase.attempts.map((attempt) => {
        const snapshot = attemptSnapshots.get(key(phase.id, attempt.id))!;
        return { id: attempt.id, campaignId: snapshot.campaign.id, status: attempt.status ?? "active", runs: snapshot.runs, selectedRunId: snapshot.runId };
      })
    };
  });
  const allSnapshots = [...attemptSnapshots.values()];
  const usage: ViewerUsageSummary = { invocations: 0, tokenInvocations: 0, pricedInvocations: 0, unpricedInvocations: 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, billingModes: [], models: [] };
  for (const snapshot of allSnapshots) addUsage(usage, snapshot.usage);
  const timestamps = allSnapshots.flatMap((snapshot) => [snapshot.startedAt, snapshot.finishedAt].filter((item): item is string => Boolean(item))).sort();
  const finished = journey.some((event) => event.type === "project-finished");
  const blocked = journey.some((event) => event.type === "project-blocked") && !finished;
  const paused = journey.some((event) => event.type === "project-paused") && !finished && !blocked;
  const live = phases.some((phase) => phase.status === "live") || allSnapshots.some((snapshot) => snapshot.live);
  return {
    version: 3,
    generatedAt: new Date().toISOString(),
    project: { id: trace.project.id, title: trace.project.title, projectRunId, status: live ? "live" : finished ? "complete" : blocked ? "blocked" : paused ? "paused" : starts.length ? "interrupted" : "history" },
    phases,
    journey,
    selection: { phaseId: selectedPhase.id, attemptId: selectedAttempt.id, campaignId: run.campaign.id, runId: run.runId },
    totals: {
      durationMs: timestamps.length > 1 ? Date.parse(timestamps.at(-1)!) - Date.parse(timestamps[0]!) : 0,
      campaigns: allSnapshots.length,
      runs: allSnapshots.reduce((sum, snapshot) => sum + snapshot.runs.length, 0),
      experiments: allSnapshots.reduce((sum, snapshot) => sum + snapshot.counters.experiments, 0),
      invocations: usage.invocations,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd
    },
    run
  };
}
