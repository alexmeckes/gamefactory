import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentContribution,
  AgentDriver,
  AgentRequest,
  AgentResult,
  AgentRole,
  ArtifactReference
} from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

type TeamStage = AgentRole;
type Permission = "read" | "write";

interface ContributorConfig {
  id: string;
  command: string[];
}

interface LegacyAgentTeamConfig {
  kind: "legacy";
  scouts: ContributorConfig[];
  planner: ContributorConfig;
  implementer: ContributorConfig;
  critics: ContributorConfig[];
  maxOutputCharacters: number;
  maximumParallel: number;
}

interface ContextReferenceConfig {
  path: string;
  kind: ArtifactReference["kind"];
  mediaType?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

interface GraphCondition {
  node: string;
  outcomes: string[];
}

interface RepairEdge {
  target: string;
  outcomes: string[];
  maximumAttempts: number;
}

interface GraphNodeConfig extends ContributorConfig {
  role: AgentRole;
  readOnly: boolean;
  dependsOn: string[];
  when: GraphCondition[];
  instructions?: string;
  context: ContextReferenceConfig[];
  maximumAttempts: number;
  required: boolean;
  repair?: RepairEdge;
}

interface GraphAgentTeamConfig {
  kind: "graph";
  nodes: GraphNodeConfig[];
  context: ContextReferenceConfig[];
  maxOutputCharacters: number;
  maximumParallel: number;
  maximumTotalAttempts: number;
  maximumRepairAttempts: number;
}

type AgentTeamConfig = LegacyAgentTeamConfig | GraphAgentTeamConfig;

interface StructuredNodeOutput {
  summary?: string;
  outcome?: string;
  findings?: unknown;
  context?: unknown;
  artifacts?: ArtifactReference[];
  [key: string]: unknown;
}

interface PriorOutput {
  contributorId: string;
  nodeId: string;
  stage: TeamStage;
  attempt: number;
  outcome: string;
  summary: string;
  output: string;
  stdoutPath: string;
  structured?: StructuredNodeOutput;
  artifacts: ArtifactReference[];
}

export interface ContributorProvenance {
  contributorId: string;
  nodeId: string;
  stage: TeamStage;
  readOnly: boolean;
  attempt: number;
  reason: InvocationReason;
  command: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  status: "complete" | "failed";
  outcome: string;
  summary: string;
  requestPath: string;
  stdoutPath: string;
  stderrPath: string;
  structuredOutputPath?: string;
}

interface ContributorRun {
  provenance: ContributorProvenance;
  stdout: string;
  stderr: string;
  structured?: StructuredNodeOutput;
  declaredArtifacts: ArtifactReference[];
  artifacts: ArtifactReference[];
}

export class AgentTeamExecutionError extends Error {
  readonly name = "AgentTeamExecutionError";

  constructor(message: string, readonly runs: ContributorRun[]) {
    super(message);
  }

  get artifacts(): ArtifactReference[] {
    return this.runs.flatMap((run) => run.artifacts);
  }

