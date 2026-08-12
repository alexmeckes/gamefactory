import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  WorkflowJournal,
  type AgentContribution,
  type ArtifactReference,
  type Campaign,
  type Evaluation,
  type EffectivePromptManifest,
  type ExperimentRecord,
  type FactoryConfig,
  type FactoryTraceEvent,
  type InvocationUsage,
  type UsageBillingMode,
  type UsageIdentitySource,
  type WorkflowJournalEntry,
  type WorkflowJournalPhase,
  invocationTokenTotal,
  parseInvocationUsage
} from "@gamefactory/core";

export interface FactoryViewerOptions {
  cwd: string;
  campaign: Campaign;
  config: FactoryConfig;
  pollIntervalMs?: number;
}

export interface ViewerSources {
  journalPath: string;
  resultPath: string;
  artifactDirectory: string;
  leasePath: string;
  tracePath: string;
}

export interface ViewerRunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  experimentCount: number;
  status: "live" | "complete" | "blocked" | "interrupted";
}

export interface ViewerArtifact {
  id: string;
  kind: ArtifactReference["kind"];
  label: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  available: boolean;
  url?: string;
}

export interface ViewerEvaluation {
  evaluator: string;
  status: Evaluation["status"];
  summary?: string;
  metrics: Record<string, number>;
  violations: number;
  artifacts: number;
  usage?: InvocationUsage;
}

export interface ViewerContribution {
  agentId: string;
  role: AgentContribution["role"];
  status: AgentContribution["status"];
  summary: string;
  startedAt: string;
  finishedAt: string;
  artifacts: number;
  invocationId?: string;
  parentInvocationId?: string;
  usage?: InvocationUsage;
}

export interface ViewerPhase {
  sequence: number;
  phase: WorkflowJournalPhase;
  timestamp: string;
  note: string;
}

export interface ViewerExperiment {
  id: string;
  candidateId?: string;
  status: ExperimentRecord["status"] | "in-progress";
  latestPhase: WorkflowJournalPhase;
  complete: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  round?: number;
  slot?: number;
  summary?: string;
  metrics: Record<string, number>;
  primaryMetric?: number;
  evaluations: ViewerEvaluation[];
  agentSummary?: string;
  contributors: ViewerContribution[];
  usage?: InvocationUsage;
  artifacts: ViewerArtifact[];
  phases: ViewerPhase[];
  resultSequence?: number;
  evaluatedSequence?: number;
}

export interface ViewerEvent {
  sequence: number;
  phase: string;
  timestamp: string;
  note: string;
  experimentId: string;
  source: "journal" | "trace";
  nodeId?: string;
  sourceSequence: number;
}

export type ViewerGraphNodeKind = "campaign" | "extension" | "resource" | "candidate" | "workspace" | "agent" | "contributor" | "evaluator" | "decision" | "outcome";
export type ViewerGraphNodeState = "waiting" | "running" | "complete" | "pass" | "fail" | "inconclusive" | "keep" | "discard" | "blocked" | "crash" | "cancelled" | "baseline" | "skipped";

export interface ViewerGraphNode {
  id: string;
  kind: ViewerGraphNodeKind;
  label: string;
  detail?: string;
  experimentId?: string;
  clusterId?: string;
  column: number;
  order: number;
  enteredSequence: number;
  completedSequence?: number;
  finalState: ViewerGraphNodeState;
  durationMs?: number;
  artifacts: number;
  metrics: number;
  invocationId?: string;
  parentInvocationId?: string;
  usage?: InvocationUsage;
  provenance?: Record<string, unknown>;
  promptManifest?: EffectivePromptManifest;
}

export interface ViewerModelUsage {
  provider?: string;
  model?: string;
  invocations: number;
  tokenInvocations: number;
  pricedInvocations: number;
  totalTokens: number;
  costUsd: number;
  billingModes: UsageBillingMode[];
}

export interface ViewerUsageSummary {
  invocations: number;
  tokenInvocations: number;
  pricedInvocations: number;
  unpricedInvocations: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  billingModes: UsageBillingMode[];
  models: ViewerModelUsage[];
}

export interface ViewerGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "flow" | "fan-out" | "evidence" | "decision";
  enteredSequence: number;
  label?: string;
}

export interface ViewerGraphCluster {
  id: string;
  label: string;
  experimentId: string;
  nodeIds: string[];
  status: ViewerExperiment["status"];
  enteredSequence: number;
  round?: number;
  slot?: number;
}

export interface ViewerGraph {
  nodes: ViewerGraphNode[];
  edges: ViewerGraphEdge[];
  clusters: ViewerGraphCluster[];
}

export interface FactoryViewerSnapshot {
  version: 2;
  generatedAt: string;
  campaign: {
    id: string;
    objective: string;
    workflow: string;
    primaryMetric: string;
    direction: Campaign["acceptance"]["direction"];
  };
  runId: string;
  live: boolean;
  sequence: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs: number;
  runs: ViewerRunSummary[];
  experiments: ViewerExperiment[];
  events: ViewerEvent[];
  graph: ViewerGraph;
  usage: ViewerUsageSummary;
  counters: {
    experiments: number;
    active: number;
    kept: number;
    discarded: number;
    blocked: number;
    crashed: number;
  };
}

export interface FactoryTrace {
  entries: WorkflowJournalEntry[];
  records: ExperimentRecord[];
  traceEvents: FactoryTraceEvent[];
  activeRunId?: string;
  sources: ViewerSources;
  artifactFiles: Map<string, { path: string; mediaType?: string; label: string }>;
}

function outputPath(cwd: string, configured: string | undefined, fallback: string, label: string): string {
  const root = resolve(cwd);
  const target = resolve(root, configured ?? fallback);
  const traversal = relative(root, target);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error(`${label} must stay inside the viewer working directory`);
  }
  return target;
}