  get provenance(): Record<string, unknown> {
    return { contributors: this.runs.map((run) => run.provenance) };
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  failure?: "cancelled" | "timeout" | "output-limit";
}

interface InvocationReason {
  kind: "initial" | "retry" | "repair" | "review";
  source?: string;
  repairAttempt?: number;
}

interface InvocationOptions {
  mode: "legacy" | "graph";
  nodeId: string;
  attempt: number;
  instructions: string;
  context: ContextReferenceConfig[];
  reason: InvocationReason;
}

interface GraphNodeState {
  config: GraphNodeConfig;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  outcome: string;
  summary: string;
  runs: ContributorRun[];
}

const ROLES = new Set<AgentRole>(["scout", "planner", "implementer", "critic", "judge", "worker"]);
const ARTIFACT_KINDS = new Set<ArtifactReference["kind"]>([
  "image", "video", "audio", "replay", "telemetry", "profile", "test-report", "log", "build", "crash-dump", "other"
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OUTCOME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const candidateQueues = new Map<string, Promise<void>>();
const COMPATIBILITY_ENVIRONMENT = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR"] as const;

function childEnvironment(additions: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of COMPATIBILITY_ENVIRONMENT) {
    const entry = Object.entries(process.env).find(([candidate]) => process.platform === "win32"
      ? candidate.toLowerCase() === name.toLowerCase()
      : candidate === name);
    if (entry?.[1] !== undefined) environment[entry[0]] = entry[1];
  }
  return { ...environment, ...additions };
}

const INSTRUCTIONS: Record<TeamStage, string> = {
  scout: "Inspect the candidate and propose a focused hypothesis. Do not modify any project file. Return findings on stdout.",
  planner: "Synthesize the supplied findings into one concrete, bounded implementation plan. Do not modify any project file. Return the plan on stdout.",
  implementer: "Implement the supplied plan in the candidate. Return a concise change summary on stdout.",
  critic: "Review the candidate against the objective and supplied evidence. Do not modify any project file. Return risks and recommendations on stdout.",
  judge: "Compare the supplied evidence and return a decision with a concise rationale. Do not modify any project file.",
  worker: "Complete the assigned bounded task and return a concise result on stdout."
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string") && value[0]!.length > 0;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, location: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || Number(result) < minimum || Number(result) > maximum) {
    throw new Error(`${location} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(result);
}

function stringList(value: unknown, location: string, maximum = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string" && ID_PATTERN.test(item))) {
    throw new Error(`${location} must be an array of at most ${maximum} contributor ids`);
  }
  return [...new Set(value as string[])];
}

function contributor(value: unknown, defaultId: string, location: string): ContributorConfig {
  if (isStringArray(value)) return { id: defaultId, command: [...value] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be a command string array or an object with id and command`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id ?? defaultId;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(`${location}.id must use only letters, numbers, dots, underscores, and hyphens`);
  }
  if (!isStringArray(record.command)) throw new Error(`${location}.command must be a non-empty string array`);
  return { id, command: [...record.command] };
}

function contributorList(value: unknown, stage: "scout" | "critic"): ContributorConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`parameters.agentTeam.${stage}s must be a non-empty array`);
  if (value.length > 64) throw new Error(`parameters.agentTeam.${stage}s cannot contain more than 64 contributors`);
  const contributors = value.map((item, index) => contributor(item, `${stage}-${index + 1}`, `parameters.agentTeam.${stage}s[${index}]`));
  const ids = new Set<string>();
  for (const item of contributors) {
    if (ids.has(item.id)) throw new Error(`parameters.agentTeam.${stage}s contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
  return contributors;
}

function metadata(value: unknown, location: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return { ...(value as Record<string, unknown>) };
}

function contextReference(value: unknown, location: string): ContextReferenceConfig {
  if (typeof value === "string" && value.length > 0) return { path: value, kind: "other" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be a path string or artifact reference object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) throw new Error(`${location}.path must be a non-empty string`);
  const kind = record.kind ?? "other";
  if (typeof kind !== "string" || !ARTIFACT_KINDS.has(kind as ArtifactReference["kind"])) {
    throw new Error(`${location}.kind is not a supported artifact kind`);
  }
  if (record.mediaType !== undefined && typeof record.mediaType !== "string") throw new Error(`${location}.mediaType must be a string`);
  if (record.label !== undefined && typeof record.label !== "string") throw new Error(`${location}.label must be a string`);
  const result: ContextReferenceConfig = { path: record.path, kind: kind as ArtifactReference["kind"] };
  if (typeof record.mediaType === "string") result.mediaType = record.mediaType;
  if (typeof record.label === "string") result.label = record.label;
  const referenceMetadata = metadata(record.metadata, `${location}.metadata`);
  if (referenceMetadata) result.metadata = referenceMetadata;
  return result;
}

function contextList(value: unknown, location: string): ContextReferenceConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${location} must be an array with at most 64 references`);
  return value.map((item, index) => contextReference(item, `${location}[${index}]`));
}

function conditions(value: unknown, location: string): GraphCondition[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 64) throw new Error(`${location} cannot contain more than 64 conditions`);
  return values.map((item, index) => {
    const itemLocation = Array.isArray(value) ? `${location}[${index}]` : location;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${itemLocation} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.node !== "string" || !ID_PATTERN.test(record.node)) throw new Error(`${itemLocation}.node must be a contributor id`);
    const rawOutcomes = typeof record.outcome === "string" ? [record.outcome] : record.outcomes;
    if (!Array.isArray(rawOutcomes) || rawOutcomes.length === 0 || rawOutcomes.length > 32 || !rawOutcomes.every((outcome) => typeof outcome === "string" && OUTCOME_PATTERN.test(outcome))) {
      throw new Error(`${itemLocation}.outcomes must be a non-empty array of outcome names`);
    }
    return { node: record.node, outcomes: [...new Set(rawOutcomes as string[])] };
  });
}

function repairEdge(value: unknown, location: string): RepairEdge | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.target !== "string" || !ID_PATTERN.test(record.target)) throw new Error(`${location}.target must be a contributor id`);
  const rawOutcomes = record.outcomes ?? ["revise"];
  if (!Array.isArray(rawOutcomes) || rawOutcomes.length === 0 || !rawOutcomes.every((outcome) => typeof outcome === "string" && OUTCOME_PATTERN.test(outcome))) {
    throw new Error(`${location}.outcomes must be a non-empty array of outcome names`);
  }
  return {
    target: record.target,
    outcomes: [...new Set(rawOutcomes as string[])],
    maximumAttempts: integer(record.maximumAttempts, 1, 1, 16, `${location}.maximumAttempts`)
  };
}

function graphNode(value: unknown, index: number): GraphNodeConfig {
  const location = `parameters.agentTeam.graph.nodes[${index}]`;
  const base = contributor(value, `node-${index + 1}`, location);
  const record = value as Record<string, unknown>;
  const rawRole = record.role ?? "worker";
  if (typeof rawRole !== "string" || !ROLES.has(rawRole as AgentRole)) throw new Error(`${location}.role is not a supported agent role`);
  const role = rawRole as AgentRole;
  const rawPermission = record.permissions ?? record.permission;
  if (rawPermission !== undefined && rawPermission !== "read" && rawPermission !== "write") {
    throw new Error(`${location}.permissions must be read or write`);
  }
  if (record.readOnly !== undefined && typeof record.readOnly !== "boolean") throw new Error(`${location}.readOnly must be a boolean`);
  const inferredReadOnly = role !== "implementer";
  const readOnly = typeof record.readOnly === "boolean" ? record.readOnly : rawPermission ? rawPermission === "read" : inferredReadOnly;
  if (typeof record.readOnly === "boolean" && rawPermission && record.readOnly !== (rawPermission === "read")) {
    throw new Error(`${location}.readOnly conflicts with permissions`);
  }
  if (record.instructions !== undefined && (typeof record.instructions !== "string" || record.instructions.length > 100_000)) {
    throw new Error(`${location}.instructions must be a string with at most 100000 characters`);
  }
  if (record.required !== undefined && typeof record.required !== "boolean") throw new Error(`${location}.required must be a boolean`);
  const result: GraphNodeConfig = {
    ...base,
    role,
    readOnly,
    dependsOn: stringList(record.dependsOn ?? record.dependencies, `${location}.dependsOn`),
    when: conditions(record.when, `${location}.when`),
    context: contextList(record.context, `${location}.context`),
    maximumAttempts: integer(record.maximumAttempts, 1, 1, 8, `${location}.maximumAttempts`),
    required: record.required !== false
  };
  if (typeof record.instructions === "string") result.instructions = record.instructions;
  const repair = repairEdge(record.repair, `${location}.repair`);
  if (repair) result.repair = repair;
  return result;
}

function validateGraph(nodes: GraphNodeConfig[]): void {
  const byId = new Map<string, GraphNodeConfig>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`parameters.agentTeam.graph.nodes contains duplicate id ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`graph node ${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new Error(`graph node ${node.id} cannot depend on itself`);
    }
    for (const condition of node.when) {
      if (!node.dependsOn.includes(condition.node)) throw new Error(`graph node ${node.id} condition ${condition.node} must also appear in dependsOn`);
    }
    if (node.repair) {
      const target = byId.get(node.repair.target);
      if (!target) throw new Error(`graph node ${node.id} repairs unknown node ${node.repair.target}`);
      if (target.readOnly) throw new Error(`graph node ${node.id} repair target ${target.id} must have write permission`);
      if (!node.readOnly) throw new Error(`graph repair source ${node.id} must be read-only`);
      if (!node.dependsOn.includes(target.id)) throw new Error(`graph repair source ${node.id} must depend directly on writer ${target.id}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`parameters.agentTeam.graph contains a dependency cycle involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function readConfig(request: AgentRequest): AgentTeamConfig {
  const value = request.campaign.parameters?.agentTeam;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("parameters.agentTeam must configure a legacy pipeline or graph");
  }
  const record = value as Record<string, unknown>;
  const maxOutputCharacters = integer(record.maxOutputCharacters, 20_000, 1, 1_000_000, "parameters.agentTeam.maxOutputCharacters");
  const maximumParallel = integer(record.maximumParallel, 4, 1, 32, "parameters.agentTeam.maximumParallel");
  if (record.graph !== undefined) {
    if (!record.graph || typeof record.graph !== "object" || Array.isArray(record.graph)) {
      throw new Error("parameters.agentTeam.graph must be an object");
    }
    const graph = record.graph as Record<string, unknown>;
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0 || graph.nodes.length > 64) {
      throw new Error("parameters.agentTeam.graph.nodes must contain from 1 to 64 nodes");
    }
    const nodes = graph.nodes.map(graphNode);
    validateGraph(nodes);
    return {
      kind: "graph",
      nodes,
      context: contextList(graph.context, "parameters.agentTeam.graph.context"),
      maxOutputCharacters,
      maximumParallel,
      maximumTotalAttempts: integer(graph.maximumTotalAttempts, Math.max(64, nodes.length * 4), 1, 1_000, "parameters.agentTeam.graph.maximumTotalAttempts"),
      maximumRepairAttempts: integer(graph.maximumRepairAttempts, 4, 0, 64, "parameters.agentTeam.graph.maximumRepairAttempts")
    };
  }
  return {
    kind: "legacy",
    scouts: contributorList(record.scouts, "scout"),
    planner: contributor(record.planner, "planner", "parameters.agentTeam.planner"),
    implementer: contributor(record.implementer, "implementer", "parameters.agentTeam.implementer"),
    critics: contributorList(record.critics, "critic"),
    maxOutputCharacters,
    maximumParallel
  };
}

async function serializeCandidate<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const canonical = await realpath(resolve(root)).catch(() => resolve(root));
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = candidateQueues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  const queued = previous.catch(() => undefined).then(() => turn);
  candidateQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (candidateQueues.get(key) === queued) candidateQueues.delete(key);
  }
}

function renderCommand(command: string[], request: AgentRequest, stage: TeamStage, contributorId: string, nodeId: string, attempt: number): string[] {
  const replacements: Record<string, string> = {
    "{candidate}": request.candidate.root,
    "{experiment}": request.experimentId,
    "{objective}": request.campaign.objective,
    "{stage}": stage,
    "{contributor}": contributorId,
    "{node}": nodeId,
    "{attempt}": String(attempt)
  };
  return command.map((part) => Object.entries(replacements).reduce(
    (rendered, [token, replacement]) => rendered.replaceAll(token, replacement),
    part
  ));
}