export function resolveViewerSources(options: FactoryViewerOptions): ViewerSources {
  const { cwd, campaign, config } = options;
  const journalPath = outputPath(cwd, config.journalLog, `.factory/journal/${campaign.id}.jsonl`, "journalLog");
  return {
    journalPath,
    resultPath: outputPath(cwd, config.resultLog, `.factory/results/${campaign.id}.jsonl`, "resultLog"),
    artifactDirectory: outputPath(cwd, config.artifactDirectory, ".factory/artifacts", "artifactDirectory"),
    leasePath: `${journalPath}.lock`,
    tracePath: outputPath(cwd, config.traceLog, `.factory/traces/${campaign.id}.jsonl`, "traceLog")
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const terminated = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (terminated) lines.pop();
  const values: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      if (!terminated && index === lines.length - 1) break;
      throw new Error(`Malformed JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

async function activeLeaseRunId(path: string): Promise<string | undefined> {
  try {
    const lease = JSON.parse(await readFile(path, "utf8")) as { runId?: unknown };
    return typeof lease.runId === "string" ? lease.runId : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function artifactId(artifact: ArtifactReference): string {
  return artifact.sha256 ?? createHash("sha256").update(`${artifact.kind}\0${artifact.path}`).digest("hex");
}

function artifactReferences(record: ExperimentRecord): ArtifactReference[] {
  return [
    ...(record.agent?.artifacts ?? []),
    ...(record.agent?.contributors.flatMap((contributor) => contributor.artifacts) ?? []),
    ...record.evaluations.flatMap((evaluation) => evaluation.artifacts)
  ];
}

export async function readFactoryTrace(options: FactoryViewerOptions): Promise<FactoryTrace> {
  const sources = resolveViewerSources(options);
  const [entries, records, activeRunId, traceEvents] = await Promise.all([
    new WorkflowJournal(sources.journalPath).read(),
    readJsonl<ExperimentRecord>(sources.resultPath),
    activeLeaseRunId(sources.leasePath),
    readJsonl<FactoryTraceEvent>(sources.tracePath)
  ]);
  const campaignEntries = entries.filter((entry) => entry.campaignId === options.campaign.id);
  const campaignRecords = records.filter((record) => record.campaignId === options.campaign.id);
  const artifactFiles = new Map<string, { path: string; mediaType?: string; label: string }>();
  for (const record of campaignRecords) {
    for (const artifact of artifactReferences(record)) {
      const id = artifactId(artifact);
      if (!artifactFiles.has(id)) {
        artifactFiles.set(id, {
          path: resolve(artifact.path),
          ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
          label: artifact.label ?? `${artifact.kind} artifact`
        });
      }
    }
  }
  return { entries: campaignEntries, records: campaignRecords, traceEvents: traceEvents.filter((event) => event.campaignId === options.campaign.id), ...(activeRunId ? { activeRunId } : {}), sources, artifactFiles };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeUsage(value: unknown, defaults: Pick<InvocationUsage, "provider" | "model" | "billingMode" | "identitySource"> = {}): InvocationUsage | undefined {
  try {
    return parseInvocationUsage(value, defaults);
  } catch {
    return parseInvocationUsage(undefined, defaults);
  }
}

function journalEvaluations(entries: WorkflowJournalEntry[]): ViewerEvaluation[] {
  const evaluated = [...entries].reverse().find((entry) => entry.phase === "evaluated");
  const values = asObject(evaluated?.data)?.evaluations;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value): ViewerEvaluation[] => {
    const item = asObject(value);
    if (!item) return [];
    const evaluator = stringValue(item.evaluator);
    const status = item.status;
    if (!evaluator || (status !== "pass" && status !== "fail" && status !== "inconclusive")) return [];
    const metrics = Object.fromEntries(Object.entries(asObject(item.metrics) ?? {}).filter((entry): entry is [string, number] => numberValue(entry[1]) !== undefined));
    return [{
      evaluator,
      status,
      ...(stringValue(item.summary) ? { summary: stringValue(item.summary)! } : {}),
      metrics,
      violations: Array.isArray(item.violations) ? item.violations.length : 0,
      artifacts: Array.isArray(item.artifacts) ? item.artifacts.length : 0,
      ...(safeUsage(item.usage) ? { usage: safeUsage(item.usage)! } : {})
    }];
  });
}

function journalContributors(entries: WorkflowJournalEntry[]): ViewerContribution[] {
  const agent = [...entries].reverse().find((entry) => entry.phase === "agent-finished");
  const values = asObject(agent?.data)?.contributors;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value): ViewerContribution[] => {
    const item = asObject(value);
    if (!item) return [];
    const agentId = stringValue(item.agentId);
    const role = item.role;
    const status = item.status;
    const startedAt = stringValue(item.startedAt);
    const finishedAt = stringValue(item.finishedAt);
    if (!agentId || !startedAt || !finishedAt
      || !["scout", "planner", "implementer", "critic", "judge", "worker"].includes(String(role))
      || !["complete", "failed", "skipped"].includes(String(status))) return [];
    return [{
      agentId,
      role: role as ViewerContribution["role"],
      status: status as ViewerContribution["status"],
      summary: stringValue(item.summary) ?? "Contributor finished",
      startedAt,
      finishedAt,
      artifacts: numberValue(item.artifactCount) ?? 0,
      ...(stringValue(item.invocationId) ? { invocationId: stringValue(item.invocationId)! } : {}),
      ...(stringValue(item.parentInvocationId) ? { parentInvocationId: stringValue(item.parentInvocationId)! } : {}),
      ...(safeUsage(item.usage) ? { usage: safeUsage(item.usage)! } : {})
    }];
  });
}

function entryNote(entry: WorkflowJournalEntry): string {
  const data = asObject(entry.data);
  switch (entry.phase) {
    case "reserved": {
      const round = numberValue(data?.round);
      const slot = numberValue(data?.slot);
      return round !== undefined ? `Round ${round}${slot !== undefined ? `, slot ${slot}` : ""} reserved` : slot !== undefined ? `Slot ${slot} reserved` : "Budget reserved";
    }
    case "candidate-created": {
      const candidate = asObject(data?.candidate);
      return stringValue(candidate?.id) ? `Workspace ${stringValue(candidate?.id)}` : "Candidate workspace created";
    }
    case "agent-finished":
      return stringValue(data?.summary) ?? "Agent work finished";
    case "evaluated": {
      const evaluations = Array.isArray(data?.evaluations) ? data.evaluations : [];
      const passes = evaluations.filter((value) => asObject(value)?.status === "pass").length;
      return `${evaluations.length} evaluator${evaluations.length === 1 ? "" : "s"} finished${evaluations.length ? ` · ${passes} passed` : ""}`;
    }
    case "evidence-preserved":
      return data?.patch ? "Evidence and patch preserved" : "Evidence preserved";
    case "acceptance-intent": {
      const action = stringValue(data?.action);
      return action ? `${action === "accept" ? "Accept" : "Discard"} decision recorded` : "Finalization decision recorded";
    }
    case "applied": {
      const record = asObject(data?.record);
      return stringValue(record?.status) ? `Outcome applied: ${stringValue(record?.status)}` : "Outcome applied";
    }
    case "recorded":
      return stringValue(data?.status) ? `Result saved: ${stringValue(data?.status)}` : "Result saved";
    case "blocked":
      return data?.candidateRetained === true ? "Blocked; candidate retained for review" : "Blocked for review";
    case "cleaned":
      return "Candidate workspace cleaned";
  }
}

function uniqueArtifacts(record: ExperimentRecord, artifactFiles: FactoryTrace["artifactFiles"], artifactDirectory: string): ViewerArtifact[] {
  const root = resolve(artifactDirectory);
  const seen = new Set<string>();
  const result: ViewerArtifact[] = [];
  for (const artifact of artifactReferences(record)) {
    const id = artifactId(artifact);
    if (seen.has(id)) continue;
    seen.add(id);
    const file = artifactFiles.get(id);
    const traversal = file ? relative(root, file.path) : "..";
    const available = Boolean(file && traversal && !traversal.startsWith("..") && !isAbsolute(traversal));
    const size = asObject(artifact.metadata)?.sizeBytes;
    const sizeBytes = numberValue(size);
    result.push({
      id,
      kind: artifact.kind,
      label: artifact.label ?? `${artifact.kind} artifact`,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      available,
      ...(available ? { url: `/artifacts/${encodeURIComponent(id)}` } : {})
    });
  }
  return result;
}

function recordMetadataNumber(record: ExperimentRecord | undefined, key: "round" | "slot"): number | undefined {
  const metadata = asObject(record?.metadata);
  for (const value of Object.values(metadata ?? {})) {
    const result = numberValue(asObject(value)?.[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function runIds(trace: FactoryTrace): string[] {
  const latestSequence = new Map<string, number>();
  for (const entry of trace.entries) latestSequence.set(entry.runId, Math.max(latestSequence.get(entry.runId) ?? 0, entry.sequence));
  for (const record of trace.records) {
    if (record.runId && !latestSequence.has(record.runId)) latestSequence.set(record.runId, 0);
  }
  for (const event of trace.traceEvents) latestSequence.set(event.runId, Math.max(latestSequence.get(event.runId) ?? 0, event.sequence));
  return [...latestSequence].sort((left, right) => right[1] - left[1]).map(([id]) => id);
}

function latestRecordByExperiment(records: ExperimentRecord[]): Map<string, ExperimentRecord> {
  const result = new Map<string, ExperimentRecord>();
  for (const record of records) result.set(record.experimentId, record);
  return result;
}

function runSummary(id: string, trace: FactoryTrace): ViewerRunSummary {
  const entries = trace.entries.filter((entry) => entry.runId === id);
  const records = trace.records.filter((record) => record.runId === id);
  const traceEvents = trace.traceEvents.filter((event) => event.runId === id);
  const experimentIds = new Set([...entries.map((entry) => entry.experimentId), ...records.map((record) => record.experimentId)]);
  const latestByExperiment = new Map<string, WorkflowJournalEntry>();
  for (const entry of entries) latestByExperiment.set(entry.experimentId, entry);
  const blocked = [...latestByExperiment.values()].some((entry) => entry.phase === "blocked");
  const interrupted = [...latestByExperiment.values()].some((entry) => entry.phase !== "cleaned" && entry.phase !== "blocked");
  const timestamps = [...entries.map((entry) => entry.timestamp), ...records.flatMap((record) => [record.startedAt, record.finishedAt]), ...traceEvents.map((event) => event.timestamp)].sort();
  const finishedAt = trace.activeRunId === id ? undefined : timestamps.at(-1);
  return {
    id,
    startedAt: timestamps[0] ?? new Date(0).toISOString(),
    ...(finishedAt ? { finishedAt } : {}),
    experimentCount: experimentIds.size,
    status: trace.activeRunId === id ? "live" : blocked ? "blocked" : interrupted ? "interrupted" : "complete"
  };
}

function experimentFromEntries(
  id: string,
  entries: WorkflowJournalEntry[],
  record: ExperimentRecord | undefined,
  trace: FactoryTrace,
  campaign: Campaign
): ViewerExperiment {
  const phaseEvents: ViewerPhase[] = entries.map((entry) => ({
    sequence: entry.sequence,
    phase: entry.phase,
    timestamp: entry.timestamp,
    note: entryNote(entry)
  }));
  const latest = entries.at(-1);
  const reserved = entries.find((entry) => entry.phase === "reserved");
  const reservedData = asObject(reserved?.data);
  const candidateEntry = [...entries].reverse().find((entry) => entry.phase === "candidate-created");
  const candidate = asObject(asObject(candidateEntry?.data)?.candidate);
  const resultEntry = [...entries].reverse().find((entry) => entry.phase === "recorded" || entry.phase === "blocked");
  const evaluatedEntry = entries.find((entry) => entry.phase === "evaluated");
  const startedAt = record?.startedAt ?? reserved?.timestamp ?? entries[0]?.timestamp ?? new Date(0).toISOString();
  const finishedAt = record?.finishedAt ?? (latest?.phase === "cleaned" || latest?.phase === "blocked" ? latest.timestamp : undefined);
  const round = recordMetadataNumber(record, "round") ?? numberValue(reservedData?.round);
  const slot = recordMetadataNumber(record, "slot") ?? numberValue(reservedData?.slot);
  const metrics = record?.metrics ?? {};
  const status = record?.status ?? "in-progress";
  const evaluated = record?.evaluations.map((evaluation): ViewerEvaluation => ({
    evaluator: evaluation.evaluator,
    status: evaluation.status,
    ...(evaluation.summary ? { summary: evaluation.summary } : {}),
    metrics: evaluation.metrics,
    violations: evaluation.violations.length,
    artifacts: evaluation.artifacts.length,
    ...(evaluation.usage ? { usage: evaluation.usage } : {})
  })) ?? journalEvaluations(entries);
  const contributed = record?.agent?.contributors.map((contributor): ViewerContribution => ({
    agentId: contributor.agentId,
    role: contributor.role,
    status: contributor.status,
    summary: contributor.summary,
    startedAt: contributor.startedAt,
    finishedAt: contributor.finishedAt,
    artifacts: contributor.artifacts.length,
    ...(contributor.invocationId ? { invocationId: contributor.invocationId } : {}),
    ...(contributor.parentInvocationId ? { parentInvocationId: contributor.parentInvocationId } : {}),
    ...(contributor.usage ? { usage: contributor.usage } : {})
  })) ?? journalContributors(entries);
  const agentEntry = [...entries].reverse().find((entry) => entry.phase === "agent-finished");
  const agentEntrySummary = stringValue(asObject(agentEntry?.data)?.summary);
  return {
    id,
    ...(record?.candidateId || stringValue(candidate?.id) ? { candidateId: record?.candidateId ?? stringValue(candidate?.id)! } : {}),
    status,
    latestPhase: latest?.phase ?? "reserved",
    complete: latest?.phase === "cleaned",
    startedAt,
    ...(finishedAt ? { finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(slot !== undefined ? { slot } : {}),
    ...(record?.summary ? { summary: record.summary } : {}),
    metrics,
    ...(numberValue(metrics[campaign.acceptance.primaryMetric]) !== undefined ? { primaryMetric: metrics[campaign.acceptance.primaryMetric] } : {}),
    evaluations: evaluated,
    ...(record?.agent?.summary || agentEntrySummary ? { agentSummary: record?.agent?.summary ?? agentEntrySummary! } : {}),
    contributors: contributed,
    ...(record?.usage ? { usage: record.usage } : {}),
    artifacts: record ? uniqueArtifacts(record, trace.artifactFiles, trace.sources.artifactDirectory) : [],
    phases: phaseEvents,
    ...(resultEntry ? { resultSequence: resultEntry.sequence } : {}),
    ...(evaluatedEntry ? { evaluatedSequence: evaluatedEntry.sequence } : {})
  };
}

function graphState(status: ViewerExperiment["status"]): ViewerGraphNodeState {
  return status === "in-progress" ? "running" : status;
}

function phaseSequence(experiment: ViewerExperiment, phase: WorkflowJournalPhase): number | undefined {
  return experiment.phases.find((item) => item.phase === phase)?.sequence;
}

function graphNodeId(experimentId: string, kind: ViewerGraphNodeKind, suffix?: string): string {
  return `${experimentId}:${kind}${suffix ? `:${suffix}` : ""}`;
}

function buildViewerGraph(runId: string, experiments: ViewerExperiment[], live: boolean, lastSequence: number): ViewerGraph {
  const nodes: ViewerGraphNode[] = [{
    id: `run:${runId}`,
    kind: "campaign",
    label: "Factory run",
    detail: runId,
    column: 0,
    order: 0,
    enteredSequence: 0,
    ...(!live ? { completedSequence: lastSequence } : {}),
    finalState: "complete",
    artifacts: 0,
    metrics: 0
  }];
  const edges: ViewerGraphEdge[] = [];
  const clusters: ViewerGraphCluster[] = [];
  const connect = (source: string, target: string, kind: ViewerGraphEdge["kind"], enteredSequence: number, label?: string): void => {
    edges.push({ id: `${source}->${target}`, source, target, kind, enteredSequence, ...(label ? { label } : {}) });
  };

  for (let order = 0; order < experiments.length; order += 1) {
    const experiment = experiments[order]!;
    const clusterId = `cluster:${experiment.id}`;
    const enteredSequence = experiment.phases[0]?.sequence ?? 0;
    const completeSequence = phaseSequence(experiment, "cleaned") ?? phaseSequence(experiment, "blocked") ?? experiment.resultSequence;
    const candidateId = graphNodeId(experiment.id, "candidate");
    const clusterNodeIds = [candidateId];
    nodes.push({
      id: candidateId,
      kind: "candidate",
      label: experiment.id === "baseline" ? "Baseline" : experiment.id,
      detail: experiment.summary ?? (experiment.id === "baseline" ? "Measure the starting revision" : "Candidate branch"),
      experimentId: experiment.id,
      clusterId,
      column: 3,
      order,
      enteredSequence,
      ...(completeSequence !== undefined ? { completedSequence: completeSequence } : {}),
      finalState: graphState(experiment.status),
      ...(experiment.durationMs !== undefined ? { durationMs: experiment.durationMs } : {}),
      artifacts: experiment.artifacts.length,
      metrics: Object.keys(experiment.metrics).length
    });
    connect(`run:${runId}`, candidateId, experiments.length > 1 ? "fan-out" : "flow", enteredSequence);

    let previousIds = [candidateId];
    const candidateSequence = phaseSequence(experiment, "candidate-created");
    const agentSequence = phaseSequence(experiment, "agent-finished");
    const evaluatedSequence = phaseSequence(experiment, "evaluated") ?? experiment.evaluatedSequence;
    const decisionSequence = phaseSequence(experiment, "acceptance-intent");
    const appliedSequence = phaseSequence(experiment, "applied") ?? phaseSequence(experiment, "recorded") ?? phaseSequence(experiment, "blocked") ?? completeSequence;

    if (candidateSequence !== undefined) {
      const id = graphNodeId(experiment.id, "workspace");
      clusterNodeIds.push(id);
      nodes.push({
        id,
        kind: "workspace",
        label: "Isolated workspace",
        detail: experiment.candidateId ?? "Candidate worktree",
        experimentId: experiment.id,
        clusterId,
        column: 4,
        order,
        enteredSequence: candidateSequence,
        ...(agentSequence !== undefined ? { completedSequence: agentSequence } : {}),
        finalState: "complete",
        artifacts: 0,
        metrics: 0
      });
      for (const previous of previousIds) connect(previous, id, "flow", candidateSequence);
      previousIds = [id];
    }

    if (agentSequence !== undefined || experiment.agentSummary || experiment.contributors.length > 0) {
      const id = graphNodeId(experiment.id, "agent");
      clusterNodeIds.push(id);
      nodes.push({
        id,
        kind: "agent",
        label: experiment.contributors.length ? `Agent team · ${experiment.contributors.length}` : "Agent",
        detail: experiment.agentSummary ?? "Candidate implementation",
        experimentId: experiment.id,
        clusterId,
        column: 5,
        order,
        enteredSequence: candidateSequence ?? enteredSequence,
        ...(agentSequence !== undefined ? { completedSequence: agentSequence } : {}),
        finalState: experiment.status === "crash" ? "crash" : "complete",
        artifacts: experiment.artifacts.filter((artifact) => artifact.kind === "log" || artifact.kind === "other").length,
        metrics: 0,
        ...(experiment.usage ? { usage: experiment.usage } : {})
      });
      for (const previous of previousIds) connect(previous, id, "flow", candidateSequence ?? enteredSequence);
      previousIds = [id];

      if (experiment.contributors.length > 0) {
        const contributors: string[] = [];
        for (let index = 0; index < experiment.contributors.length; index += 1) {
          const contributor = experiment.contributors[index]!;
          const contributorId = graphNodeId(experiment.id, "contributor", `${index}-${contributor.agentId}`);
          clusterNodeIds.push(contributorId);
          contributors.push(contributorId);
          nodes.push({
            id: contributorId,
            kind: "contributor",
            label: contributor.agentId,
            detail: `${contributor.role} · ${contributor.summary}`,
            experimentId: experiment.id,
            clusterId,
            column: 6,
            order: order + index / 100,
            enteredSequence: candidateSequence ?? enteredSequence,
            ...(agentSequence !== undefined ? { completedSequence: agentSequence } : {}),
            finalState: contributor.status === "failed" ? "fail" : contributor.status,
            durationMs: Math.max(0, Date.parse(contributor.finishedAt) - Date.parse(contributor.startedAt)),
            artifacts: contributor.artifacts,
            metrics: 0,
            ...(contributor.invocationId ? { invocationId: contributor.invocationId } : {}),
            ...(contributor.parentInvocationId ? { parentInvocationId: contributor.parentInvocationId } : {}),
            ...(contributor.usage ? { usage: contributor.usage } : {})
          });
          connect(id, contributorId, "fan-out", candidateSequence ?? enteredSequence, contributor.role);
        }
        previousIds = contributors;
      }
    }

    const evaluatorIds: string[] = [];
    for (let index = 0; index < experiment.evaluations.length; index += 1) {
      const evaluation = experiment.evaluations[index]!;
      const id = graphNodeId(experiment.id, "evaluator", `${index}-${evaluation.evaluator}`);
      clusterNodeIds.push(id);
      evaluatorIds.push(id);
      nodes.push({
        id,
        kind: "evaluator",
        label: evaluation.evaluator,
        detail: evaluation.summary ?? `${Object.keys(evaluation.metrics).length} metrics · ${evaluation.violations} violations`,
        experimentId: experiment.id,
        clusterId,
        column: 7,
        order: order + index / 100,
        enteredSequence: agentSequence ?? candidateSequence ?? enteredSequence,
        ...(evaluatedSequence !== undefined ? { completedSequence: evaluatedSequence } : {}),
        finalState: evaluation.status,
        artifacts: evaluation.artifacts,
        metrics: Object.keys(evaluation.metrics).length,
        invocationId: `evaluator:${experiment.id}:${index}-${evaluation.evaluator}`,
        parentInvocationId: `experiment:${experiment.id}`,
        ...(evaluation.usage ? { usage: evaluation.usage } : {})
      });
      for (const previous of previousIds) connect(previous, id, "evidence", agentSequence ?? candidateSequence ?? enteredSequence);
    }
    if (evaluatorIds.length > 0) previousIds = evaluatorIds;

    if (decisionSequence !== undefined) {
      const id = graphNodeId(experiment.id, "decision");
      clusterNodeIds.push(id);
      nodes.push({
        id,
        kind: "decision",
        label: experiment.round !== undefined ? `Round ${experiment.round} decision` : "Acceptance decision",
        detail: experiment.status === "keep" ? "Selected for acceptance" : experiment.status === "blocked" ? "Stopped for review" : "Not selected",
        experimentId: experiment.id,
        clusterId,
        column: 8,
        order,
        enteredSequence: evaluatedSequence ?? enteredSequence,
        completedSequence: decisionSequence,
        finalState: experiment.status === "keep" ? "keep" : experiment.status === "blocked" ? "blocked" : "discard",
        artifacts: 0,
        metrics: 0
      });
      for (const previous of previousIds) connect(previous, id, "decision", evaluatedSequence ?? enteredSequence);
      previousIds = [id];
    }

    if (appliedSequence !== undefined) {
      const id = graphNodeId(experiment.id, "outcome");
      clusterNodeIds.push(id);
      nodes.push({
        id,
        kind: "outcome",
        label: experiment.status === "keep" ? "Accepted" : experiment.status === "baseline" ? "Baseline recorded" : experiment.status === "blocked" ? "Retained for review" : experiment.status === "discard" ? "Discarded" : "Finished",
        detail: experiment.status === "keep" ? "Candidate applied to the project" : experiment.complete ? "Workspace cleaned" : "Finalization in progress",
        experimentId: experiment.id,
        clusterId,
        column: 9,
        order,
        enteredSequence: decisionSequence ?? evaluatedSequence ?? enteredSequence,
        ...(completeSequence !== undefined ? { completedSequence: completeSequence } : {}),
        finalState: graphState(experiment.status),
        artifacts: experiment.artifacts.length,
        metrics: Object.keys(experiment.metrics).length
      });
      for (const previous of previousIds) connect(previous, id, "decision", decisionSequence ?? evaluatedSequence ?? enteredSequence, experiment.status);
    }
    clusters.push({
      id: clusterId,
      label: experiment.id,
      experimentId: experiment.id,
      nodeIds: clusterNodeIds,
      status: experiment.status,
      enteredSequence,
      ...(experiment.round !== undefined ? { round: experiment.round } : {}),
      ...(experiment.slot !== undefined ? { slot: experiment.slot } : {})
    });
  }
  return { nodes, edges, clusters };
}

function unifiedReplay(
  experiments: ViewerExperiment[],
  traceEvents: FactoryTraceEvent[]
): { experiments: ViewerExperiment[]; events: ViewerEvent[]; traceSequences: Map<number, number> } {
  const items: Array<Omit<ViewerEvent, "sequence"> & { key: string }> = [];
  for (const experiment of experiments) {
    for (const phase of experiment.phases) {
      items.push({
        key: `journal:${phase.sequence}`,
        phase: phase.phase,
        timestamp: phase.timestamp,
        note: phase.note,
        experimentId: experiment.id,
        source: "journal",
        sourceSequence: phase.sequence
      });
    }
  }
  for (const event of traceEvents) {
    items.push({
      key: `trace:${event.sequence}`,
      phase: event.type,
      timestamp: event.timestamp,
      note: event.message ?? event.label ?? event.type,
      experimentId: event.experimentId ?? "campaign",
      source: "trace",
      sourceSequence: event.sequence,
      nodeId: event.nodeId
    });
  }
  items.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || (left.source === right.source ? left.sourceSequence - right.sourceSequence : left.source === "journal" ? -1 : 1));
  const sequenceByKey = new Map<string, number>();
  const events = items.map(({ key, ...item }, index): ViewerEvent => {
    const sequence = index + 1;
    sequenceByKey.set(key, sequence);
    return { sequence, ...item };
  });
  const remapped = experiments.map((experiment): ViewerExperiment => ({
    ...experiment,
    phases: experiment.phases.map((phase) => ({ ...phase, sequence: sequenceByKey.get(`journal:${phase.sequence}`) ?? phase.sequence })),
    ...(experiment.resultSequence !== undefined ? { resultSequence: sequenceByKey.get(`journal:${experiment.resultSequence}`) ?? experiment.resultSequence } : {}),
    ...(experiment.evaluatedSequence !== undefined ? { evaluatedSequence: sequenceByKey.get(`journal:${experiment.evaluatedSequence}`) ?? experiment.evaluatedSequence } : {})
  }));
  return {
    experiments: remapped,
    events,
    traceSequences: new Map(traceEvents.map((event) => [event.sequence, sequenceByKey.get(`trace:${event.sequence}`) ?? event.sequence]))
  };
}

function traceState(event: FactoryTraceEvent): ViewerGraphNodeState {
  if (event.type === "node:skipped") return "skipped";
  if (event.type === "node:failed") return event.status === "blocked" ? "blocked" : event.status === "crash" ? "crash" : "fail";
  if (event.status === "pass" || event.status === "fail" || event.status === "inconclusive" || event.status === "keep" || event.status === "discard" || event.status === "blocked" || event.status === "crash" || event.status === "cancelled" || event.status === "skipped") return event.status;
  return "complete";
}

function mergeTraceGraph(graph: ViewerGraph, traceEvents: FactoryTraceEvent[], sequenceMap: Map<number, number>, runId: string): ViewerGraph {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const edges = graph.edges.map((edge) => ({ ...edge }));
  const clusters = graph.clusters.map((cluster) => ({ ...cluster, nodeIds: [...cluster.nodeIds] }));
  const metadata = new Map<string, FactoryTraceEvent>();
  for (const event of traceEvents) if (!metadata.has(event.nodeId) && event.type !== "edge:created") metadata.set(event.nodeId, event);
  const canonical = (rawId: string): string => {
    const event = metadata.get(rawId);
    const experimentId = event?.experimentId;
    if (rawId === `campaign:${runId}`) return `run:${runId}`;
    if (rawId.startsWith("experiment:") && experimentId) return `${experimentId}:candidate`;
    if (event?.role === "agent-team" && experimentId) return nodes.find((node) => node.experimentId === experimentId && node.kind === "agent")?.id ?? rawId;
    if (event?.role === "evaluator" && experimentId) return nodes.find((node) => node.experimentId === experimentId && node.kind === "evaluator" && node.label === event.label)?.id ?? rawId;
    if (event && event.attempt === undefined && experimentId && ["scout", "planner", "implementer", "critic", "judge", "worker"].includes(event.role ?? "")) {
      return nodes.find((node) => node.experimentId === experimentId && node.kind === "contributor" && node.label === event.label)?.id ?? rawId;
    }
    return rawId;
  };
  const groups = new Map<string, FactoryTraceEvent[]>();
  for (const event of traceEvents) {
    if (event.type === "edge:created") continue;
    const id = canonical(event.nodeId);
    const group = groups.get(id) ?? [];
    group.push(event);
    groups.set(id, group);
  }
  let dynamicOrder = 0;
  for (const [id, eventsForNode] of groups) {
    eventsForNode.sort((left, right) => left.sequence - right.sequence);
    const first = eventsForNode[0]!;
    const terminal = [...eventsForNode].reverse().find((event) => event.type === "node:completed" || event.type === "node:failed" || event.type === "node:skipped");
    const started = eventsForNode.find((event) => event.type === "node:started") ?? first;
    const artifactCount = eventsForNode.filter((event) => event.type === "artifact:produced").reduce((sum, event) => sum + (numberValue(asObject(event.data)?.count) ?? 0), 0);
    const dataEvents = [...eventsForNode].reverse().map((event) => asObject(event.data)).filter((data): data is Record<string, unknown> => data !== undefined);
    const identityData = dataEvents.find((data) => stringValue(data.provider) || stringValue(data.model) || stringValue(data.billingMode) || stringValue(data.identitySource));
    const usageData = dataEvents.find((data) => asObject(data.usage));
    const provenance = dataEvents.find((data) => stringValue(data.provenanceType));
    const promptManifest = dataEvents.map((data) => asObject(data.promptManifest)).find((value) => value !== undefined) as EffectivePromptManifest | undefined;
    const usage = safeUsage(usageData?.usage, {
      ...(stringValue(identityData?.provider) ? { provider: stringValue(identityData?.provider)! } : {}),
      ...(stringValue(identityData?.model) ? { model: stringValue(identityData?.model)! } : {}),
      ...(stringValue(identityData?.billingMode) ? { billingMode: stringValue(identityData?.billingMode)! as UsageBillingMode } : {}),
      ...(stringValue(identityData?.identitySource) ? { identitySource: stringValue(identityData?.identitySource)! as UsageIdentitySource } : {})
    });
    const invocationId = dataEvents.map((data) => stringValue(data.invocationId)).find((value) => value !== undefined);
    const parentInvocationId = dataEvents.map((data) => stringValue(data.parentInvocationId)).find((value) => value !== undefined) ?? first.parentNodeId;
    const existing = nodes.find((node) => node.id === id);
    if (existing) {
      existing.enteredSequence = Math.min(existing.enteredSequence, sequenceMap.get(first.sequence) ?? existing.enteredSequence);
      if (terminal) {
        const completedSequence = sequenceMap.get(terminal.sequence);
        if (completedSequence !== undefined) existing.completedSequence = completedSequence;
        existing.finalState = traceState(terminal);
      }
      const detail = [...eventsForNode].reverse().find((event) => event.message)?.message;
      if (detail !== undefined) existing.detail = detail;
      existing.artifacts = Math.max(existing.artifacts, artifactCount);
      if (usage) existing.usage = usage;
      if (invocationId) existing.invocationId = invocationId;
      if (parentInvocationId) existing.parentInvocationId = parentInvocationId;
      if (provenance) existing.provenance = provenance;
      if (promptManifest) existing.promptManifest = promptManifest;
      continue;
    }
    const experimentId = first.experimentId;
    const cluster = experimentId ? clusters.find((item) => item.experimentId === experimentId) : undefined;
    const role = first.role ?? "worker";
    const kind: ViewerGraphNodeKind = role === "campaign" ? "campaign"
      : role === "extension" ? "extension"
      : role === "resource" ? "resource"
      : role === "experiment" ? "candidate"
      : role === "evaluator" ? "evaluator"
      : role === "agent-team" ? "agent"
      : "contributor";
    const column = kind === "campaign" ? 0 : kind === "extension" ? 1 : kind === "resource" ? 2 : kind === "candidate" ? 3 : kind === "agent" ? 5 : kind === "evaluator" ? 7 : first.attempt !== undefined ? 6 : 6;
    const node: ViewerGraphNode = {
      id,
      kind,
      label: `${first.label ?? role}${first.attempt !== undefined ? ` · attempt ${first.attempt}` : ""}`,
      ...(eventsForNode.find((event) => event.message)?.message ? { detail: eventsForNode.find((event) => event.message)!.message! } : {}),
      ...(experimentId ? { experimentId } : {}),
      ...(cluster ? { clusterId: cluster.id } : {}),
      column,
      order: (cluster ? clusters.indexOf(cluster) : 0) + dynamicOrder++ / 1000,
      enteredSequence: sequenceMap.get(started.sequence) ?? 0,
      ...(terminal ? { completedSequence: sequenceMap.get(terminal.sequence) ?? 0 } : {}),
      finalState: terminal ? traceState(terminal) : "complete",
      artifacts: artifactCount,
      metrics: 0,
      ...(invocationId ? { invocationId } : {}),
      ...(parentInvocationId ? { parentInvocationId } : {}),
      ...(usage ? { usage } : {}),
      ...(provenance ? { provenance } : {}),
      ...(promptManifest ? { promptManifest } : {})
    };
    nodes.push(node);
    if (cluster) cluster.nodeIds.push(id);
  }
  const edgeIds = new Set(edges.map((edge) => edge.id));
  for (const event of traceEvents.filter((item) => item.type === "edge:created")) {
    const source = event.sourceNodeId ? canonical(event.sourceNodeId) : undefined;
    const target = event.targetNodeId ? canonical(event.targetNodeId) : undefined;
    if (!source || !target || source === target) continue;
    const id = `trace:${source}->${target}`;
    if (edgeIds.has(id) || edges.some((edge) => edge.source === source && edge.target === target)) continue;
    edgeIds.add(id);
    edges.push({
      id,
      source,
      target,
      kind: event.role === "dependency" ? "flow" : event.role === "evidence" ? "evidence" : event.role === "fan-out" ? "fan-out" : "flow",
      enteredSequence: sequenceMap.get(event.sequence) ?? 0,
      ...(event.message ? { label: event.message } : {})
    });
  }
  return { nodes, edges, clusters };
}

export function summarizeGraphUsage(graph: ViewerGraph, sequence = Number.POSITIVE_INFINITY): ViewerUsageSummary {
  const visible = graph.nodes.filter((node) => node.usage && (node.completedSequence ?? node.enteredSequence) <= sequence);
  const leafExperiments = new Set(visible.filter((node) => node.kind === "contributor" || node.kind === "evaluator").map((node) => node.experimentId));
  const selected = visible.filter((node) => node.kind === "contributor" || node.kind === "evaluator" || (node.kind === "agent" && !leafExperiments.has(node.experimentId)));
  const invocations = new Map<string, ViewerGraphNode>();
  for (const node of selected) invocations.set(node.invocationId ?? node.id, node);
  const models = new Map<string, ViewerModelUsage>();
  let tokenInvocations = 0;
  let pricedInvocations = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  const billingModes = new Set<UsageBillingMode>();
  for (const node of invocations.values()) {
    const usage = node.usage!;
    const tokens = invocationTokenTotal(usage);
    if (tokens !== undefined) {
      tokenInvocations += 1;
      totalTokens += tokens;
    }
    if (usage.costUsd !== undefined) {
      pricedInvocations += 1;
      costUsd += usage.costUsd;
    }
    if (usage.billingMode) billingModes.add(usage.billingMode);
    inputTokens += usage.inputTokens ?? 0;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    reasoningTokens += usage.reasoningTokens ?? 0;
    const key = `${usage.provider ?? ""}\0${usage.model ?? ""}`;
    const model = models.get(key) ?? {
      ...(usage.provider ? { provider: usage.provider } : {}),
      ...(usage.model ? { model: usage.model } : {}),
      invocations: 0,
      tokenInvocations: 0,
      pricedInvocations: 0,
      totalTokens: 0,
      costUsd: 0,
      billingModes: []
    };
    model.invocations += 1;
    if (tokens !== undefined) {
      model.tokenInvocations += 1;
      model.totalTokens += tokens;
    }
    if (usage.costUsd !== undefined) {
      model.pricedInvocations += 1;
      model.costUsd += usage.costUsd;
    }
    if (usage.billingMode && !model.billingModes.includes(usage.billingMode)) model.billingModes.push(usage.billingMode);
    models.set(key, model);
  }
  return {
    invocations: invocations.size,
    tokenInvocations,
    pricedInvocations,
    unpricedInvocations: invocations.size - pricedInvocations,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    costUsd,
    billingModes: [...billingModes].sort(),
    models: [...models.values()].sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens || (left.model ?? "").localeCompare(right.model ?? ""))
  };
}

export function createFactorySnapshot(trace: FactoryTrace, campaign: Campaign, requestedRunId?: string): FactoryViewerSnapshot {
  const ids = runIds(trace);
  const runId = requestedRunId && ids.includes(requestedRunId) ? requestedRunId : ids[0] ?? trace.activeRunId ?? `${campaign.id}-empty`;
  const entries = trace.entries.filter((entry) => entry.runId === runId).sort((left, right) => left.sequence - right.sequence);
  const records = trace.records.filter((record) => record.runId === runId);
  const recordsByExperiment = latestRecordByExperiment(records);
  const grouped = new Map<string, WorkflowJournalEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.experimentId) ?? [];
    group.push(entry);
    grouped.set(entry.experimentId, group);
  }
  for (const record of records) if (!grouped.has(record.experimentId)) grouped.set(record.experimentId, []);
  const sourceExperiments = [...grouped].map(([id, experimentEntries]) => experimentFromEntries(id, experimentEntries, recordsByExperiment.get(id), trace, campaign));
  sourceExperiments.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id.localeCompare(right.id));
  const runTraceEvents = trace.traceEvents.filter((event) => event.runId === runId);
  const replay = unifiedReplay(sourceExperiments, runTraceEvents);
  const experiments = replay.experiments;
  const events = replay.events;
  const times = [...experiments.flatMap((experiment) => [experiment.startedAt, ...(experiment.finishedAt ? [experiment.finishedAt] : [])]), ...runTraceEvents.map((event) => event.timestamp)].sort();
  const startedAt = times[0];
  const live = trace.activeRunId === runId;
  const finishedAt = live ? undefined : times.at(-1);
  const now = Date.now();
  const durationMs = startedAt ? Math.max(0, (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) : 0;
  const graph = mergeTraceGraph(buildViewerGraph(runId, experiments, live, events.at(-1)?.sequence ?? 0), runTraceEvents, replay.traceSequences, runId);
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    campaign: {
      id: campaign.id,
      objective: campaign.objective,
      workflow: campaign.workflow,
      primaryMetric: campaign.acceptance.primaryMetric,
      direction: campaign.acceptance.direction
    },
    runId,
    live,
    sequence: events.at(-1)?.sequence ?? 0,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    durationMs,
    runs: ids.map((id) => runSummary(id, trace)),
    experiments,
    events,
    graph,
    usage: summarizeGraphUsage(graph),
    counters: {
      experiments: experiments.filter((experiment) => experiment.status !== "baseline").length,
      active: experiments.filter((experiment) => experiment.status === "in-progress").length,
      kept: experiments.filter((experiment) => experiment.status === "keep").length,
      discarded: experiments.filter((experiment) => experiment.status === "discard").length,
      blocked: experiments.filter((experiment) => experiment.status === "blocked").length,
      crashed: experiments.filter((experiment) => experiment.status === "crash").length
    }
  };
}

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function factoryTraceSignature(options: FactoryViewerOptions): Promise<string> {
  const sources = resolveViewerSources(options);
  return (await Promise.all([fileSignature(sources.journalPath), fileSignature(sources.resultPath), fileSignature(sources.leasePath), fileSignature(sources.tracePath)])).join("|");
}