function processCommand(
  executable: string,
  args: string[],
  requestPath: string,
  request: AgentRequest,
  stage: TeamStage,
  contributorId: string,
  nodeId = contributorId,
  attempt = 1
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let failure: ProcessResult["failure"];
    let stopping = false;
    const maximumOutputBytes = 4 * 1024 * 1024;
    const timeoutMs = 15 * 60_000;
    let capturedBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => {};
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      resolveResult(result);
    };
    const child = spawn(executable, args, {
      cwd: request.candidate.root,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: childEnvironment({
        GAMEFACTORY_REQUEST: requestPath,
        GAMEFACTORY_CANDIDATE: request.candidate.root,
        GAMEFACTORY_STAGE: stage,
        GAMEFACTORY_CONTRIBUTOR: contributorId,
        GAMEFACTORY_NODE: nodeId,
        GAMEFACTORY_ATTEMPT: String(attempt)
      })
    });
    const terminate = (reason: NonNullable<ProcessResult["failure"]>): void => {
      if (stopping) return;
      stopping = true;
      failure ??= reason;
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => { child.kill("SIGKILL"); });
        killer.unref();
      }
      else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = maximumOutputBytes - capturedBytes;
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        if (target === "stdout") stdout += kept.toString("utf8");
        else stderr += kept.toString("utf8");
        capturedBytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) terminate("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => { capture("stdout", chunk); });
    child.stderr.on("data", (chunk: Buffer) => { capture("stderr", chunk); });
    abort = () => terminate("cancelled");
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref();
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => finish({ code, stdout, stderr, ...(spawnError ? { spawnError } : {}), ...(failure ? { failure } : {}) }));
  });
}

function lastLine(output: string, fallback: string): string {
  return output.trim().split(/\r?\n/).at(-1) || fallback;
}

function boundedOutput(output: string, maximum: number): string {
  if (output.length <= maximum) return output;
  return `[truncated ${output.length - maximum} characters]\n${output.slice(-maximum)}`;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function candidatePath(root: string, path: string, location: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relativePath = relative(resolve(root), absolute);
  if (relativePath === ".." || relativePath.startsWith("..\\") || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error(`${location} must stay inside the candidate root`);
  }
  return absolute;
}

async function normalizeArtifact(value: unknown, root: string, location: string): Promise<ArtifactReference> {
  const config = contextReference(value, location);
  const path = candidatePath(root, config.path, `${location}.path`);
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(resolve(root)), realpath(path)]);
  const traversal = relative(canonicalRoot, canonicalPath);
  if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`${location}.path resolves outside the candidate root`);
  const result: ArtifactReference = { kind: config.kind, path: canonicalPath };
  if (config.mediaType) result.mediaType = config.mediaType;
  if (config.label) result.label = config.label;
  if (config.metadata) result.metadata = config.metadata;
  return result;
}

async function normalizeContext(references: ContextReferenceConfig[], root: string): Promise<ArtifactReference[]> {
  return Promise.all(references.map((reference, index) => normalizeArtifact(reference, root, `context[${index}]`)));
}

async function structuredOutput(stdout: string, root: string): Promise<StructuredNodeOutput | undefined> {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let record = parseJsonObject(trimmed);
  if (!record) {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      record = parseJsonObject(lines[index]!);
      if (record) break;
    }
  }
  if (!record) return undefined;
  if (record.summary !== undefined && typeof record.summary !== "string") throw new Error("structured output summary must be a string");
  if (record.outcome !== undefined && (typeof record.outcome !== "string" || !OUTCOME_PATTERN.test(record.outcome))) {
    throw new Error("structured output outcome must be a simple outcome name");
  }
  const normalized: StructuredNodeOutput = { ...record };
  if (record.artifacts !== undefined) {
    if (!Array.isArray(record.artifacts) || record.artifacts.length > 64) throw new Error("structured output artifacts must be an array with at most 64 entries");
    normalized.artifacts = await Promise.all(record.artifacts.map((artifact, index) => normalizeArtifact(artifact, root, `structured output artifacts[${index}]`)));
  }
  return normalized;
}

function priorOutput(run: ContributorRun, maximum: number): PriorOutput {
  const output: PriorOutput = {
    contributorId: run.provenance.contributorId,
    nodeId: run.provenance.nodeId,
    stage: run.provenance.stage,
    attempt: run.provenance.attempt,
    outcome: run.provenance.outcome,
    summary: run.provenance.summary,
    output: boundedOutput(run.stdout, maximum),
    stdoutPath: run.provenance.stdoutPath,
    artifacts: run.declaredArtifacts
  };
  if (run.structured) output.structured = run.structured;
  return output;
}

async function invokeContributor(
  config: ContributorConfig,
  stage: TeamStage,
  readOnly: boolean,
  request: AgentRequest,
  inputs: PriorOutput[],
  options: InvocationOptions
): Promise<ContributorRun> {
  const command = renderCommand(config.command, request, stage, config.id, options.nodeId, options.attempt);
  const [executable, ...args] = command;
  if (!executable) throw new Error(`${stage} ${config.id} has no executable`);
  const baseDirectory = resolve(request.candidate.root, ".factory", "agent-team", request.experimentId);
  const outputDirectory = options.mode === "legacy"
    ? resolve(baseDirectory, stage, config.id)
    : resolve(baseDirectory, "graph", options.nodeId, `attempt-${options.attempt}`);
  await mkdir(outputDirectory, { recursive: true });
  const requestPath = resolve(outputDirectory, "request.json");
  const stdoutPath = resolve(outputDirectory, "stdout.log");
  const stderrPath = resolve(outputDirectory, "stderr.log");
  const structuredOutputPath = resolve(outputDirectory, "output.json");
  const payload = {
    objective: request.campaign.objective,
    experimentId: request.experimentId,
    candidateRoot: request.candidate.root,
    mutablePaths: request.campaign.mutablePaths ?? [],
    immutablePaths: request.campaign.immutablePaths ?? [],
    stage,
    role: stage,
    contributorId: config.id,
    nodeId: options.nodeId,
    attempt: options.attempt,
    readOnly,
    permissions: readOnly ? "read" : "write",
    reason: options.reason,
    instructions: options.instructions,
    contextReferences: await normalizeContext(options.context, request.candidate.root),
    inputs,
    history: request.history.map((item) => ({
      id: item.experimentId,
      status: item.status,
      summary: item.summary,
      metrics: item.metrics
    }))
  };
  await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await processCommand(executable, args, requestPath, request, stage, config.id, options.nodeId, options.attempt);
  const finished = Date.now();
  if (result.failure) {
    result.stderr += `${result.stderr.endsWith("\n") || result.stderr.length === 0 ? "" : "\n"}Process terminated: ${result.failure}\n`;
  }
  let parsed: StructuredNodeOutput | undefined;
  let parseFailure: Error | undefined;
  if (result.code === 0 && !result.spawnError) {
    try {
      parsed = await structuredOutput(result.stdout, request.candidate.root);
    } catch (error) {
      parseFailure = error instanceof Error ? error : new Error(String(error));
      result.stderr += `${result.stderr.endsWith("\n") || result.stderr.length === 0 ? "" : "\n"}Structured output error: ${parseFailure.message}\n`;
    }
  }
  await Promise.all([
    writeFile(stdoutPath, result.stdout, "utf8"),
    writeFile(stderrPath, result.stderr, "utf8"),
    ...(parsed ? [writeFile(structuredOutputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")] : [])
  ]);
  const status = result.code === 0 && !result.spawnError && !parseFailure && !result.failure ? "complete" : "failed";
  const outcome = status === "failed" ? "failed" : parsed?.outcome ?? "complete";
  const summary = parsed?.summary ?? lastLine(result.stdout, `${stage} ${config.id} ${status}`);
  const declaredArtifacts = parsed?.artifacts ?? [];
  const artifacts: ArtifactReference[] = [
    { kind: "log", path: stdoutPath, mediaType: "text/plain", label: `${stage} ${config.id} stdout`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    { kind: "log", path: stderrPath, mediaType: "text/plain", label: `${stage} ${config.id} stderr`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    { kind: "other", path: requestPath, mediaType: "application/json", label: `${stage} ${config.id} request`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    ...(parsed ? [{ kind: "other" as const, path: structuredOutputPath, mediaType: "application/json", label: `${stage} ${config.id} structured output`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } }] : []),
    ...declaredArtifacts
  ];
  const provenance: ContributorProvenance = {
    contributorId: config.id,
    nodeId: options.nodeId,
    stage,
    readOnly,
    attempt: options.attempt,
    reason: options.reason,
    command,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: result.code,
    status,
    outcome,
    summary,
    requestPath,
    stdoutPath,
    stderrPath
  };
  if (parsed) provenance.structuredOutputPath = structuredOutputPath;
  const run: ContributorRun = { stdout: result.stdout, stderr: result.stderr, provenance, declaredArtifacts, artifacts };
  if (parsed) run.structured = parsed;
  return run;
}

function isFactoryPath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes(".factory");
}

function meaningfulStatus(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).split(" -> ").at(-1)?.replaceAll("\\", "/") ?? "";
      return !isFactoryPath(path);
    })
    .sort()
    .join("\n");
}

async function gitOutput(request: AgentRequest, args: string[], operation: string): Promise<string> {
  const result = await processCommand("git", args, "", request, "scout", "read-only-guard");
  if (result.code !== 0 || result.spawnError) {
    const detail = result.spawnError?.message ?? result.stderr.trim();
    throw new Error(`agent.team requires a Git candidate for read-only enforcement (${operation}): ${detail}`);
  }
  return result.stdout;
}

async function fingerprint(path: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (stats.isFile()) return `file:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  return `other:${stats.mode}:${stats.size}`;
}

async function gitSnapshot(request: AgentRequest): Promise<string> {
  // Git for Windows may refresh and replace a worktree index while answering
  // status. Keep snapshot reads ordered within a candidate. Separate worktrees
  // still run independently.
  const rawStatus = await gitOutput(request, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"], "status");
  const trackedDiff = await gitOutput(request, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)**/.factory/**"], "diff");
  const rawUntracked = await gitOutput(request, ["ls-files", "--others", "--exclude-standard", "-z"], "untracked files");
  const untrackedPaths = rawUntracked.split("\0").filter((path) => path && !isFactoryPath(path)).sort();
  const untracked = await Promise.all(untrackedPaths.map(async (path) => `${path}:${await fingerprint(resolve(request.candidate.root, path))}`));
  return JSON.stringify({ status: meaningfulStatus(rawStatus), trackedDiff, untracked });
}

function assertRunsSucceeded(stage: TeamStage, runs: ContributorRun[]): void {
  const failures = runs.filter((run) => run.provenance.status === "failed");
  if (failures.length === 0) return;
  const details = failures.map((run) => {
    const reason = run.stderr.trim().slice(-1000) || `exit ${String(run.provenance.exitCode)}`;
    return `${run.provenance.contributorId}: ${reason}`;
  }).join("; ");
  throw new AgentTeamExecutionError(`agent.team ${stage} stage failed: ${details}`, failures);
}

async function mapParallel<T, R>(items: T[], maximumParallel: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maximumParallel, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

async function runReadOnlyBatch(
  stage: "scout" | "critic",
  contributors: ContributorConfig[],
  request: AgentRequest,
  inputs: PriorOutput[],
  maximumParallel: number
): Promise<ContributorRun[]> {
  const before = await gitSnapshot(request);
  const runs = await mapParallel(contributors, maximumParallel, (item) => invokeContributor(item, stage, true, request, inputs, {
    mode: "legacy",
    nodeId: item.id,
    attempt: 1,
    instructions: INSTRUCTIONS[stage],
    context: [],
    reason: { kind: "initial" }
  }));
  const after = await gitSnapshot(request);
  if (before !== after) throw new AgentTeamExecutionError(`agent.team read-only ${stage} stage modified meaningful candidate files`, runs);
  assertRunsSucceeded(stage, runs);
  return runs;
}

async function runReadOnlySingle(
  config: ContributorConfig,
  request: AgentRequest,
  inputs: PriorOutput[]
): Promise<ContributorRun> {
  const before = await gitSnapshot(request);
  const run = await invokeContributor(config, "planner", true, request, inputs, {
    mode: "legacy",
    nodeId: config.id,
    attempt: 1,
    instructions: INSTRUCTIONS.planner,
    context: [],
    reason: { kind: "initial" }
  });
  const after = await gitSnapshot(request);
  if (before !== after) throw new AgentTeamExecutionError("agent.team read-only planner stage modified meaningful candidate files", [run]);
  assertRunsSucceeded("planner", [run]);
  return run;
}

function contribution(run: ContributorRun): AgentContribution {
  return {
    agentId: run.provenance.contributorId,
    role: run.provenance.stage,
    status: run.provenance.status,
    startedAt: run.provenance.startedAt,
    finishedAt: run.provenance.finishedAt,
    summary: run.provenance.summary,
    artifacts: run.artifacts,
    metadata: {
      nodeId: run.provenance.nodeId,
      readOnly: run.provenance.readOnly,
      attempt: run.provenance.attempt,
      reason: run.provenance.reason,
      outcome: run.provenance.outcome,
      command: run.provenance.command,
      durationMs: run.provenance.durationMs,
      exitCode: run.provenance.exitCode,
      requestPath: run.provenance.requestPath,
      stdoutPath: run.provenance.stdoutPath,
      stderrPath: run.provenance.stderrPath,
      ...(run.provenance.structuredOutputPath ? { structuredOutputPath: run.provenance.structuredOutputPath } : {})
    }
  };
}

function legacyResult(runs: ContributorRun[], scouts: ContributorRun[], planner: ContributorRun, implementer: ContributorRun, critics: ContributorRun[]): AgentResult {
  const criticSummary = critics.map((run) => `${run.provenance.contributorId}: ${run.provenance.summary}`).join("; ");
  return {
    summary: `${implementer.provenance.summary}${criticSummary ? ` | Critics: ${criticSummary}` : ""}`,
    artifacts: runs.flatMap((run) => run.artifacts),
    metadata: {
      pipeline: "agent.team",
      mode: "legacy",
      stages: {
        scouts: scouts.map((run) => run.provenance.contributorId),
        planner: planner.provenance.contributorId,
        implementer: implementer.provenance.contributorId,
        critics: critics.map((run) => run.provenance.contributorId)
      }
    },
    contributors: runs.map(contribution)
  };
}

async function runLegacy(config: LegacyAgentTeamConfig, request: AgentRequest): Promise<AgentResult> {
  const scouts = await runReadOnlyBatch("scout", config.scouts, request, [], config.maximumParallel);
  const scoutOutputs = scouts.map((run) => priorOutput(run, config.maxOutputCharacters));
  const planner = await runReadOnlySingle(config.planner, request, scoutOutputs);
  const implementationInputs = [...scoutOutputs, priorOutput(planner, config.maxOutputCharacters)];
  const implementer = await invokeContributor(config.implementer, "implementer", false, request, implementationInputs, {
    mode: "legacy",
    nodeId: config.implementer.id,
    attempt: 1,
    instructions: INSTRUCTIONS.implementer,
    context: [],
    reason: { kind: "initial" }
  });
  assertRunsSucceeded("implementer", [implementer]);
  const criticInputs = [...implementationInputs, priorOutput(implementer, config.maxOutputCharacters)];
  const critics = await runReadOnlyBatch("critic", config.critics, request, criticInputs, config.maximumParallel);
  const runs = [...scouts, planner, implementer, ...critics];
  return legacyResult(runs, scouts, planner, implementer, critics);
}

function latestRun(state: GraphNodeState): ContributorRun | undefined {
  return state.runs.at(-1);
}

function terminal(status: GraphNodeState["status"]): boolean {
  return status === "complete" || status === "failed" || status === "skipped";
}

function conditionAllows(node: GraphNodeConfig, states: Map<string, GraphNodeState>): boolean {
  return node.when.every((condition) => condition.outcomes.includes(states.get(condition.node)!.outcome));
}

function dependencyAllows(node: GraphNodeConfig, states: Map<string, GraphNodeState>): boolean {
  const conditioned = new Set(node.when.map((condition) => condition.node));
  return node.dependsOn.every((dependency) => conditioned.has(dependency) || states.get(dependency)!.status === "complete");
}

function graphInputs(node: GraphNodeConfig, states: Map<string, GraphNodeState>, maximum: number): PriorOutput[] {
  return node.dependsOn.flatMap((dependency) => {
    const run = latestRun(states.get(dependency)!);
    return run ? [priorOutput(run, maximum)] : [];
  });
}

async function runGraph(config: GraphAgentTeamConfig, request: AgentRequest): Promise<AgentResult> {
  const states = new Map(config.nodes.map((node): [string, GraphNodeState] => [node.id, {
    config: node,
    status: "pending",
    outcome: "pending",
    summary: "pending",
    runs: []
  }]));
  let totalAttempts = 0;
  let repairAttempts = 0;
  const repairCounts = new Map<string, number>();

  const runActivation = async (
    state: GraphNodeState,
    reason: InvocationReason,
    extraInputs: PriorOutput[] = []
  ): Promise<void> => {
    state.status = "running";
    for (let localAttempt = 1; localAttempt <= state.config.maximumAttempts; localAttempt += 1) {
      if (totalAttempts >= config.maximumTotalAttempts) {
        throw new AgentTeamExecutionError(
          `agent.team graph exceeded maximumTotalAttempts (${config.maximumTotalAttempts})`,
          [...states.values()].flatMap((nodeState) => nodeState.runs)
        );
      }
      totalAttempts += 1;
      const attempt = state.runs.length + 1;
      const invocationReason: InvocationReason = localAttempt === 1 ? reason : {
        kind: "retry",
        ...(reason.source ? { source: reason.source } : {}),
        ...(reason.repairAttempt !== undefined ? { repairAttempt: reason.repairAttempt } : {})
      };
      const run = await invokeContributor(state.config, state.config.role, state.config.readOnly, request, [
        ...graphInputs(state.config, states, config.maxOutputCharacters),
        ...extraInputs
      ], {
        mode: "graph",
        nodeId: state.config.id,
        attempt,
        instructions: state.config.instructions ?? INSTRUCTIONS[state.config.role],
        context: [...config.context, ...state.config.context],
        reason: invocationReason
      });
      state.runs.push(run);
      state.outcome = run.provenance.outcome;
      state.summary = run.provenance.summary;
      if (run.provenance.status === "complete") {
        state.status = "complete";
        return;
      }
    }
    state.status = "failed";
  };

  const runBatch = async (
    batch: GraphNodeState[],
    reason: InvocationReason,
    extras = new Map<string, PriorOutput[]>()
  ): Promise<void> => {
    if (batch.length === 0) return;
    const readers = batch.every((state) => state.config.readOnly);
    if (!readers && batch.length !== 1) throw new Error("agent.team internal error: writer batch must contain exactly one node");
    const before = readers ? await gitSnapshot(request) : undefined;
    try {
      await mapParallel(batch, readers ? config.maximumParallel : 1, (state) => runActivation(state, reason, extras.get(state.config.id) ?? []));
    } catch (error) {
      const runs = [...states.values()].flatMap((state) => state.runs);
      if (error instanceof AgentTeamExecutionError) throw new AgentTeamExecutionError(error.message, runs);
      if (runs.length > 0) throw new AgentTeamExecutionError(error instanceof Error ? error.message : String(error), runs);
      throw error;
    }
    if (readers) {
      const after = await gitSnapshot(request);
      if (before !== after) {
        throw new AgentTeamExecutionError(
          `agent.team read-only graph nodes modified meaningful candidate files: ${batch.map((state) => state.config.id).join(", ")}`,
          batch.flatMap((state) => state.runs)
        );
      }
    }
  };

  const pending = new Set(config.nodes.map((node) => node.id));
  while (pending.size > 0) {
    const ready = config.nodes
      .filter((node) => pending.has(node.id))
      .filter((node) => node.dependsOn.every((dependency) => terminal(states.get(dependency)!.status)));
    if (ready.length === 0) throw new Error("agent.team graph could not schedule pending nodes");

    const skipped = ready.filter((node) => !conditionAllows(node, states) || !dependencyAllows(node, states));
    for (const node of skipped) {
      const state = states.get(node.id)!;
      state.status = "skipped";
      state.outcome = "skipped";
      state.summary = conditionAllows(node, states)
        ? `Skipped ${node.id} because an unconditional dependency failed or was skipped`
        : `Skipped ${node.id} because its explicit outcome condition did not match`;
      pending.delete(node.id);
    }
    const runnable = ready.filter((node) => !skipped.includes(node));
    if (runnable.length === 0) continue;
    const writers = runnable.filter((node) => !node.readOnly);
    const selected = writers.length > 0 ? [writers[0]!] : runnable.slice(0, config.maximumParallel);
    const batch = selected.map((node) => states.get(node.id)!);
    await runBatch(batch, { kind: "initial" });
    for (const node of selected) pending.delete(node.id);
  }

  while (repairAttempts < config.maximumRepairAttempts) {
    const source = config.nodes.find((node) => {
      if (!node.repair) return false;
      const count = repairCounts.get(node.id) ?? 0;
      return count < node.repair.maximumAttempts && node.repair.outcomes.includes(states.get(node.id)!.outcome);
    });
    if (!source?.repair) break;
    const sourceState = states.get(source.id)!;
    const sourceRun = latestRun(sourceState);
    if (!sourceRun) break;
    repairAttempts += 1;
    const edgeAttempt = (repairCounts.get(source.id) ?? 0) + 1;
    repairCounts.set(source.id, edgeAttempt);
    const targetState = states.get(source.repair.target)!;
    await runBatch([targetState], { kind: "repair", source: source.id, repairAttempt: edgeAttempt }, new Map([
      [targetState.config.id, [priorOutput(sourceRun, config.maxOutputCharacters)]]
    ]));
    if (targetState.status === "failed") break;

    const reviewers = config.nodes
      .filter((node) => node.repair?.target === targetState.config.id)
      .map((node) => states.get(node.id)!)
      .filter((state) => state.status !== "skipped");
    await runBatch(reviewers, { kind: "review", source: targetState.config.id, repairAttempt: edgeAttempt });
  }

  const unresolvedRepairs = config.nodes
    .filter((node) => node.repair?.outcomes.includes(states.get(node.id)!.outcome))
    .map((node) => node.id);
  const requiredFailures = [...states.values()].filter((state) => state.config.required && (
    state.status === "failed"
    || (state.status === "skipped" && conditionAllows(state.config, states))
  ));
  if (requiredFailures.length > 0) {
    const details = requiredFailures.map((state) => `${state.config.id}: ${state.summary}`).join("; ");
    const failedRuns = requiredFailures.flatMap((state) => state.runs);
    if (failedRuns.length === 0) {
      failedRuns.push(...[...states.values()].filter((state) => state.status === "failed").flatMap((state) => state.runs));
    }
    throw new AgentTeamExecutionError(`agent.team graph required nodes failed: ${details}`, failedRuns);
  }

  const runs = config.nodes.flatMap((node) => states.get(node.id)!.runs);
  const dependedOn = new Set(config.nodes.flatMap((node) => node.dependsOn));
  const sinks = config.nodes.filter((node) => !dependedOn.has(node.id) && states.get(node.id)!.status === "complete");
  const writers = config.nodes.filter((node) => !node.readOnly).flatMap((node) => states.get(node.id)!.runs);
  const finalWriter = writers.at(-1);
  const sinkSummary = sinks.map((node) => `${node.id}: ${states.get(node.id)!.summary}`).join("; ");
  const summary = [finalWriter?.provenance.summary, sinkSummary].filter(Boolean).join(" | ") || "Agent graph completed";
  const contributors: AgentContribution[] = runs.map(contribution);
  const now = new Date().toISOString();
  for (const node of config.nodes) {
    const state = states.get(node.id)!;
    if (state.status === "skipped") {
      contributors.push({
        agentId: node.id,
        role: node.role,
        status: "skipped",
        startedAt: now,
        finishedAt: now,
        summary: state.summary,
        artifacts: [],
        metadata: { nodeId: node.id, readOnly: node.readOnly, outcome: state.outcome, attempts: 0 }
      });
    }
  }
  return {
    summary,
    artifacts: runs.flatMap((run) => run.artifacts),
    contributors,
    metadata: {
      pipeline: "agent.team",
      mode: "graph",
      maximumParallel: config.maximumParallel,
      totalAttempts,
      repairAttempts,
      unresolvedRepairs,
      nodes: Object.fromEntries(config.nodes.map((node) => {
        const state = states.get(node.id)!;
        return [node.id, {
          role: node.role,
          readOnly: node.readOnly,
          dependsOn: node.dependsOn,
          status: state.status,
          outcome: state.outcome,
          attempts: state.runs.length,
          summary: state.summary
        }];
      }))
    }
  };
}

export class AgentTeam implements AgentDriver {
  readonly id = "agent.team";

  async run(request: AgentRequest): Promise<AgentResult> {
    return serializeCandidate(request.candidate.root, async () => {
      const config = readConfig(request);
      return config.kind === "legacy" ? runLegacy(config, request) : runGraph(config, request);
    });
  }
}

export default defineExtension((api) => api.register("agent", "agent.team", new AgentTeam()));
