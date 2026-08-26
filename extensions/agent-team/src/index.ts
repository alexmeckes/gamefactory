import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentContribution,
  AgentDriver,
  AgentRequest,
  AgentResult,
  AgentRole,
  ArtifactReference,
  EffectivePromptManifest,
  FactoryTraceEventInput,
  InvocationUsage,
  JournalJsonValue,
  PromptLayer,
  UsageBillingMode
} from "@gamefactory/core";
import { aggregateInvocationUsage, parseInvocationUsage } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";
import { CodexAppServerPool, type CodexAppServerRunResult } from "./codex-app-server.js";

type TeamStage = AgentRole;
type Permission = "read" | "write";
type NodeAuthority = "observe" | "propose" | "mutate-candidate" | "mutate-spec" | "approve";

interface SkillBindingConfig {
  name: string;
  required: boolean;
  sha256?: string;
}

interface LoadedSkill extends SkillBindingConfig {
  source: string;
  content: string;
  resolvedSha256: string;
}

interface ContributorConfig {
  id: string;
  adapter: "command" | "codex-app-server" | "agent-driver";
  command?: string[];
  driver?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  threadRetention: CodexThreadRetention;
  billingMode?: UsageBillingMode;
  timeoutSeconds: number;
  skills: SkillBindingConfig[];
  loadedSkills?: LoadedSkill[];
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type CodexThreadRetention = "ephemeral" | "archive" | "debug";

interface LegacyAgentTeamConfig {
  kind: "legacy";
  scouts: ContributorConfig[];
  planner: ContributorConfig;
  implementer: ContributorConfig;
  critics: ContributorConfig[];
  maxOutputCharacters: number;
  handoffCharacters: number;
  maximumHandoffArtifacts: number;
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
  allowedPaths: string[];
  preserve: string[];
}

interface AdvisorConfig extends ContributorConfig {
  outcomes: string[];
  onFailure: boolean;
  maximumAttempts: number;
  instructions?: string;
}

interface GraphNodeConfig extends ContributorConfig {
  role: AgentRole;
  readOnly: boolean;
  writePaths: string[];
  writePathsExplicit: boolean;
  dependsOn: string[];
  when: GraphCondition[];
  instructions?: string;
  context: ContextReferenceConfig[];
  inheritContext: boolean;
  maximumAttempts: number;
  outputContractRetries: number;
  required: boolean;
  advisory: boolean;
  refreshAfterRepair: boolean;
  requiredOutputFields: string[];
  requiredOutputFieldsOn: string[];
  repair?: RepairEdge;
  invalidationTargets: Record<string, string[]>;
  advisor?: AdvisorConfig;
  authority: NodeAuthority;
  authorityExplicit: boolean;
}

interface GraphAgentTeamConfig {
  kind: "graph";
  nodes: GraphNodeConfig[];
  context: ContextReferenceConfig[];
  maxOutputCharacters: number;
  handoffCharacters: number;
  maximumHandoffArtifacts: number;
  historyLimit: number;
  maximumParallel: number;
  maximumTotalAttempts: number;
  maximumRepairAttempts: number;
  claimIds: string[];
  enforceClaimedBlockers: boolean;
  enforceWriteContracts: boolean;
  reuseCheckpoints: boolean;
  externalInvalidationTargets: Record<string, string[]>;
  maximumExecutionRetries: number;
  maximumAdvisorEscalations: number;
}

type AgentTeamConfig = LegacyAgentTeamConfig | GraphAgentTeamConfig;

interface StructuredNodeOutput {
  summary?: string;
  outcome?: string;
  findings?: unknown;
  context?: unknown;
  artifacts?: ArtifactReference[];
  usage?: InvocationUsage;
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
  reportedOutcome?: string;
  summary: string;
  requestPath: string;
  stdoutPath: string;
  stderrPath: string;
  structuredOutputPath?: string;
  invocationId: string;
  parentInvocationId: string;
  usage?: InvocationUsage;
  promptManifest: EffectivePromptManifest;
  promptManifestPath: string;
  providerThreadId?: string;
  providerTurnId?: string;
  adapter: ContributorConfig["adapter"];
  driver?: string;
  checkpointReused?: boolean;
  checkpointValidationState?: "provisional" | "accepted";
  failureKind?: "output-contract" | "infrastructure" | "execution" | "validation";
}

interface NodeCheckpointManifest {
  version: 6;
  checkpointId: string;
  projectKey: string;
  nodeId: string;
  semanticSha256: string;
  dependenciesSha256: string;
  inputSha256: string;
  outputSha256: string;
  readInputSha256: string;
  readOutputSha256: string;
  snapshotSha256: string;
  candidateRoot: string;
  experimentId: string;
  logicalExperimentId: string;
  outputFiles: string[];
  deletedFiles: string[];
  artifactFiles: string[];
  validationState: "provisional" | "accepted" | "invalidated";
  validationUpdatedAt?: string;
  validationSource?: string;
  run: ContributorRun;
}

interface ContributorRun {
  provenance: ContributorProvenance;
  stdout: string;
  stderr: string;
  structured?: StructuredNodeOutput;
  declaredArtifacts: ArtifactReference[];
  artifacts: ArtifactReference[];
}

function compactFailureFinding(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const finding = value as Record<string, unknown>;
  const text = typeof finding.issue === "string" ? finding.issue : typeof finding.finding === "string" ? finding.finding : undefined;
  if (!text) return undefined;
  return {
    ...(typeof finding.findingClass === "string" ? { findingClass: finding.findingClass.slice(0, 80) } : {}),
    ...(typeof finding.classification === "string" ? { classification: finding.classification.slice(0, 80) } : {}),
    ...(typeof finding.owner === "string" ? { owner: finding.owner.slice(0, 80) } : {}),
    ...(Array.isArray(finding.claimIds) ? { claimIds: finding.claimIds.filter((item): item is string => typeof item === "string").slice(0, 6).map((item) => item.slice(0, 200)) } : {}),
    issue: text.slice(0, 1000),
    ...(Array.isArray(finding.evidence) ? { evidence: finding.evidence.filter((item): item is string => typeof item === "string").slice(0, 6).map((item) => item.slice(0, 500)) } : {})
  };
}

function compactFailureFindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 8).flatMap((item) => compactFailureFinding(item) ?? []);
  if (!value || typeof value !== "object") return undefined;
  const groups = value as Record<string, unknown>;
  return Object.fromEntries(["blockers", "opportunities"].flatMap((key) => {
    const findings = Array.isArray(groups[key]) ? groups[key].slice(0, 8).flatMap((item) => compactFailureFinding(item) ?? []) : [];
    return findings.length > 0 ? [[key, findings]] : [];
  }));
}

function compactFailureStructuredOutput(value: StructuredNodeOutput): Record<string, unknown> {
  const findings = compactFailureFindings(value.findings);
  return {
    ...(typeof value.summary === "string" ? { summary: value.summary.slice(0, 1500) } : {}),
    ...(typeof value.outcome === "string" ? { outcome: value.outcome.slice(0, 80) } : {}),
    ...(findings && (Array.isArray(findings) || Object.keys(findings as Record<string, unknown>).length > 0) ? { findings } : {})
  };
}

export class AgentTeamExecutionError extends Error {
  readonly name: string = "AgentTeamExecutionError";

  constructor(message: string, readonly runs: ContributorRun[]) {
    super(message);
  }

  get artifacts(): ArtifactReference[] {
    return this.runs.flatMap((run) => run.artifacts);
  }

  get provenance(): Record<string, unknown> {
    return {
      contributors: this.runs.map((run) => ({
        ...run.provenance,
        ...(run.structured ? { structured: compactFailureStructuredOutput(run.structured) } : {})
      }))
    };
  }
}

export class AgentTeamInfrastructureError extends AgentTeamExecutionError {
  readonly name: string = "AgentTeamInfrastructureError";
  readonly failureClass = "infrastructure" as const;
}

export class AgentTeamOutputContractError extends AgentTeamInfrastructureError {
  readonly name = "AgentTeamOutputContractError";
}

export class AgentTeamInvalidatedError extends AgentTeamExecutionError {
  readonly name = "AgentTeamInvalidatedError";
  readonly failureClass = "validation" as const;

  constructor(message: string, runs: ContributorRun[], readonly projectDisposition?: Record<string, unknown>) {
    super(message, runs);
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  failure?: "cancelled" | "timeout" | "output-limit";
  failureClass?: "infrastructure" | "execution" | "validation";
  appServer?: CodexAppServerRunResult;
}

interface InvocationReason {
  kind: "initial" | "retry" | "repair" | "review" | "advisor";
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
  historyLimit?: number;
  handoffCharacters: number;
  maximumHandoffArtifacts: number;
}

interface GraphNodeState {
  config: GraphNodeConfig;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  outcome: string;
  summary: string;
  runs: ContributorRun[];
  inputGenerations: Record<string, number>;
  outputContractRetries: number;
  reused?: boolean;
  checkpointId?: string;
  checkpointOutputSha256?: string;
}

const ROLES = new Set<AgentRole>(["scout", "planner", "implementer", "critic", "judge", "worker"]);
const AUTHORITIES = new Set<NodeAuthority>(["observe", "propose", "mutate-candidate", "mutate-spec", "approve"]);
const ARTIFACT_KINDS = new Set<ArtifactReference["kind"]>([
  "image", "video", "audio", "replay", "telemetry", "profile", "test-report", "log", "build", "crash-dump", "other"
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const agentDriverResolvers = new WeakMap<AgentRequest, (id: string) => AgentDriver>();

async function emitAgentTrace(request: AgentRequest, event: FactoryTraceEventInput): Promise<void> {
  try {
    await request.trace?.emit(event);
  } catch {
    // Observability must never change agent execution.
  }
}

function teamTraceNode(request: AgentRequest): string {
  return `agent-team:${request.experimentId}`;
}

function contributorTraceNode(request: AgentRequest, nodeId: string, attempt: number): string {
  return `agent:${request.experimentId}:${nodeId}:attempt-${attempt}`;
}

function agentGraphTraceNode(request: AgentRequest, nodeId: string): string {
  return `agent-node:${request.experimentId}:${nodeId}`;
}

function providerItemRole(type: string): "subagent" | "tool" | undefined {
  if (type === "collabToolCall") return "subagent";
  if (/toolcall|execution|filechange|websearch|imagegeneration/i.test(type)) return "tool";
  return undefined;
}

function providerItemLabel(type: string, tool: unknown): string {
  if (typeof tool === "string" && tool.length > 0 && tool.length <= 128) return tool;
  const labels: Record<string, string> = {
    commandExecution: "Command",
    fileChange: "File change",
    webSearch: "Web search",
    imageGeneration: "ImageGen",
    imageGenerationCall: "ImageGen"
  };
  return labels[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2");
}

const announcedTraceNodes = new WeakMap<AgentRequest, Set<string>>();

async function ensureAgentTraceNode(request: AgentRequest, config: ContributorConfig, stage: TeamStage, readOnly: boolean): Promise<string> {
  const nodeId = agentGraphTraceNode(request, config.id);
  const announced = announcedTraceNodes.get(request) ?? new Set<string>();
  announcedTraceNodes.set(request, announced);
  if (announced.has(nodeId)) return nodeId;
  announced.add(nodeId);
  await emitAgentTrace(request, { type: "node:created", nodeId, experimentId: request.experimentId, parentNodeId: teamTraceNode(request), label: config.id, role: stage, data: { readOnly, timeoutSeconds: config.timeoutSeconds, ...(config.skills.length ? { skills: config.skills.map((skill) => ({ name: skill.name, required: skill.required, ...(skill.sha256 ? { sha256: skill.sha256 } : {}) })) } : {}), ...(config.provider ? { provider: config.provider } : {}), ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), ...(config.billingMode ? { billingMode: config.billingMode } : {}), ...(config.provider || config.model || config.reasoningEffort ? { identitySource: "configured" } : {}) } });
  await emitAgentTrace(request, { type: "edge:created", nodeId: `edge:${teamTraceNode(request)}:${nodeId}`, experimentId: request.experimentId, sourceNodeId: teamTraceNode(request), targetNodeId: nodeId, role: "agent" });
  return nodeId;
}
const OUTCOME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALIDATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const CONTROL_OUTCOME_ALIASES = new Map<string, string>([
  ["revision_required", "revise"],
  ["revision_requested", "revise"],
  ["requires_revision", "revise"],
  ["needs_revision", "revise"],
  ["changes_required", "revise"],
  ["needs_work", "revise"],
  ["needswork", "revise"],
  ["rejected", "reject"],
  ["passed", "pass"],
  ["approved", "pass"],
  ["positive", "pass"]
]);
const REJECTING_CONTROL_OUTCOMES = new Set(["revise", "reject", "fail", "failed", "blocked", "target_revision", "spec_amendment", "crash", "error"]);
const POSITIVE_CONTROL_OUTCOMES = new Set(["pass", "complete", "ready"]);

function canonicalControlOutcome(outcome: string): string {
  const key = outcome.toLowerCase().replaceAll("-", "_").replaceAll(".", "_");
  // Agents often qualify a blocked result with the concrete reason so that the
  // handoff remains useful (for example, blocked_missing_runtime_evidence).
  // The reason belongs in reportedOutcome/summary; control flow must still see
  // the stable fail-closed outcome.
  if (key.startsWith("blocked_")) return "blocked";
  return CONTROL_OUTCOME_ALIASES.get(key) ?? outcome;
}
const candidateQueues = new Map<string, Promise<void>>();
const COMPATIBILITY_ENVIRONMENT = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR"] as const;
const CODEX_HOST_ENVIRONMENT = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"] as const;
const codexAppServers = new CodexAppServerPool();

async function defaultCodexLauncher(): Promise<string[]> {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const binaryRoot = resolve(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      const candidates = await Promise.all((await readdir(binaryRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = resolve(binaryRoot, entry.name, "codex.exe");
          try {
            const stats = await lstat(path);
            return stats.isFile() ? { path, modified: stats.mtimeMs } : undefined;
          } catch {
            return undefined;
          }
        }));
      const newest = candidates
        .filter((candidate): candidate is { path: string; modified: number } => candidate !== undefined)
        .sort((left, right) => right.modified - left.modified)[0];
      if (newest) return [newest.path, "app-server", "--listen", "stdio://"];
    } catch {
      // Fall through to PATH for standalone CLI installations.
    }
  }
  return ["codex", "app-server", "--listen", "stdio://"];
}

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

function codexHostEnvironment(): NodeJS.ProcessEnv {
  const environment = childEnvironment({});
  for (const name of CODEX_HOST_ENVIRONMENT) {
    const entry = Object.entries(process.env).find(([candidate]) => process.platform === "win32"
      ? candidate.toLowerCase() === name.toLowerCase()
      : candidate === name);
    if (entry?.[1] !== undefined) environment[entry[0]] = entry[1];
  }
  return environment;
}

const INSTRUCTIONS: Record<TeamStage, string> = {
  scout: "Inspect the candidate and propose a focused hypothesis. Do not modify any project file. Return findings on stdout.",
  planner: "Synthesize the supplied findings into one concrete, bounded implementation plan. Do not modify any project file. Return the plan on stdout.",
  implementer: "Implement the supplied plan in the candidate. Return a concise change summary on stdout.",
  critic: "Review the candidate against the objective and supplied evidence. Do not modify any project file. Return risks and recommendations on stdout.",
  judge: "Compare the supplied evidence and return a decision with a concise rationale. Do not modify any project file.",
  worker: "Complete the assigned bounded task and return a concise result on stdout."
};

interface RoleCharter {
  content: string;
  path: string;
  version?: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function directorySha256(root: string, current = root): Promise<string> {
  const entries = await readdir(current, { withFileTypes: true });
  const records: Array<[string, string]> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      records.push([`${relative(root, path).replaceAll("\\", "/")}/`, await directorySha256(root, path)]);
    } else if (entry.isFile()) {
      records.push([relative(root, path).replaceAll("\\", "/"), createHash("sha256").update(await readFile(path)).digest("hex")]);
    }
  }
  return sha256(JSON.stringify(records));
}

function journalValue(value: unknown): JournalJsonValue {
  return JSON.parse(JSON.stringify(value)) as JournalJsonValue;
}

function boundedPromptContent(content: string, maximum = 30_000): string {
  if (content.length <= maximum) return content;
  return `${content.slice(0, maximum)}\n\n[GameFactory omitted ${content.length - maximum} trailing characters from this trace layer.]`;
}

function frontmatterVersion(content: string): string | undefined {
  return content.match(/^---[\s\S]*?^version:\s*([^\r\n]+)$/m)?.[1]?.trim();
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.agents/skills");

function skillBindings(value: unknown, location: string): SkillBindingConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${location} must be an array with at most 16 skill bindings`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const record = typeof item === "string" ? { name: item } : item;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${itemLocation} must be a skill name or binding object`);
    const fields = record as Record<string, unknown>;
    if (typeof fields.name !== "string" || !SKILL_NAME_PATTERN.test(fields.name)) throw new Error(`${itemLocation}.name must be a lowercase hyphenated skill name`);
    if (fields.required !== undefined && typeof fields.required !== "boolean") throw new Error(`${itemLocation}.required must be a boolean`);
    if (fields.sha256 !== undefined && (typeof fields.sha256 !== "string" || !SHA256_PATTERN.test(fields.sha256))) throw new Error(`${itemLocation}.sha256 must be a lowercase SHA-256 digest`);
    if (seen.has(fields.name)) throw new Error(`${location} contains duplicate skill ${fields.name}`);
    seen.add(fields.name);
    return { name: fields.name, required: fields.required !== false, ...(typeof fields.sha256 === "string" ? { sha256: fields.sha256 } : {}) };
  });
}

function skillFrontmatterName(content: string): string | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter?.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

async function loadSkills(config: ContributorConfig): Promise<LoadedSkill[]> {
  if (config.loadedSkills) return config.loadedSkills;
  const root = await realpath(DEFAULT_SKILL_ROOT).catch(() => DEFAULT_SKILL_ROOT);
  const loaded: LoadedSkill[] = [];
  for (const binding of config.skills) {
    const source = resolve(DEFAULT_SKILL_ROOT, binding.name, "SKILL.md");
    let content: string;
    let canonical: string;
    try {
      canonical = await realpath(source);
      const traversal = relative(root, canonical);
      if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error("resolved outside the GameFactory skill catalog");
      content = await readFile(canonical, "utf8");
    } catch (error) {
      if (!binding.required) continue;
      throw new Error(`Required skill ${binding.name} is unavailable at ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (skillFrontmatterName(content) !== binding.name) throw new Error(`Skill ${binding.name} frontmatter name does not match its catalog directory`);
    const skillMarkdownSha256 = sha256(content);
    if (binding.sha256 && binding.sha256 !== skillMarkdownSha256) throw new Error(`Skill ${binding.name} SHA-256 does not match its pinned binding`);
    const resolvedSha256 = await directorySha256(dirname(canonical));
    loaded.push({ ...binding, source, content, resolvedSha256 });
  }
  config.loadedSkills = loaded;
  return loaded;
}

async function preflightSkills(config: AgentTeamConfig): Promise<void> {
  const contributors = config.kind === "legacy"
    ? [...config.scouts, config.planner, config.implementer, ...config.critics]
    : config.nodes.flatMap((node) => node.advisor ? [node, node.advisor] : [node]);
  await Promise.all(contributors.map((contributor) => loadSkills(contributor)));
}

function preflightDriverWriteContracts(config: AgentTeamConfig, request: AgentRequest): void {
  if (config.kind !== "graph") return;
  const resolver = agentDriverResolvers.get(request);
  for (const node of config.nodes.filter((candidate) => candidate.adapter === "agent-driver")) {
    if (!resolver || !node.driver) throw new AgentTeamInfrastructureError(`agent-driver node ${node.id} cannot resolve ${node.driver ?? "an unspecified driver"} during preflight`, []);
    const driver = resolver(node.driver);
    const declared = pathPatternList(driver.writePaths === undefined ? undefined : [...driver.writePaths], `agent driver ${driver.id}.writePaths`);
    if (!node.writePathsExplicit && declared.length > 0) node.writePaths = declared;
    const uncovered = declared.filter((path) => !node.writePaths.some((allowed) => simplePatternContains(allowed, path)));
    if (uncovered.length > 0) {
      throw new AgentTeamInfrastructureError(`graph node ${node.id}.writePaths do not cover factory-native driver ${driver.id} side effects: ${uncovered.join(", ")}`, []);
    }
  }
  validateGraph(config.nodes, request.campaign, config.enforceWriteContracts);
}

function loadRoleCharter(stage: TeamStage): Promise<RoleCharter> {
  return (async () => {
    const path = fileURLToPath(new URL(`../instructions/${stage}.md`, import.meta.url));
    try {
      const content = await readFile(path, "utf8");
      const version = frontmatterVersion(content);
      return { content, path, ...(version ? { version } : {}) };
    } catch {
      return { content: INSTRUCTIONS[stage], path: "builtin:agent-team-defaults", version: "0.1.0" };
    }
  })();
}

async function projectInstructionLayers(candidateRoot: string): Promise<{ layers: PromptLayer[]; sources: string[] }> {
  const found: Array<{ path: string; content: string }> = [];
  let current = resolve(candidateRoot);
  for (;;) {
    const path = resolve(current, "AGENTS.md");
    try {
      found.push({ path, content: await readFile(path, "utf8") });
    } catch {
      // AGENTS.md is optional at every directory level.
    }
    const atRepositoryRoot = await lstat(resolve(current, ".git")).then(() => true, () => false);
    const parent = dirname(current);
    if (atRepositoryRoot || parent === current) break;
    current = parent;
  }
  found.reverse();
  return {
    sources: found.map((item) => item.path),
    layers: found.map((item, index) => ({
      id: `project-${index + 1}`,
      kind: "project",
      source: item.path,
      sha256: sha256(item.content),
      content: boundedPromptContent(item.content)
    }))
  };
}

function promptLayer(id: string, kind: PromptLayer["kind"], source: string, content: string, details: { version?: string; metadata?: Record<string, unknown> } = {}): PromptLayer {
  return {
    id,
    kind,
    source,
    sha256: sha256(content),
    content: boundedPromptContent(content),
    ...(details.version ? { version: details.version } : {}),
    ...(details.metadata ? { metadata: details.metadata } : {})
  };
}

async function effectivePromptManifest(input: {
  config: ContributorConfig;
  stage: TeamStage;
  readOnly: boolean;
  request: AgentRequest;
  inputs: PriorOutput[];
  instructions: string;
  contextReferences: ArtifactReference[];
}): Promise<EffectivePromptManifest> {
  const project = await projectInstructionLayers(input.request.candidate.root);
  const charter = await loadRoleCharter(input.stage);
  const skills = await loadSkills(input.config);
  const boundary = JSON.stringify({
    mutablePaths: input.request.campaign.mutablePaths ?? [],
    immutablePaths: input.request.campaign.immutablePaths ?? [],
    permissions: input.readOnly ? "read" : "write",
    ...("writePaths" in input.config && Array.isArray(input.config.writePaths) && input.config.writePaths.length > 0
      ? { writePaths: input.config.writePaths }
      : {})
  }, null, 2);
  const upstream = JSON.stringify(input.inputs.map((item) => ({
    contributorId: item.contributorId,
    nodeId: item.nodeId,
    stage: item.stage,
    outcome: item.outcome,
    summary: item.summary,
    structured: item.structured
  })), null, 2);
  const history = JSON.stringify(input.request.history.map((item) => ({
    id: item.experimentId,
    status: item.status,
    summary: item.summary,
    metrics: item.metrics
  })), null, 2);
  const context = JSON.stringify(input.contextReferences, null, 2);
  const projectContract = input.request.campaign.parameters?.projectSlice ?? input.request.campaign.parameters?.projectSpec;
  const renderedProjectContract = projectContract === undefined ? undefined : JSON.stringify(projectContract, null, 2);
  const adapter = input.config.adapter === "codex-app-server"
    ? "codex.app-server"
    : input.config.adapter === "agent-driver"
      ? `agent:${input.config.driver ?? "unknown"}`
      : "configured-command";
  return {
    version: 1,
    scope: "factory-supplied",
    generatedAt: new Date().toISOString(),
    adapter,
    ...(input.config.provider ? { provider: input.config.provider } : {}),
    ...(input.config.model ? { model: input.config.model } : {}),
    ...(input.config.reasoningEffort ? { reasoningEffort: input.config.reasoningEffort } : {}),
    ...(input.config.billingMode ? { billingMode: input.config.billingMode } : {}),
    timeoutSeconds: input.config.timeoutSeconds,
    instructionSources: [...project.sources, ...skills.map((skill) => skill.source)],
    ...(skills.length ? { skills: skills.map((skill) => ({ name: skill.name, source: skill.source, sha256: skill.resolvedSha256, required: skill.required })) } : {}),
    layers: [
      ...project.layers,
      promptLayer("campaign-objective", "campaign", "campaign.objective", input.request.campaign.objective),
      ...(renderedProjectContract ? [promptLayer("project-contract", "boundary", "campaign.parameters.projectSlice|projectSpec", renderedProjectContract)] : []),
      promptLayer("campaign-boundaries", "boundary", "campaign.mutablePaths+immutablePaths", boundary),
      promptLayer("role-charter", "role", charter.path, charter.content, { ...(charter.version ? { version: charter.version } : {}) }),
      ...skills.map((skill) => promptLayer(`skill-${skill.name}`, "skill", skill.source, skill.content, { metadata: { name: skill.name, required: skill.required } })),
      promptLayer("node-task", "task", "agentTeam.node.instructions", input.instructions),
      ...(input.contextReferences.length ? [promptLayer("context-references", "context", "agentTeam.context", context)] : []),
      ...(input.inputs.length ? [promptLayer("upstream-handoffs", "context", "agentTeam.inputs", upstream)] : []),
      ...(input.request.history.length ? [promptLayer("experiment-history", "history", "campaign.history", history)] : [])
    ],
    context: {
      objective: input.request.campaign.objective,
      role: input.stage,
      contributorId: input.config.id,
      experimentId: input.request.experimentId,
      candidateRoot: input.request.candidate.root,
      readOnly: input.readOnly,
      upstreamOutputs: input.inputs.length,
      contextReferences: input.contextReferences.length,
      historyRecords: input.request.history.length
    },
    limitations: [
      "This manifest records GameFactory-supplied instruction and context layers, not private provider system prompts.",
      "Provider-native instructions and loaded AGENTS.md files are added when the adapter reports them."
    ]
  };
}

function codexTaskPrompt(requestPath: string, manifest: EffectivePromptManifest): string {
  return [
    `You are the ${manifest.context.role} contributor ${manifest.context.contributorId} in a GameFactory experiment.`,
    `Read the complete factory request at ${requestPath}. It contains your role charter, bounded task, permissions, upstream handoffs, context references, and history. Its effectivePromptManifestPath points to a separate provenance manifest; load that manifest only when you need to audit an instruction source or read a bound skill.`,
    manifest.skills?.length ? `Follow these explicitly bound GameFactory skills as procedural instruction layers: ${manifest.skills.map((skill) => `$${skill.name}`).join(", ")}. Their exact content and SHA-256 identities are recorded in the request prompt manifest.` : "No task-specific GameFactory skill is bound to this invocation.",
    manifest.context.readOnly
      ? "This is a read-only contribution. Inspect and reason, but do not modify project files."
      : "You may modify only the mutable paths declared in the request. Respect every immutable path and keep the change bounded.",
    "Use the project AGENTS.md instructions that Codex loaded. Preserve room for exploration: choose and explain a supported hypothesis rather than assuming the visible metric is the whole objective.",
    "Return the App Server response envelope it requests: `summary`, a short machine-readable `outcome` identifier without spaces, and `payload` as a JSON-encoded object. Put free-form `findings` and `context` inside that payload. Use `artifacts` only for paths to actual existing files inside the candidate root (a path string or an artifact object with `path`). Never put source citations, line references, synthetic labels, or request/history identifiers in `artifacts`; put those in `findings.evidence` or `context`. Do not wrap the JSON in Markdown."
  ].join("\n\n");
}

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

function pathPatternList(value: unknown, location: string, maximum = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\0") || isAbsolute(item)) return false;
    return !item.replaceAll("\\", "/").split("/").includes("..");
  })) throw new Error(`${location} must be an array of safe candidate-relative path patterns`);
  return [...new Set(value as string[])];
}

function identityString(value: unknown, location: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error(`${location} must be a non-empty string with at most 256 characters`);
  return value.trim();
}

const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

function reasoningEffort(value: unknown, location: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REASONING_EFFORTS.has(value as ReasoningEffort)) {
    throw new Error(`${location} must be none, low, medium, high, xhigh, or max`);
  }
  return value as ReasoningEffort;
}

function contributor(value: unknown, defaultId: string, location: string, defaults: Pick<ContributorConfig, "provider" | "model" | "reasoningEffort" | "billingMode" | "threadRetention"> & Partial<Pick<ContributorConfig, "timeoutSeconds">> = { threadRetention: "ephemeral" }): ContributorConfig {
  if (isStringArray(value)) return { id: defaultId, adapter: "command", command: [...value], timeoutSeconds: defaults.timeoutSeconds ?? 15 * 60, skills: [], ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be a command string array or an object with id and command`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id ?? defaultId;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(`${location}.id must use only letters, numbers, dots, underscores, and hyphens`);
  }
  const adapter = record.adapter ?? "command";
  if (adapter !== "command" && adapter !== "codex-app-server" && adapter !== "agent-driver") {
    throw new Error(`${location}.adapter must be command, codex-app-server, or agent-driver`);
  }
  if (adapter === "command" && !isStringArray(record.command)) throw new Error(`${location}.command must be a non-empty string array`);
  const driver = identityString(record.driver, `${location}.driver`);
  if (adapter === "agent-driver" && (!driver || !ID_PATTERN.test(driver))) {
    throw new Error(`${location}.driver must identify an agent capability when adapter is agent-driver`);
  }
  if (adapter !== "agent-driver" && driver !== undefined) throw new Error(`${location}.driver requires adapter agent-driver`);
  if (record.command !== undefined && !isStringArray(record.command)) throw new Error(`${location}.command must be a non-empty string array`);
  const provider = identityString(record.provider, `${location}.provider`) ?? defaults.provider;
  const model = identityString(record.model, `${location}.model`) ?? defaults.model;
  const effort = reasoningEffort(record.reasoningEffort, `${location}.reasoningEffort`) ?? defaults.reasoningEffort;
  const threadRetention = record.threadRetention ?? defaults.threadRetention;
  if (threadRetention !== "ephemeral" && threadRetention !== "archive" && threadRetention !== "debug") {
    throw new Error(`${location}.threadRetention must be ephemeral, archive, or debug`);
  }
  const rawBillingMode = record.billingMode ?? defaults.billingMode;
  if (rawBillingMode !== undefined && rawBillingMode !== "subscription" && rawBillingMode !== "credits" && rawBillingMode !== "metered" && rawBillingMode !== "unknown") {
    throw new Error(`${location}.billingMode must be subscription, credits, metered, or unknown`);
  }
  const timeoutSeconds = record.timeoutSeconds ?? defaults.timeoutSeconds ?? 15 * 60;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
    throw new Error(`${location}.timeoutSeconds must be a positive number no greater than 86400`);
  }
  return {
    id,
    adapter,
    ...(isStringArray(record.command) ? { command: [...record.command] } : {}),
    ...(driver ? { driver } : {}),
    ...(provider ? { provider } : adapter === "codex-app-server" ? { provider: "openai-codex-app-server" } : adapter === "agent-driver" ? { provider: "gamefactory-extension" } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    threadRetention,
    timeoutSeconds,
    skills: skillBindings(record.skills, `${location}.skills`),
    ...(rawBillingMode ? { billingMode: rawBillingMode } : adapter === "codex-app-server" ? { billingMode: "subscription" } : {})
  };
}

function contributorList(value: unknown, stage: "scout" | "critic", defaults: Pick<ContributorConfig, "provider" | "model" | "reasoningEffort" | "billingMode" | "threadRetention"> & Partial<Pick<ContributorConfig, "timeoutSeconds">> = { threadRetention: "ephemeral" }): ContributorConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`parameters.agentTeam.${stage}s must be a non-empty array`);
  if (value.length > 64) throw new Error(`parameters.agentTeam.${stage}s cannot contain more than 64 contributors`);
  const contributors = value.map((item, index) => contributor(item, `${stage}-${index + 1}`, `parameters.agentTeam.${stage}s[${index}]`, defaults));
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

function outcomeList(value: unknown, fallback: string[], location: string): string[] {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length === 0 || result.length > 32 || !result.every((outcome) => typeof outcome === "string" && OUTCOME_PATTERN.test(outcome))) {
    throw new Error(`${location} must be a non-empty array of at most 32 outcome names`);
  }
  return [...new Set(result as string[])];
}

function advisorConfig(value: unknown, location: string, primary: ContributorConfig): AdvisorConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  const record = value as Record<string, unknown>;
  if (record.onFailure !== undefined && typeof record.onFailure !== "boolean") throw new Error(`${location}.onFailure must be a boolean`);
  if (record.instructions !== undefined && (typeof record.instructions !== "string" || record.instructions.length > 100_000)) {
    throw new Error(`${location}.instructions must be a string with at most 100000 characters`);
  }
  const advisorAdapter = record.adapter ?? primary.adapter;
  const inheritedCommand = record.command === undefined && advisorAdapter === primary.adapter ? primary.command : record.command;
  const configured = contributor({
    ...record,
    id: record.id ?? `${primary.id}-advisor`,
    adapter: advisorAdapter,
    ...(inheritedCommand ? { command: inheritedCommand } : {})
  }, `${primary.id}-advisor`, location, {
    ...(primary.provider ? { provider: primary.provider } : {}),
    ...(primary.model ? { model: primary.model } : {}),
    ...(primary.reasoningEffort ? { reasoningEffort: primary.reasoningEffort } : {}),
    ...(primary.billingMode ? { billingMode: primary.billingMode } : {}),
    threadRetention: primary.threadRetention
  });
  if (configured.id === primary.id) throw new Error(`${location}.id must differ from the primary contributor id`);
  if (configured.model === primary.model && configured.reasoningEffort === primary.reasoningEffort) {
    throw new Error(`${location} must change model or reasoningEffort from the primary contributor`);
  }
  return {
    ...configured,
    outcomes: outcomeList(record.outcomes, ["needs_advisor"], `${location}.outcomes`),
    onFailure: record.onFailure !== false,
    maximumAttempts: integer(record.maximumAttempts, 1, 1, 4, `${location}.maximumAttempts`),
    ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {})
  };
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
    maximumAttempts: integer(record.maximumAttempts, 1, 1, 16, `${location}.maximumAttempts`),
    allowedPaths: pathPatternList(record.allowedPaths, `${location}.allowedPaths`),
    preserve: stringList(record.preserve, `${location}.preserve`)
  };
}

function invalidationTargets(value: unknown, location: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an outcome-to-writer map`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([outcome, targets]) => {
    if (!INVALIDATION_KEY_PATTERN.test(outcome)) throw new Error(`${location} keys must be evaluator ids or evaluator#violation-code selectors`);
    return [outcome, stringList(targets, `${location}.${outcome}`)];
  }));
}

function graphNode(value: unknown, index: number, defaults: Pick<ContributorConfig, "provider" | "model" | "reasoningEffort" | "billingMode" | "threadRetention"> & Partial<Pick<ContributorConfig, "timeoutSeconds">> = { threadRetention: "ephemeral" }): GraphNodeConfig {
  const location = `parameters.agentTeam.graph.nodes[${index}]`;
  const base = contributor(value, `node-${index + 1}`, location, defaults);
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
  if (record.advisory !== undefined && typeof record.advisory !== "boolean") throw new Error(`${location}.advisory must be a boolean`);
  if (record.refreshAfterRepair !== undefined && typeof record.refreshAfterRepair !== "boolean") {
    throw new Error(`${location}.refreshAfterRepair must be a boolean`);
  }
  if (record.inheritContext !== undefined && typeof record.inheritContext !== "boolean") throw new Error(`${location}.inheritContext must be a boolean`);
  const inferredAuthority: NodeAuthority = readOnly ? role === "judge" ? "approve" : role === "critic" || role === "planner" ? "propose" : "observe" : "mutate-candidate";
  const rawAuthority = record.authority ?? inferredAuthority;
  if (typeof rawAuthority !== "string" || !AUTHORITIES.has(rawAuthority as NodeAuthority)) throw new Error(`${location}.authority is invalid`);
  const authority = rawAuthority as NodeAuthority;
  if ((authority === "mutate-candidate" || authority === "mutate-spec") === readOnly) throw new Error(`${location}.authority ${authority} conflicts with ${readOnly ? "read" : "write"} permission`);
  const advisory = record.advisory === true;
  if (advisory && (!readOnly || authority !== "propose")) throw new Error(`${location}.advisory requires read permission and propose authority`);
  if (record.requiredOutputFields !== undefined && (!Array.isArray(record.requiredOutputFields) || record.requiredOutputFields.length > 64 || record.requiredOutputFields.some((field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/.test(field)))) throw new Error(`${location}.requiredOutputFields contains an invalid field path`);
  const requiredOutputFields = [...new Set((record.requiredOutputFields ?? []) as string[])];
  if (record.writePaths !== undefined && record.driverWritePaths !== undefined) {
    throw new Error(`${location} must use writePaths, not both writePaths and legacy driverWritePaths`);
  }
  const configuredWritePaths = pathPatternList(record.writePaths ?? record.driverWritePaths, `${location}.${record.writePaths !== undefined ? "writePaths" : "driverWritePaths"}`);
  const result: GraphNodeConfig = {
    ...base,
    role,
    readOnly,
    writePaths: configuredWritePaths,
    writePathsExplicit: record.writePaths !== undefined || record.driverWritePaths !== undefined,
    dependsOn: stringList(record.dependsOn ?? record.dependencies, `${location}.dependsOn`),
    when: conditions(record.when, `${location}.when`),
    context: contextList(record.context, `${location}.context`),
    inheritContext: record.inheritContext !== false,
    maximumAttempts: integer(record.maximumAttempts, 1, 1, 8, `${location}.maximumAttempts`),
    outputContractRetries: integer(record.outputContractRetries, base.adapter !== "agent-driver" && readOnly && (authority === "propose" || authority === "approve") ? 1 : 0, 0, 3, `${location}.outputContractRetries`),
    required: record.required !== false,
    advisory,
    refreshAfterRepair: record.refreshAfterRepair === true,
    requiredOutputFields,
    requiredOutputFieldsOn: record.requiredOutputFieldsOn === undefined ? [] : outcomeList(record.requiredOutputFieldsOn, ["pass"], `${location}.requiredOutputFieldsOn`),
    invalidationTargets: invalidationTargets(record.invalidationTargets, `${location}.invalidationTargets`),
    authority,
    authorityExplicit: record.authority !== undefined
  };
  if (typeof record.instructions === "string") result.instructions = record.instructions;
  const repair = repairEdge(record.repair, `${location}.repair`);
  if (repair) result.repair = repair;
  const advisor = advisorConfig(record.advisor, `${location}.advisor`, base);
  if (advisor) {
    if (advisor.skills.length === 0) advisor.skills = [...base.skills];
    result.advisor = advisor;
  }
  return result;
}

function validateRequiredOutputFields(node: GraphNodeConfig, run: ContributorRun): void {
  if (!node.requiredOutputFields.length) return;
  if (node.requiredOutputFieldsOn.length && !node.requiredOutputFieldsOn.includes(run.provenance.outcome)) return;
  const missing = node.requiredOutputFields.filter((path) => {
    let current: unknown = run.structured;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object" || Array.isArray(current) || !(part in current)) return true;
      current = (current as Record<string, unknown>)[part];
    }
    return current === undefined || current === null;
  });
  if (missing.length) throw new AgentTeamOutputContractError(`${node.id} structured output is missing required fields: ${missing.join(", ")}`, [run]);
}

function simplePatternContains(outer: string, inner: string): boolean {
  const normalizedOuter = outer.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedInner = inner.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalizedOuter === "**" || normalizedOuter === normalizedInner) return true;
  if (!normalizedOuter.endsWith("/**")) return false;
  const prefix = normalizedOuter.slice(0, -3).replace(/\/$/, "");
  return normalizedInner === prefix || normalizedInner.startsWith(`${prefix}/`);
}

function validateGraph(nodes: GraphNodeConfig[], campaign: AgentRequest["campaign"], enforceWriteContracts: boolean): void {
  const byId = new Map<string, GraphNodeConfig>();
  const contributorIds = new Set<string>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`parameters.agentTeam.graph.nodes contains duplicate id ${node.id}`);
    if (contributorIds.has(node.id)) throw new Error(`parameters.agentTeam.graph contains duplicate contributor id ${node.id}`);
    byId.set(node.id, node);
    contributorIds.add(node.id);
    if (node.advisor) {
      if (contributorIds.has(node.advisor.id)) throw new Error(`parameters.agentTeam.graph contains duplicate contributor id ${node.advisor.id}`);
      contributorIds.add(node.advisor.id);
    }
  }
  const specOwners = nodes.filter((node) => node.authority === "mutate-spec");
  if (specOwners.length > 1) throw new Error(`agent.team graph may contain at most one mutate-spec authority node; found ${specOwners.map((node) => node.id).join(", ")}`);
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`graph node ${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new Error(`graph node ${node.id} cannot depend on itself`);
    }
    for (const condition of node.when) {
      if (!node.dependsOn.includes(condition.node)) throw new Error(`graph node ${node.id} condition ${condition.node} must also appear in dependsOn`);
    }
    if (node.writePaths.length > 0 && node.readOnly && node.adapter !== "agent-driver") {
      throw new Error(`graph node ${node.id} writePaths requires write permission or a factory-native agent-driver`);
    }
    if (node.writePaths.length > 0) {
      const protectedPaths = [
        ".git/config",
        `nested/.git/config`,
        `.factory/agent-team/exp/graph/${node.id}/output.json`,
        `nested/.factory/agent-team/exp/graph/${node.id}/output.json`
      ];
      if (node.writePaths.some((pattern) => protectedPaths.some((path) => matchesPath(path, pattern)))) {
        throw new Error(`graph node ${node.id} writePaths cannot include Git or agent-team control files`);
      }
    }
    if (enforceWriteContracts && !node.readOnly && !node.writePathsExplicit) {
      throw new Error(`graph node ${node.id} must declare writePaths when enforceWriteContracts is enabled`);
    }
    const outsideCampaign = node.writePaths.filter((path) => !(campaign.mutablePaths ?? []).some((allowed) => simplePatternContains(allowed, path)));
    if (outsideCampaign.length > 0) throw new Error(`graph node ${node.id} writePaths exceed campaign mutablePaths: ${outsideCampaign.join(", ")}`);
    const immutable = node.writePaths.filter((path) => (campaign.immutablePaths ?? []).some((blocked) => simplePatternContains(blocked, path) || simplePatternContains(path, blocked)));
    if (immutable.length > 0) throw new Error(`graph node ${node.id} writePaths overlap campaign immutablePaths: ${immutable.join(", ")}`);
    if (node.repair) {
      if (node.advisory) throw new Error(`graph advisory node ${node.id} cannot own a repair edge`);
      const target = byId.get(node.repair.target);
      if (!target) throw new Error(`graph node ${node.id} repairs unknown node ${node.repair.target}`);
      if (target.readOnly) throw new Error(`graph node ${node.id} repair target ${target.id} must have write permission`);
      if (target.authority !== "mutate-candidate" && target.authority !== "mutate-spec") throw new Error(`graph node ${node.id} repair target ${target.id} lacks mutation authority`);
      if (!node.readOnly) throw new Error(`graph repair source ${node.id} must be read-only`);
      if (!node.dependsOn.includes(target.id)) throw new Error(`graph repair source ${node.id} must depend directly on writer ${target.id}`);
      if (enforceWriteContracts) {
        if (node.repair.allowedPaths.length === 0) node.repair.allowedPaths = [...target.writePaths];
        const uncovered = target.writePaths.filter((path) => !node.repair!.allowedPaths.some((allowed) => simplePatternContains(allowed, path)));
        if (uncovered.length > 0) throw new Error(`graph node ${node.id} repair allowedPaths do not cover ${target.id}.writePaths: ${uncovered.join(", ")}`);
      }
      for (const preserved of node.repair.preserve) {
        const contract = byId.get(preserved);
        if (!contract) throw new Error(`graph node ${node.id} preserves unknown node ${preserved}`);
        if (!contract.readOnly) throw new Error(`graph node ${node.id} preserved contract ${preserved} must be read-only`);
        if (!contract.dependsOn.includes(target.id)) throw new Error(`graph node ${node.id} preserved contract ${preserved} must depend directly on writer ${target.id}`);
      }
    }
    for (const [outcome, targets] of Object.entries(node.invalidationTargets)) {
      for (const targetId of targets) {
        const target = byId.get(targetId);
        if (!target) throw new Error(`graph node ${node.id} invalidationTargets.${outcome} names unknown node ${targetId}`);
        if (target.readOnly) throw new Error(`graph node ${node.id} invalidationTargets.${outcome} target ${targetId} must be a writer`);
        if (!dependsTransitively(node.id, targetId, byId)) throw new Error(`graph node ${node.id} invalidationTargets.${outcome} target ${targetId} must be upstream`);
      }
    }
    if (node.refreshAfterRepair) {
      if (!node.readOnly) throw new Error(`graph refresh node ${node.id} must be read-only`);
      if (!node.dependsOn.some((dependency) => byId.get(dependency)?.readOnly === false)) {
        throw new Error(`graph refresh node ${node.id} must depend directly on a writer`);
      }
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

function readConfig(request: Pick<AgentRequest, "campaign">): AgentTeamConfig {
  const value = request.campaign.parameters?.agentTeam;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("parameters.agentTeam must configure a legacy pipeline or graph");
  }
  const record = value as Record<string, unknown>;
  const provider = identityString(record.provider, "parameters.agentTeam.provider");
  const model = identityString(record.model, "parameters.agentTeam.model");
  const effort = reasoningEffort(record.reasoningEffort, "parameters.agentTeam.reasoningEffort");
  const threadRetention = record.threadRetention ?? "ephemeral";
  if (threadRetention !== "ephemeral" && threadRetention !== "archive" && threadRetention !== "debug") {
    throw new Error("parameters.agentTeam.threadRetention must be ephemeral, archive, or debug");
  }
  const rawBillingMode = record.billingMode;
  if (rawBillingMode !== undefined && rawBillingMode !== "subscription" && rawBillingMode !== "credits" && rawBillingMode !== "metered" && rawBillingMode !== "unknown") {
    throw new Error("parameters.agentTeam.billingMode must be subscription, credits, metered, or unknown");
  }
  const rawTimeoutSeconds = record.timeoutSeconds;
  if (rawTimeoutSeconds !== undefined && (typeof rawTimeoutSeconds !== "number" || !Number.isFinite(rawTimeoutSeconds) || rawTimeoutSeconds <= 0 || rawTimeoutSeconds > 86_400)) {
    throw new Error("parameters.agentTeam.timeoutSeconds must be a positive number no greater than 86400");
  }
  const defaults: Pick<ContributorConfig, "provider" | "model" | "reasoningEffort" | "billingMode" | "threadRetention"> & Partial<Pick<ContributorConfig, "timeoutSeconds">> = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    threadRetention,
    ...(rawBillingMode ? { billingMode: rawBillingMode as UsageBillingMode } : {}),
    ...(typeof rawTimeoutSeconds === "number" ? { timeoutSeconds: rawTimeoutSeconds } : {})
  };
  const maxOutputCharacters = integer(record.maxOutputCharacters, 20_000, 1, 1_000_000, "parameters.agentTeam.maxOutputCharacters");
  const handoffCharacters = integer(record.handoffCharacters, Math.min(maxOutputCharacters, 12_000), 512, 100_000, "parameters.agentTeam.handoffCharacters");
  const maximumHandoffArtifacts = integer(record.maximumHandoffArtifacts, 24, 0, 256, "parameters.agentTeam.maximumHandoffArtifacts");
  const historyLimit = integer(record.historyLimit, 6, 0, 100, "parameters.agentTeam.historyLimit");
  const maximumParallel = integer(record.maximumParallel, 4, 1, 32, "parameters.agentTeam.maximumParallel");
  if (record.graph !== undefined) {
    if (!record.graph || typeof record.graph !== "object" || Array.isArray(record.graph)) {
      throw new Error("parameters.agentTeam.graph must be an object");
    }
    const graph = record.graph as Record<string, unknown>;
    if (graph.enforceClaimedBlockers !== undefined && typeof graph.enforceClaimedBlockers !== "boolean") throw new Error("parameters.agentTeam.graph.enforceClaimedBlockers must be a boolean");
    if (graph.enforceWriteContracts !== undefined && typeof graph.enforceWriteContracts !== "boolean") throw new Error("parameters.agentTeam.graph.enforceWriteContracts must be a boolean");
    if (graph.reuseCheckpoints !== undefined && typeof graph.reuseCheckpoints !== "boolean") throw new Error("parameters.agentTeam.graph.reuseCheckpoints must be a boolean");
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0 || graph.nodes.length > 64) {
      throw new Error("parameters.agentTeam.graph.nodes must contain from 1 to 64 nodes");
    }
    const nodes = graph.nodes.map((node, index) => graphNode(node, index, defaults));
    const enforceWriteContracts = graph.enforceWriteContracts === true;
    validateGraph(nodes, request.campaign, enforceWriteContracts);
    const externalInvalidationTargets = invalidationTargets(graph.externalInvalidationTargets, "parameters.agentTeam.graph.externalInvalidationTargets");
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const [evaluator, targets] of Object.entries(externalInvalidationTargets)) {
      for (const targetId of targets) {
        const target = nodesById.get(targetId);
        if (!target) throw new Error(`parameters.agentTeam.graph.externalInvalidationTargets.${evaluator} names unknown node ${targetId}`);
        if (target.readOnly) throw new Error(`parameters.agentTeam.graph.externalInvalidationTargets.${evaluator} target ${targetId} must be a writer`);
      }
    }
    const rawAttemptPolicy = graph.attemptPolicy;
    if (rawAttemptPolicy !== undefined && (!rawAttemptPolicy || typeof rawAttemptPolicy !== "object" || Array.isArray(rawAttemptPolicy))) throw new Error("parameters.agentTeam.graph.attemptPolicy must be an object");
    const policy = (rawAttemptPolicy ?? {}) as Record<string, unknown>;
    const maximumRepairAttempts = integer(policy.creativeRepairs ?? graph.maximumRepairAttempts, 4, 0, 64, "parameters.agentTeam.graph.attemptPolicy.creativeRepairs");
    return {
      kind: "graph",
      nodes,
      context: contextList(graph.context, "parameters.agentTeam.graph.context"),
      maxOutputCharacters,
      handoffCharacters,
      maximumHandoffArtifacts,
      historyLimit,
      maximumParallel,
      maximumTotalAttempts: integer(graph.maximumTotalAttempts, Math.max(64, nodes.length * 4), 1, 1_000, "parameters.agentTeam.graph.maximumTotalAttempts"),
      maximumRepairAttempts,
      claimIds: stringList(graph.claimIds, "parameters.agentTeam.graph.claimIds"),
      enforceClaimedBlockers: graph.enforceClaimedBlockers === true || nodes.some((node) => node.authorityExplicit),
      enforceWriteContracts,
      reuseCheckpoints: graph.reuseCheckpoints === true,
      externalInvalidationTargets,
      maximumExecutionRetries: integer(policy.executionRetries, Math.max(16, nodes.length * 2), 0, 1_000, "parameters.agentTeam.graph.attemptPolicy.executionRetries"),
      maximumAdvisorEscalations: integer(policy.advisorEscalations, Math.max(4, nodes.length), 0, 1_000, "parameters.agentTeam.graph.attemptPolicy.advisorEscalations")
    };
  }
  return {
    kind: "legacy",
    scouts: contributorList(record.scouts, "scout", defaults),
    planner: contributor(record.planner, "planner", "parameters.agentTeam.planner", defaults),
    implementer: contributor(record.implementer, "implementer", "parameters.agentTeam.implementer", defaults),
    critics: contributorList(record.critics, "critic", defaults),
    maxOutputCharacters,
    handoffCharacters,
    maximumHandoffArtifacts,
    maximumParallel
  };
}

export function validateAgentTeamConfiguration(campaign: AgentRequest["campaign"]): void {
  readConfig({ campaign });
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
  attempt = 1,
  onProgress?: (progress: { stdoutBytes: number; stderrBytes: number; capturedBytes: number }) => void,
  timeoutSeconds = 15 * 60
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let failure: ProcessResult["failure"];
    let stopping = false;
    const maximumOutputBytes = 4 * 1024 * 1024;
    const timeoutMs = timeoutSeconds * 1000;
    let capturedBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastProgressBytes = 0;
    let lastProgressAt = 0;
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
      if (target === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      const remaining = maximumOutputBytes - capturedBytes;
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        if (target === "stdout") stdout += kept.toString("utf8");
        else stderr += kept.toString("utf8");
        capturedBytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) terminate("output-limit");
      const now = Date.now();
      const total = stdoutBytes + stderrBytes;
      if (onProgress && (total - lastProgressBytes >= 64 * 1024 || now - lastProgressAt >= 750)) {
        lastProgressBytes = total;
        lastProgressAt = now;
        onProgress({ stdoutBytes, stderrBytes, capturedBytes });
      }
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
  if (maximum <= 0) return "";
  if (output.length <= maximum) return output;
  const marker = `[truncated ${output.length - maximum} characters]\n`;
  return marker.length >= maximum ? output.slice(-maximum) : `${marker}${output.slice(-(maximum - marker.length))}`;
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
  const usage = parseInvocationUsage(record.usage);
  if (usage) normalized.usage = usage;
  return normalized;
}

function priorOutput(run: ContributorRun, maximum: number, maximumArtifacts = 24): PriorOutput {
  let structured = run.structured ? Object.fromEntries(Object.entries(run.structured).filter(([key]) => key !== "artifacts" && key !== "usage")) as StructuredNodeOutput : undefined;
  if (structured && JSON.stringify(structured).length > maximum) {
    structured = {
      ...(structured.summary ? { summary: structured.summary } : {}),
      ...(structured.outcome ? { outcome: structured.outcome } : {}),
      findings: boundedOutput(JSON.stringify(structured.findings ?? structured.context ?? {}), maximum),
      context: { handoffTruncated: true, availableAt: run.provenance.structuredOutputPath ?? run.provenance.stdoutPath }
    };
  }
  const output: PriorOutput = {
    contributorId: run.provenance.contributorId,
    nodeId: run.provenance.nodeId,
    stage: run.provenance.stage,
    attempt: run.provenance.attempt,
    outcome: run.provenance.outcome,
    summary: run.provenance.summary,
    output: structured ? "" : boundedOutput(run.stdout, maximum),
    stdoutPath: run.provenance.stdoutPath,
    artifacts: run.declaredArtifacts.slice(0, maximumArtifacts)
  };
  if (structured) output.structured = structured;
  return output;
}

function boundedPriorInput(input: PriorOutput, maximum: number, maximumArtifacts: number): PriorOutput {
  const summaryBudget = Math.min(512, Math.max(1, Math.floor(maximum / 4)));
  const summary = boundedOutput(input.summary, summaryBudget);
  const detailBudget = Math.max(1, maximum - summary.length);
  let structured = input.structured
    ? Object.fromEntries(Object.entries(input.structured).filter(([key]) => key !== "artifacts" && key !== "usage" && key !== "summary")) as StructuredNodeOutput
    : undefined;
  if (structured && JSON.stringify(structured).length > detailBudget) {
    const details = JSON.stringify(structured.findings ?? structured.context ?? structured);
    structured = {
      ...(structured.outcome ? { outcome: structured.outcome } : {}),
      findings: boundedOutput(details, detailBudget),
      context: { handoffTruncated: true, availableAt: input.stdoutPath }
    };
  }
  return {
    ...input,
    summary,
    output: structured ? "" : boundedOutput(input.output, detailBudget),
    artifacts: input.artifacts.slice(0, maximumArtifacts),
    ...(structured ? { structured } : {})
  };
}

function boundedPriorInputs(inputs: PriorOutput[], maximum: number, maximumArtifacts: number): PriorOutput[] {
  if (inputs.length === 0) return [];
  const baseCharacters = Math.floor(maximum / inputs.length);
  let characterRemainder = maximum % inputs.length;
  const baseArtifacts = Math.floor(maximumArtifacts / inputs.length);
  let artifactRemainder = maximumArtifacts % inputs.length;
  return inputs.map((input) => boundedPriorInput(
    input,
    Math.max(1, baseCharacters + (characterRemainder-- > 0 ? 1 : 0)),
    baseArtifacts + (artifactRemainder-- > 0 ? 1 : 0)
  ));
}

function boundedHistoryRecords(history: AgentRequest["history"], maximum: number): AgentRequest["history"] {
  const compact = history.map((record) => ({
    campaignId: record.campaignId,
    ...(record.runId ? { runId: record.runId } : {}),
    experimentId: record.experimentId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    ...(record.revision ? { revision: record.revision } : {}),
    summary: "",
    metrics: Object.fromEntries(Object.entries(record.metrics).sort(([left], [right]) => left.localeCompare(right)).slice(0, 16)),
    evaluations: []
  }));
  while (compact.length > 1 && JSON.stringify(compact).length > maximum) compact.shift();
  if (compact.length === 0) return [];
  const fixed = JSON.stringify(compact).length;
  const available = Math.max(0, maximum - fixed);
  const each = Math.floor(available / compact.length);
  for (let index = 0; index < compact.length; index += 1) {
    compact[index]!.summary = boundedOutput(history[history.length - compact.length + index]!.summary, each);
  }
  while (JSON.stringify(compact).length > maximum && compact.some((record) => record.summary.length > 0)) {
    const longest = compact.reduce((best, record) => record.summary.length > best.summary.length ? record : best, compact[0]!);
    longest.summary = longest.summary.slice(0, Math.max(0, longest.summary.length - 32));
  }
  return compact;
}

async function invokeContributor(
  config: ContributorConfig,
  stage: TeamStage,
  readOnly: boolean,
  request: AgentRequest,
  inputs: PriorOutput[],
  options: InvocationOptions
): Promise<ContributorRun> {
  const selectedHistory = options.historyLimit === undefined
    ? request.history
    : options.historyLimit === 0 ? [] : request.history.slice(-options.historyLimit);
  const historyBudget = inputs.length > 0 && selectedHistory.length > 0 ? Math.floor(options.handoffCharacters / 4) : selectedHistory.length > 0 ? options.handoffCharacters : 0;
  const inputBudget = selectedHistory.length > 0 && inputs.length > 0 ? options.handoffCharacters - historyBudget : options.handoffCharacters;
  inputs = boundedPriorInputs(inputs, inputBudget, options.maximumHandoffArtifacts);
  const launcher = config.adapter === "codex-app-server" && config.command === undefined
    ? await defaultCodexLauncher()
    : config.command ?? [];
  const command = config.adapter === "agent-driver"
    ? [`agent:${config.driver ?? "unknown"}`]
    : config.adapter === "codex-app-server"
    ? renderCommand(launcher, request, stage, config.id, options.nodeId, options.attempt)
    : renderCommand(config.command ?? [], request, stage, config.id, options.nodeId, options.attempt);
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
  const promptManifestPath = resolve(outputDirectory, "prompt-manifest.json");
  const contextReferences = await normalizeContext(options.context, request.candidate.root);
  const roleCharter = await loadRoleCharter(stage);
  const history = boundedHistoryRecords(selectedHistory, historyBudget);
  const invocationRequest = history === request.history ? request : { ...request, history };
  let promptManifest = await effectivePromptManifest({ config, stage, readOnly, request: invocationRequest, inputs, instructions: options.instructions, contextReferences });
  const payload = {
    objective: request.campaign.objective,
    experimentId: request.experimentId,
    candidateRoot: request.candidate.root,
    mutablePaths: request.campaign.mutablePaths ?? [],
    immutablePaths: request.campaign.immutablePaths ?? [],
    ...(request.campaign.parameters?.projectSlice !== undefined ? { projectSlice: request.campaign.parameters.projectSlice } : {}),
    ...(request.campaign.parameters?.projectSpec !== undefined ? { projectSpec: request.campaign.parameters.projectSpec } : {}),
    stage,
    role: stage,
    contributorId: config.id,
    nodeId: options.nodeId,
    attempt: options.attempt,
    invocationId: contributorTraceNode(request, options.nodeId, options.attempt),
    parentInvocationId: agentGraphTraceNode(request, config.id),
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.billingMode ? { billingMode: config.billingMode } : {}),
    ...(config.provider || config.model || config.reasoningEffort ? { identitySource: "configured" } : {}),
    readOnly,
    permissions: readOnly ? "read" : "write",
    ...("writePaths" in config && Array.isArray(config.writePaths) && config.writePaths.length > 0
      ? { writePaths: config.writePaths }
      : {}),
    reason: options.reason,
    roleCharter: roleCharter.content,
    instructions: options.instructions,
    contextReferences,
    inputs,
    history: history.map((item) => ({
      id: item.experimentId,
      status: item.status,
      summary: item.summary,
      metrics: item.metrics
    })),
    effectivePromptManifestPath: promptManifestPath
  };
  await Promise.all([
    writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
    writeFile(promptManifestPath, `${JSON.stringify(promptManifest, null, 2)}\n`, "utf8")
  ]);
  const graphNodeId = await ensureAgentTraceNode(request, config, stage, readOnly);
  await emitAgentTrace(request, { type: "node:started", nodeId: graphNodeId, experimentId: request.experimentId, label: config.id, role: stage, attempt: options.attempt, message: options.reason.kind });
  const traceNodeId = contributorTraceNode(request, options.nodeId, options.attempt);
  await emitAgentTrace(request, {
    type: "node:created",
    nodeId: traceNodeId,
    experimentId: request.experimentId,
    parentNodeId: graphNodeId,
    label: config.id,
    role: stage,
    attempt: options.attempt,
    message: options.reason.kind,
    data: journalValue({ readOnly, invocationId: traceNodeId, parentInvocationId: graphNodeId, promptManifest, ...(config.provider ? { provider: config.provider } : {}), ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), ...(config.billingMode ? { billingMode: config.billingMode } : {}), ...(config.provider || config.model || config.reasoningEffort ? { identitySource: "configured" } : {}), reason: { kind: options.reason.kind, ...(options.reason.source ? { source: options.reason.source } : {}), ...(options.reason.repairAttempt !== undefined ? { repairAttempt: options.reason.repairAttempt } : {}) } })
  });
  await emitAgentTrace(request, {
    type: "edge:created",
    nodeId: `edge:${graphNodeId}:${traceNodeId}`,
    experimentId: request.experimentId,
    sourceNodeId: graphNodeId,
    targetNodeId: traceNodeId,
    role: "agent"
  });
  await emitAgentTrace(request, { type: "node:started", nodeId: traceNodeId, experimentId: request.experimentId, label: config.id, role: stage, attempt: options.attempt });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let result: ProcessResult;
  let agentDriverArtifacts: ArtifactReference[] = [];
  if (config.adapter === "agent-driver") {
    try {
      const resolver = agentDriverResolvers.get(request);
      if (!resolver || !config.driver) throw new Error("agent-driver adapter is unavailable outside an activated AgentTeam extension");
      if (config.driver === "agent.team") throw new Error("agent-driver nodes cannot recursively invoke agent.team");
      const controller = new AbortController();
      const relay = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", relay, { once: true });
      if (request.signal.aborted) relay();
      const timer = setTimeout(() => controller.abort(new Error(`agent-driver ${config.driver} timed out`)), config.timeoutSeconds * 1000);
      let delegated: AgentResult;
      try {
        delegated = await resolver(config.driver).run({
          ...invocationRequest,
          signal: controller.signal,
          invocation: {
            nodeId: options.nodeId,
            attempt: options.attempt,
            instructions: options.instructions,
            reason: options.reason,
            inputs: inputs.map((input) => ({
              contributorId: input.contributorId,
              nodeId: input.nodeId,
              role: input.stage,
              attempt: input.attempt,
              outcome: input.outcome,
              summary: input.summary,
              ...(input.structured ? { structured: input.structured } : {}),
              artifacts: input.artifacts
            }))
          }
        });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", relay);
      }
      agentDriverArtifacts = await Promise.all((delegated.artifacts ?? []).map((item, index) => normalizeArtifact(item, request.candidate.root, `agent-driver artifacts[${index}]`)));
      const delegatedOutcome = typeof delegated.metadata?.outcome === "string" && OUTCOME_PATTERN.test(delegated.metadata.outcome)
        ? delegated.metadata.outcome
        : "complete";
      result = {
        code: 0,
        stdout: JSON.stringify({
          summary: delegated.summary,
          outcome: delegatedOutcome,
          ...(delegated.usage ? { usage: delegated.usage } : {}),
          ...(delegated.metadata?.structured && typeof delegated.metadata.structured === "object" && !Array.isArray(delegated.metadata.structured)
            ? delegated.metadata.structured as Record<string, unknown>
            : {}),
          context: {
            driver: config.driver,
            metadata: delegated.metadata ?? {},
            contributors: delegated.contributors ?? []
          }
        }),
        stderr: ""
      };
    } catch (error) {
      const rawArtifacts = error && typeof error === "object" && Array.isArray((error as { artifacts?: unknown }).artifacts)
        ? (error as { artifacts: unknown[] }).artifacts
        : [];
      agentDriverArtifacts = await Promise.all(rawArtifacts.map((item, index) => normalizeArtifact(item, request.candidate.root, `agent-driver failure artifacts[${index}]`)));
      const failureClass = error && typeof error === "object" && ["infrastructure", "execution", "validation"].includes(String((error as { failureClass?: unknown }).failureClass))
        ? (error as { failureClass: "infrastructure" | "execution" | "validation" }).failureClass
        : "execution";
      result = { code: 1, stdout: "", stderr: error instanceof Error ? error.stack ?? error.message : String(error), failureClass };
    }
  } else if (config.adapter === "codex-app-server") {
    const announcedProviderItems = new Set<string>();
    let providerTraceTail = Promise.resolve();
    try {
      const appServer = await codexAppServers.run({
        launcher: command,
        cwd: request.candidate.root,
        prompt: codexTaskPrompt(requestPath, promptManifest),
        readOnly,
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        retention: config.threadRetention,
        timeoutMs: config.timeoutSeconds * 1000,
        signal: request.signal,
        environment: codexHostEnvironment(),
        onEvent: (event) => {
          const item = event.params.item && typeof event.params.item === "object" && !Array.isArray(event.params.item)
            ? event.params.item as Record<string, unknown>
            : undefined;
          const providerError = event.params.error && typeof event.params.error === "object" && !Array.isArray(event.params.error)
            ? event.params.error as Record<string, unknown>
            : undefined;
          const providerMessage = typeof event.params.message === "string"
            ? event.params.message
            : typeof providerError?.message === "string"
              ? providerError.message
              : undefined;
          providerTraceTail = providerTraceTail.then(async () => {
            await emitAgentTrace(request, {
              type: "node:progress",
              nodeId: traceNodeId,
              experimentId: request.experimentId,
              label: config.id,
              role: stage,
              attempt: options.attempt,
              message: event.method,
              data: {
                providerEvent: event.method,
                 ...(typeof item?.type === "string" ? { itemType: item.type } : {}),
                 ...(typeof item?.status === "string" ? { itemStatus: item.status } : {}),
                 ...(providerMessage ? { providerMessage } : {})
               }
            });
            if (typeof item?.type !== "string" || typeof item.id !== "string") return;
            const providerRole = providerItemRole(item.type);
            if (!providerRole) return;
            const providerNodeId = `${traceNodeId}:provider-item:${item.id}`;
            const label = providerItemLabel(item.type, item.tool);
            const providerData = journalValue({
              providerEvent: event.method,
              itemType: item.type,
              providerItemId: item.id,
              ...(typeof item.status === "string" ? { itemStatus: item.status } : {}),
              ...(typeof item.senderThreadId === "string" ? { senderThreadId: item.senderThreadId } : {}),
              ...(typeof item.receiverThreadId === "string" ? { receiverThreadId: item.receiverThreadId } : {}),
              ...(typeof item.newThreadId === "string" ? { newThreadId: item.newThreadId } : {}),
            });
            if (!announcedProviderItems.has(providerNodeId)) {
              announcedProviderItems.add(providerNodeId);
              await emitAgentTrace(request, {
                type: "node:created",
                nodeId: providerNodeId,
                experimentId: request.experimentId,
                parentNodeId: traceNodeId,
                label,
                role: providerRole,
                message: providerRole === "subagent" ? "Codex App Server collaboration item" : "Codex App Server tool item",
                data: providerData
              });
              await emitAgentTrace(request, {
                type: "edge:created",
                nodeId: `edge:${traceNodeId}:${providerNodeId}`,
                experimentId: request.experimentId,
                sourceNodeId: traceNodeId,
                targetNodeId: providerNodeId,
                role: providerRole
              });
              await emitAgentTrace(request, {
                type: "node:started",
                nodeId: providerNodeId,
                experimentId: request.experimentId,
                label,
                role: providerRole,
                status: "running",
                data: providerData
              });
            }
            if (event.method === "item/completed" || event.method === "item/failed") {
              const failed = item.status === "failed";
              await emitAgentTrace(request, {
                type: failed ? "node:failed" : "node:completed",
                nodeId: providerNodeId,
                experimentId: request.experimentId,
                label,
                role: providerRole,
                status: failed ? "failed" : "complete",
                data: providerData
              });
            }
          });
        }
      });
      await providerTraceTail;
      result = { code: 0, stdout: appServer.output, stderr: appServer.eventLog, appServer };
      promptManifest = {
        ...promptManifest,
        instructionSources: [...new Set([...promptManifest.instructionSources, ...appServer.instructionSources])],
        providerContext: {
          threadId: appServer.threadId,
          turnId: appServer.turnId,
          instructionSources: appServer.instructionSources,
          ...(appServer.modelProvider ? { modelProvider: appServer.modelProvider } : {}),
          ...(appServer.requestedModel ? { requestedModel: appServer.requestedModel } : {}),
          ...(appServer.actualModel ? { actualModel: appServer.actualModel } : {}),
          ...(appServer.requestedReasoningEffort ? { requestedReasoningEffort: appServer.requestedReasoningEffort } : {}),
          ...(appServer.reasoningEffort ? { reasoningEffort: appServer.reasoningEffort } : {}),
          threadLifecycle: appServer.lifecycle
        } as NonNullable<EffectivePromptManifest["providerContext"]>
      };
      await writeFile(promptManifestPath, `${JSON.stringify(promptManifest, null, 2)}\n`, "utf8");
    } catch (error) {
      await providerTraceTail;
      result = { code: 1, stdout: "", stderr: error instanceof Error ? error.stack ?? error.message : String(error) };
    }
  } else {
    result = await processCommand(executable, args, requestPath, request, stage, config.id, options.nodeId, options.attempt, (progress) => {
      void emitAgentTrace(request, {
        type: "node:progress",
        nodeId: traceNodeId,
        experimentId: request.experimentId,
        label: config.id,
        role: stage,
        attempt: options.attempt,
        message: "Subprocess output",
        progress: { current: progress.stdoutBytes + progress.stderrBytes, unit: "bytes" },
        data: progress
      });
    }, config.timeoutSeconds);
  }
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
  const reportedOutcome = status === "failed" ? "failed" : parsed?.outcome ?? "complete";
  const outcome = canonicalControlOutcome(reportedOutcome);
  const summary = parsed?.summary ?? lastLine(result.stdout, `${stage} ${config.id} ${status}`);
  const usage = parseInvocationUsage(result.appServer?.usage ?? parsed?.usage, {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(result.appServer?.actualModel ? { model: result.appServer.actualModel } : config.model ? { model: config.model } : {}),
    ...(result.appServer?.reasoningEffort ? { reasoningEffort: result.appServer.reasoningEffort } : config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.billingMode ? { billingMode: config.billingMode } : {}),
    ...(result.appServer ? { identitySource: "provider-reported" as const } : config.provider || config.model || config.reasoningEffort ? { identitySource: "configured" as const } : {})
  });
  const declaredArtifacts = parsed?.artifacts ?? agentDriverArtifacts;
  const artifacts: ArtifactReference[] = [
    { kind: "log", path: stdoutPath, mediaType: "text/plain", label: `${stage} ${config.id} stdout`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    { kind: "log", path: stderrPath, mediaType: "text/plain", label: `${stage} ${config.id} stderr`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    { kind: "other", path: requestPath, mediaType: "application/json", label: `${stage} ${config.id} request`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt } },
    { kind: "other", path: promptManifestPath, mediaType: "application/json", label: `${stage} ${config.id} effective prompt manifest`, metadata: { stage, contributorId: config.id, nodeId: options.nodeId, attempt: options.attempt, promptManifestVersion: 1 } },
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
    adapter: config.adapter,
    ...(config.driver ? { driver: config.driver } : {}),
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: result.code,
    status,
    outcome,
    ...(parseFailure
      ? { failureKind: "output-contract" as const }
      : status === "failed"
        ? { failureKind: result.failureClass ?? "execution" }
        : {}),
    ...(reportedOutcome !== outcome ? { reportedOutcome } : {}),
    summary,
    requestPath,
    stdoutPath,
    stderrPath,
    invocationId: traceNodeId,
    parentInvocationId: graphNodeId,
    promptManifest,
    promptManifestPath,
    ...(result.appServer?.threadId ? { providerThreadId: result.appServer.threadId } : {}),
    ...(result.appServer?.turnId ? { providerTurnId: result.appServer.turnId } : {})
  };
  if (usage) provenance.usage = usage;
  if (parsed) provenance.structuredOutputPath = structuredOutputPath;
  const run: ContributorRun = { stdout: result.stdout, stderr: result.stderr, provenance, declaredArtifacts, artifacts };
  if (parsed) run.structured = parsed;
  await emitAgentTrace(request, {
    type: status === "complete" ? "node:completed" : "node:failed",
    nodeId: traceNodeId,
    experimentId: request.experimentId,
    label: config.id,
    role: stage,
    status,
    attempt: options.attempt,
    message: summary,
    data: journalValue({ outcome, durationMs: finished - started, exitCode: result.code, artifactCount: artifacts.length, invocationId: traceNodeId, parentInvocationId: graphNodeId, promptManifest, ...(result.appServer?.threadId ? { providerThreadId: result.appServer.threadId } : {}), ...(result.appServer?.turnId ? { providerTurnId: result.appServer.turnId } : {}), ...(usage ? { usage: { ...usage } } : {}) })
  });
  if (artifacts.length > 0) {
    await emitAgentTrace(request, { type: "artifact:produced", nodeId: traceNodeId, experimentId: request.experimentId, label: config.id, role: stage, attempt: options.attempt, message: `${artifacts.length} artifacts produced`, data: { count: artifacts.length } });
  }
  return run;
}

function isManagedAgentRuntimePath(path: string, experimentId: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const marker = `.factory/agent-team/${experimentId}/`;
  return normalized.startsWith(marker) || normalized.includes(`/${marker}`);
}

function ignoredSnapshotPath(path: string, experimentId: string, allowedPatterns: string[]): boolean {
  return isManagedAgentRuntimePath(path, experimentId) || allowedPatterns.some((pattern) => matchesPath(path, pattern));
}

function meaningfulStatus(output: string, experimentId: string, allowedPatterns: string[]): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).split(" -> ").at(-1)?.replaceAll("\\", "/") ?? "";
      return !ignoredSnapshotPath(path, experimentId, allowedPatterns);
    })
    .sort()
    .join("\n");
}

function meaningfulStatusPaths(output: string, experimentId: string, allowedPatterns: string[]): string[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line): string[] => {
    const path = line.slice(3).split(" -> ").at(-1)?.replaceAll("\\", "/") ?? "";
    return path && !ignoredSnapshotPath(path, experimentId, allowedPatterns) ? [path] : [];
  });
}

function matchesPath(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    expression += /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${expression}$`).test(path.replaceAll("\\", "/").replace(/^\.\//, ""));
}

async function gitOutput(request: AgentRequest, args: string[], operation: string): Promise<string> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await processCommand("git", args, "", request, "scout", "read-only-guard");
    if (result.code === 0 && !result.spawnError) return result.stdout;
    const detail = result.spawnError?.message ?? (result.stderr.trim() || `exit code ${String(result.code)} with no stderr`);
    failures.push(`attempt ${attempt}: ${detail}`);
  }
  throw new AgentTeamInfrastructureError(
    `agent.team requires a Git candidate for read-only enforcement (${operation}) after 3 bounded attempts: ${failures.join("; ")}`,
    []
  );
}

async function fingerprint(path: string): Promise<string> {
  let stats;
  try { stats = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (stats.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (stats.isFile()) {
    const hash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolvePromise);
    });
    return `file:${hash.digest("hex")}`;
  }
  return `other:${stats.mode}:${stats.size}`;
}

async function meaningfulFileState(request: AgentRequest): Promise<Map<string, string>> {
  const prefix = (await gitOutput(request, ["rev-parse", "--show-prefix"], "repair scope prefix"))
    .trim()
    .replaceAll("\\", "/");
  const rawStatus = await gitOutput(request, [
    "-c", "core.quotepath=false",
    "-c", "status.relativePaths=true",
    "status", "--porcelain=v1", "--untracked-files=all"
  ], "repair scope");
  const paths = [...new Set(meaningfulStatusPaths(rawStatus, request.experimentId, [])
    .filter((path) => prefix.length === 0 || path === prefix.slice(0, -1) || path.startsWith(prefix))
    .map((path) => prefix.length > 0 && path.startsWith(prefix) ? path.slice(prefix.length) : path)
    .filter(Boolean))].sort();
  return new Map(await Promise.all(paths.map(async (path) => [path, await fingerprint(resolve(request.candidate.root, path))] as const)));
}

function changedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

async function gitSnapshot(request: AgentRequest, allowedPatterns: string[] = []): Promise<string> {
  // Git for Windows may refresh and replace a worktree index while answering
  // status. Keep snapshot reads ordered within a candidate. Separate worktrees
  // still run independently.
  const rawStatus = await gitOutput(request, [
    "-c", "core.quotepath=false",
    "-c", "status.relativePaths=true",
    "status", "--porcelain=v1", "--untracked-files=all"
  ], "status");
  const paths = [...new Set(meaningfulStatusPaths(rawStatus, request.experimentId, allowedPatterns))].sort();
  const files = await Promise.all(paths.map(async (path) => `${path}:${await fingerprint(resolve(request.candidate.root, path))}`));
  return JSON.stringify({ status: meaningfulStatus(rawStatus, request.experimentId, allowedPatterns), files });
}

function checkpointProjectKey(request: AgentRequest): string {
  const slice = request.campaign.parameters?.projectSlice;
  const raw = slice && typeof slice === "object" && !Array.isArray(slice) && typeof (slice as Record<string, unknown>).projectId === "string"
    ? (slice as Record<string, unknown>).projectId as string
    : `project-${sha256(resolve(request.campaign.projectRoot)).slice(0, 16)}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
}

async function checkpointSemanticSha256(node: GraphNodeConfig, request: AgentRequest, graph: GraphAgentTeamConfig): Promise<string> {
  const roleCharter = await loadRoleCharter(node.role);
  const projectInstructions = await projectInstructionLayers(request.candidate.root);
  const context = node.inheritContext ? [...graph.context, ...node.context] : node.context;
  const contextFingerprints = await Promise.all(context.map(async (reference) => {
    const path = candidatePath(request.candidate.root, reference.path, "checkpoint context");
    return { ...reference, path: reference.path.replaceAll("\\", "/"), sha256: await fingerprint(path) };
  }));
  const commandFiles = (await Promise.all((node.command ?? []).map(async (argument) => {
    const path = isAbsolute(argument) ? resolve(argument) : resolve(request.candidate.root, argument);
    const traversal = relative(request.candidate.root, path);
    if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) return undefined;
    try {
      if (!(await lstat(path)).isFile()) return undefined;
      return { argument, path: traversal.replaceAll("\\", "/"), sha256: await fingerprint(path) };
    } catch {
      return undefined;
    }
  }))).filter((value): value is { argument: string; path: string; sha256: string } => value !== undefined);
  const history = boundedHistoryRecords(graph.historyLimit === 0 ? [] : request.history
    .filter((record) => (record.metadata?.logicalExperimentId ?? record.experimentId) !== (request.logicalExperimentId ?? request.experimentId))
    .slice(-graph.historyLimit), graph.handoffCharacters);
  return sha256(JSON.stringify({
    version: 3,
    id: node.id,
    adapter: node.adapter,
    command: node.command,
    commandFiles,
    driver: node.driver,
    provider: node.provider,
    model: node.model,
    reasoningEffort: node.reasoningEffort,
    billingMode: node.billingMode,
    threadRetention: node.threadRetention,
    timeoutSeconds: node.timeoutSeconds,
    skills: (node.loadedSkills ?? []).map((skill) => ({ name: skill.name, required: skill.required, sha256: skill.resolvedSha256 })),
    role: node.role,
    roleCharterSha256: sha256(roleCharter.content),
    projectInstructionLayers: projectInstructions.layers.map((layer) => ({ id: layer.id, sha256: layer.sha256 })),
    campaignObjective: request.campaign.objective,
    runtimeImplementationFingerprint: request.runtime?.implementationFingerprint,
    projectSlice: request.campaign.parameters?.projectSlice,
    projectSpec: request.campaign.parameters?.projectSpec,
    history,
    readOnly: node.readOnly,
    writePaths: node.writePaths,
    outputContractRetries: node.outputContractRetries,
    maximumAttempts: node.maximumAttempts,
    required: node.required,
    advisory: node.advisory,
    refreshAfterRepair: node.refreshAfterRepair,
    repair: node.repair,
    advisor: node.advisor ? {
      id: node.advisor.id,
      adapter: node.advisor.adapter,
      command: node.advisor.command,
      driver: node.advisor.driver,
      provider: node.advisor.provider,
      model: node.advisor.model,
      reasoningEffort: node.advisor.reasoningEffort,
      billingMode: node.advisor.billingMode,
      threadRetention: node.advisor.threadRetention,
      timeoutSeconds: node.advisor.timeoutSeconds,
      outcomes: node.advisor.outcomes,
      onFailure: node.advisor.onFailure,
      maximumAttempts: node.advisor.maximumAttempts,
      instructions: node.advisor.instructions,
      skills: node.advisor.skills
    } : undefined,
    dependsOn: node.dependsOn,
    when: node.when,
    instructions: node.instructions,
    context: contextFingerprints,
    inheritContext: node.inheritContext,
    requiredOutputFields: node.requiredOutputFields,
    requiredOutputFieldsOn: node.requiredOutputFieldsOn,
    authority: node.authority,
    invalidationTargets: node.invalidationTargets,
    checkpointPolicy: {
      enforceWriteContracts: graph.enforceWriteContracts,
      externalInvalidationTargets: graph.externalInvalidationTargets,
      handoffCharacters: graph.handoffCharacters,
      maximumHandoffArtifacts: graph.maximumHandoffArtifacts,
      historyLimit: graph.historyLimit
    }
  }));
}

async function checkpointArtifactIdentity(artifact: ArtifactReference, candidateRoot: string): Promise<Record<string, unknown>> {
  const traversal = relative(candidateRoot, artifact.path).replaceAll("\\", "/");
  const contained = traversal && !traversal.startsWith("..") && !isAbsolute(traversal);
  const contentSha256 = artifact.sha256 ?? (contained ? await fingerprint(resolve(candidateRoot, traversal)).catch(() => "missing") : "out-of-scope");
  return { kind: artifact.kind, path: contained ? traversal : artifact.path, sha256: contentSha256, label: artifact.label, mediaType: artifact.mediaType };
}

const TRANSIENT_CHECKPOINT_KEYS = new Set([
  "approvedAt", "finishedAt", "generatedAt", "manifestPath", "promptManifestPath", "requestPath", "startedAt", "stderrPath", "stdoutPath", "structuredOutputPath"
]);

function checkpointStableValue(value: unknown, request: AgentRequest, key?: string): unknown {
  if (key && TRANSIENT_CHECKPOINT_KEYS.has(key)) return undefined;
  if (typeof value === "string") {
    const normalizedRoot = resolve(request.candidate.root).replaceAll("\\", "/");
    return value.replaceAll("\\", "/")
      .replaceAll(normalizedRoot, "<candidate-root>")
      .replaceAll(request.experimentId, "<experiment-id>");
  }
  if (Array.isArray(value)) return value.map((item) => checkpointStableValue(item, request));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().flatMap((childKey) => {
    const normalized = checkpointStableValue((value as Record<string, unknown>)[childKey], request, childKey);
    return normalized === undefined ? [] : [[childKey, normalized]];
  }));
}

async function checkpointDependenciesSha256(node: GraphNodeConfig, states: Map<string, GraphNodeState>, request: AgentRequest): Promise<string> {
  return sha256(JSON.stringify(await Promise.all(node.dependsOn.map(async (dependency) => {
    const state = states.get(dependency)!;
    const run = latestRun(state);
    return {
      id: dependency,
      outcome: state.outcome,
      ...(state.checkpointOutputSha256 ? { writerOutputSha256: state.checkpointOutputSha256 } : {}),
      structured: checkpointStableValue(run?.structured, request),
      summary: checkpointStableValue(run?.provenance.summary, request),
      stdout: run?.structured ? undefined : checkpointStableValue(run?.stdout, request),
      artifacts: run ? await Promise.all(run.declaredArtifacts.map((artifact) => checkpointArtifactIdentity(artifact, request.candidate.root))) : []
    };
  }))));
}

async function scopedContentFiles(request: AgentRequest, patterns: string[]): Promise<string[]> {
  const inventory = await gitOutput(request, [
    "-c", "core.quotepath=false",
    "ls-files", "-co", "--exclude-standard", "-z"
  ], "checkpoint inventory");
  return [...new Set(inventory.split("\0")
    .map((path) => path.replaceAll("\\", "/"))
    .filter(Boolean)
    .filter((path) => !path.startsWith(".factory/") && patterns.some((pattern) => matchesPath(path, pattern))))].sort();
}

async function scopedContentSha256(request: AgentRequest, patterns: string[]): Promise<string> {
  return contentStateSha256(await scopedContentState(request, patterns));
}

async function scopedContentState(request: AgentRequest, patterns: string[]): Promise<Map<string, string>> {
  const paths = await scopedContentFiles(request, patterns);
  return new Map(await Promise.all(paths.map(async (path) => [path, await fingerprint(resolve(request.candidate.root, path))] as const)));
}

function contentStateSha256(state: Map<string, string>): string {
  return sha256(JSON.stringify([...state.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

async function copyCheckpointFiles(
  sourceRoot: string,
  targetRoot: string,
  paths: readonly string[],
  targetPath: (path: string) => string = (path) => path
): Promise<void> {
  for (const path of paths) {
    const source = resolve(sourceRoot, path);
    const target = resolve(targetRoot, targetPath(path));
    const traversal = relative(targetRoot, target);
    if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`Checkpoint path escapes its root: ${path}`);
    const stats = await lstat(source);
    if (!stats.isFile()) throw new Error(`Checkpoint only supports regular files: ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function checkpointArtifactFiles(run: ContributorRun, candidateRoot: string): Promise<string[]> {
  const paths = run.artifacts.flatMap((artifact): string[] => {
    const traversal = relative(candidateRoot, artifact.path);
    return traversal && !traversal.startsWith("..") && !isAbsolute(traversal) ? [traversal.replaceAll("\\", "/")] : [];
  });
  const existing: string[] = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      if ((await lstat(resolve(candidateRoot, path))).isFile()) existing.push(path);
    } catch {
      // Missing optional contributor artifacts are already handled by preservation.
    }
  }
  return existing;
}

function remapExperimentPath(path: string, fromExperimentId: string, toExperimentId: string): string {
  return path
    .replaceAll(`.factory/agent-team/${fromExperimentId}/`, `.factory/agent-team/${toExperimentId}/`)
    .replaceAll(`.factory\\agent-team\\${fromExperimentId}\\`, `.factory\\agent-team\\${toExperimentId}\\`);
}

function remapCheckpointValue(value: unknown, fromRoot: string, toRoot: string, fromExperimentId: string, toExperimentId: string): unknown {
  if (typeof value === "string") {
    const from = process.platform === "win32" ? fromRoot.toLowerCase() : fromRoot;
    const candidate = process.platform === "win32" ? value.toLowerCase() : value;
    const rooted = candidate === from || candidate.startsWith(`${from}${process.platform === "win32" ? "\\" : "/"}`)
      ? resolve(toRoot, relative(fromRoot, value))
      : value;
    return remapExperimentPath(rooted, fromExperimentId, toExperimentId);
  }
  if (Array.isArray(value)) return value.map((item) => remapCheckpointValue(item, fromRoot, toRoot, fromExperimentId, toExperimentId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapCheckpointValue(item, fromRoot, toRoot, fromExperimentId, toExperimentId)]));
}

function checkpointNodeDirectory(request: AgentRequest, node: GraphNodeConfig): string | undefined {
  if (!request.runtime?.dataRoot) return undefined;
  return resolve(request.runtime.dataRoot, ".factory", "agent-team-checkpoints", checkpointProjectKey(request), node.id);
}

async function deleteCheckpointFiles(targetRoot: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const target = resolve(targetRoot, path);
    const traversal = relative(targetRoot, target);
    if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`Checkpoint delete path escapes its root: ${path}`);
    try {
      if (!(await lstat(target)).isFile()) throw new Error(`Checkpoint only deletes regular files: ${path}`);
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function loadNodeCheckpoint(node: GraphNodeConfig, states: Map<string, GraphNodeState>, request: AgentRequest, graph: GraphAgentTeamConfig): Promise<{ run: ContributorRun; checkpointId: string; outputSha256: string; validationState: "provisional" | "accepted" } | undefined> {
  const directory = checkpointNodeDirectory(request, node);
  if (!directory) return undefined;
  const semanticSha256 = await checkpointSemanticSha256(node, request, graph);
  const dependenciesSha256 = await checkpointDependenciesSha256(node, states, request);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const manifests = await Promise.all(entries.filter((item) => item.isFile() && item.name.endsWith(".json")).map(async (entry) => {
    try { return JSON.parse(await readFile(resolve(directory, entry.name), "utf8")) as NodeCheckpointManifest; }
    catch { return undefined; }
  }));
  manifests.sort((left, right) => Number(right?.validationState === "accepted") - Number(left?.validationState === "accepted"));
  for (const manifest of manifests) {
    try {
      if (!manifest || manifest.version !== 6 || manifest.nodeId !== node.id || manifest.semanticSha256 !== semanticSha256 || manifest.dependenciesSha256 !== dependenciesSha256) continue;
      const validationState = manifest.validationState ?? "provisional";
      if (validationState === "invalidated") continue;
      if (validationState === "provisional" && (
        resolve(manifest.candidateRoot) !== resolve(request.candidate.root)
        || manifest.logicalExperimentId !== (request.logicalExperimentId ?? request.experimentId)
      )) continue;
      let outputSha256 = await scopedContentSha256(request, node.writePaths);
      let readStateSha256 = await scopedContentSha256(request, ["**"]);
      if (outputSha256 === manifest.outputSha256 && readStateSha256 !== manifest.readOutputSha256) continue;
      if (manifest.outputSha256 !== outputSha256) {
        if (resolve(manifest.candidateRoot) === resolve(request.candidate.root)) continue;
        if (outputSha256 !== manifest.inputSha256) continue;
        if (readStateSha256 !== manifest.readInputSha256) continue;
        const snapshotRoot = resolve(directory, `${manifest.checkpointId}.files`, "output");
        const snapshotHash = sha256(JSON.stringify(await Promise.all(manifest.outputFiles.map(async (path) => [path, await fingerprint(resolve(snapshotRoot, path))] as const))));
        if (snapshotHash !== manifest.snapshotSha256) continue;
        await copyCheckpointFiles(snapshotRoot, request.candidate.root, manifest.outputFiles);
        await deleteCheckpointFiles(request.candidate.root, manifest.deletedFiles);
        outputSha256 = await scopedContentSha256(request, node.writePaths);
        if (manifest.outputSha256 !== outputSha256) continue;
        readStateSha256 = await scopedContentSha256(request, ["**"]);
        if (manifest.readOutputSha256 !== readStateSha256) continue;
      }
      await copyCheckpointFiles(
        resolve(directory, `${manifest.checkpointId}.files`, "artifacts"),
        request.candidate.root,
        manifest.artifactFiles,
        (path) => remapExperimentPath(path, manifest.experimentId, request.experimentId)
      );
      const run = remapCheckpointValue(manifest.run, manifest.candidateRoot, request.candidate.root, manifest.experimentId, request.experimentId) as ContributorRun;
      if (run.provenance?.status !== "complete") continue;
      run.provenance.invocationId = contributorTraceNode(request, node.id, 1);
      run.provenance.parentInvocationId = agentGraphTraceNode(request, node.id);
      run.provenance.reason = { kind: "initial" };
      run.provenance.checkpointReused = true;
      run.provenance.checkpointValidationState = validationState;
      return { run, checkpointId: manifest.checkpointId, outputSha256: manifest.outputSha256, validationState };
    } catch {
      // A malformed or stale checkpoint is ignored and the node executes normally.
    }
  }
  return undefined;
}

async function saveNodeCheckpoint(node: GraphNodeConfig, states: Map<string, GraphNodeState>, request: AgentRequest, run: ContributorRun, graph: GraphAgentTeamConfig, inputState: Map<string, string>, readInputState: Map<string, string>): Promise<{ checkpointId: string; outputSha256: string } | undefined> {
  const directory = checkpointNodeDirectory(request, node);
  if (!directory) return undefined;
  const outputState = await scopedContentState(request, node.writePaths);
  const outputFiles = [...outputState].filter(([path, digest]) => inputState.get(path) !== digest).map(([path]) => path).sort();
  const deletedFiles = [...inputState.keys()].filter((path) => !outputState.has(path)).sort();
  const artifactFiles = await checkpointArtifactFiles(run, request.candidate.root);
  const semanticSha256 = await checkpointSemanticSha256(node, request, graph);
  const dependenciesSha256 = await checkpointDependenciesSha256(node, states, request);
  const inputSha256 = contentStateSha256(inputState);
  const outputSha256 = contentStateSha256(outputState);
  const readInputSha256 = contentStateSha256(readInputState);
  const readOutputSha256 = await scopedContentSha256(request, ["**"]);
  const snapshotSha256 = sha256(JSON.stringify(outputFiles.map((path) => [path, outputState.get(path)!])));
  const checkpointId = sha256(JSON.stringify({
    semanticSha256,
    dependenciesSha256,
    inputSha256,
    outputSha256,
    readInputSha256,
    readOutputSha256,
    experimentId: request.experimentId,
    invocationId: run.provenance.invocationId,
    finishedAt: run.provenance.finishedAt
  }));
  const manifest: NodeCheckpointManifest = {
    version: 6,
    checkpointId,
    projectKey: checkpointProjectKey(request),
    nodeId: node.id,
    semanticSha256,
    dependenciesSha256,
    inputSha256,
    outputSha256,
    readInputSha256,
    readOutputSha256,
    snapshotSha256,
    candidateRoot: request.candidate.root,
    experimentId: request.experimentId,
    logicalExperimentId: request.logicalExperimentId ?? request.experimentId,
    outputFiles,
    deletedFiles,
    artifactFiles,
    validationState: "provisional",
    run
  };
  try {
    await mkdir(directory, { recursive: true });
    const snapshot = resolve(directory, `${checkpointId}.files`);
    await copyCheckpointFiles(request.candidate.root, resolve(snapshot, "output"), outputFiles);
    await copyCheckpointFiles(request.candidate.root, resolve(snapshot, "artifacts"), artifactFiles);
    await writeFile(resolve(directory, `${checkpointId}.json`), JSON.stringify(manifest, null, 2), "utf8");
    return { checkpointId, outputSha256 };
  } catch (error) {
    throw new AgentTeamInfrastructureError(`Could not persist durable checkpoint for ${node.id}: ${error instanceof Error ? error.message : String(error)}`, [run]);
  }
}

async function updateNodeCheckpointValidationState(
  node: GraphNodeConfig,
  request: AgentRequest,
  checkpointId: string,
  validationState: "accepted" | "invalidated",
  validationSource: string
): Promise<void> {
  const directory = checkpointNodeDirectory(request, node);
  if (!directory) return;
  const path = resolve(directory, `${checkpointId}.json`);
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as NodeCheckpointManifest;
    if (manifest.version !== 6 || manifest.nodeId !== node.id || manifest.checkpointId !== checkpointId) {
      throw new Error(`checkpoint identity ${checkpointId} does not match ${node.id}`);
    }
    manifest.validationState = validationState;
    manifest.validationUpdatedAt = new Date().toISOString();
    manifest.validationSource = validationSource;
    await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
  } catch (error) {
    throw new AgentTeamInfrastructureError(`Could not mark checkpoint ${node.id}@${checkpointId.slice(0, 12)} ${validationState}: ${error instanceof Error ? error.message : String(error)}`, []);
  }
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
  maximumParallel: number,
  handoffCharacters: number,
  maximumHandoffArtifacts: number
): Promise<ContributorRun[]> {
  const before = await gitSnapshot(request);
  const runs = await mapParallel(contributors, maximumParallel, (item) => invokeContributor(item, stage, true, request, inputs, {
    mode: "legacy",
    nodeId: item.id,
    attempt: 1,
    instructions: INSTRUCTIONS[stage],
    context: [],
    reason: { kind: "initial" },
    handoffCharacters,
    maximumHandoffArtifacts
  }));
  const after = await gitSnapshot(request);
  if (before !== after) throw new AgentTeamExecutionError(`agent.team read-only ${stage} stage modified meaningful candidate files`, runs);
  assertRunsSucceeded(stage, runs);
  return runs;
}

async function runReadOnlySingle(
  config: ContributorConfig,
  request: AgentRequest,
  inputs: PriorOutput[],
  handoffCharacters: number,
  maximumHandoffArtifacts: number
): Promise<ContributorRun> {
  const before = await gitSnapshot(request);
  const run = await invokeContributor(config, "planner", true, request, inputs, {
    mode: "legacy",
    nodeId: config.id,
    attempt: 1,
    instructions: INSTRUCTIONS.planner,
    context: [],
    reason: { kind: "initial" },
    handoffCharacters,
    maximumHandoffArtifacts
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
    invocationId: run.provenance.invocationId,
    parentInvocationId: run.provenance.parentInvocationId,
    ...(run.provenance.usage ? { usage: run.provenance.usage } : {}),
    metadata: {
      nodeId: run.provenance.nodeId,
      readOnly: run.provenance.readOnly,
      attempt: run.provenance.attempt,
      reason: run.provenance.reason,
      outcome: run.provenance.outcome,
      ...(run.provenance.reportedOutcome ? { reportedOutcome: run.provenance.reportedOutcome } : {}),
      command: run.provenance.command,
      adapter: run.provenance.adapter,
      ...(run.provenance.driver ? { driver: run.provenance.driver } : {}),
      ...(run.provenance.checkpointReused ? { checkpointReused: true } : {}),
      ...(run.provenance.checkpointValidationState ? { checkpointValidationState: run.provenance.checkpointValidationState } : {}),
      durationMs: run.provenance.durationMs,
      exitCode: run.provenance.exitCode,
      requestPath: run.provenance.requestPath,
      stdoutPath: run.provenance.stdoutPath,
      stderrPath: run.provenance.stderrPath,
      promptManifest: run.provenance.promptManifest,
      promptManifestPath: run.provenance.promptManifestPath,
      ...(run.provenance.providerThreadId ? { providerThreadId: run.provenance.providerThreadId } : {}),
      ...(run.provenance.providerTurnId ? { providerTurnId: run.provenance.providerTurnId } : {}),
      ...(run.provenance.structuredOutputPath ? { structuredOutputPath: run.provenance.structuredOutputPath } : {}),
      ...(run.structured ? { structured: run.structured } : {})
    }
  };
}

function legacyResult(runs: ContributorRun[], scouts: ContributorRun[], planner: ContributorRun, implementer: ContributorRun, critics: ContributorRun[]): AgentResult {
  const criticSummary = critics.map((run) => `${run.provenance.contributorId}: ${run.provenance.summary}`).join("; ");
  const usage = aggregateInvocationUsage(runs.map((run) => run.provenance.usage));
  return {
    summary: `${implementer.provenance.summary}${criticSummary ? ` | Critics: ${criticSummary}` : ""}`,
    ...(usage ? { usage } : {}),
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
  const scouts = await runReadOnlyBatch("scout", config.scouts, request, [], config.maximumParallel, config.handoffCharacters, config.maximumHandoffArtifacts);
  const scoutOutputs = scouts.map((run) => priorOutput(run, config.maxOutputCharacters));
  const planner = await runReadOnlySingle(config.planner, request, scoutOutputs, config.handoffCharacters, config.maximumHandoffArtifacts);
  const implementationInputs = [...scoutOutputs, priorOutput(planner, config.maxOutputCharacters)];
  const implementer = await invokeContributor(config.implementer, "implementer", false, request, implementationInputs, {
    mode: "legacy",
    nodeId: config.implementer.id,
    attempt: 1,
    instructions: INSTRUCTIONS.implementer,
    context: [],
    reason: { kind: "initial" },
    handoffCharacters: config.handoffCharacters,
    maximumHandoffArtifacts: config.maximumHandoffArtifacts
  });
  assertRunsSucceeded("implementer", [implementer]);
  const criticInputs = [...implementationInputs, priorOutput(implementer, config.maxOutputCharacters)];
  const critics = await runReadOnlyBatch("critic", config.critics, request, criticInputs, config.maximumParallel, config.handoffCharacters, config.maximumHandoffArtifacts);
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
  return node.dependsOn.every((dependency) => {
    if (conditioned.has(dependency)) return true;
    const state = states.get(dependency)!;
    if (state.config.advisory && !state.config.required && terminal(state.status)) return true;
    return state.status === "complete" && (state.config.advisory || !REJECTING_CONTROL_OUTCOMES.has(state.outcome.toLowerCase()));
  });
}

function graphInputs(node: GraphNodeConfig, states: Map<string, GraphNodeState>, maximum: number, maximumArtifacts: number): PriorOutput[] {
  const count = Math.max(1, node.dependsOn.length);
  const perInputCharacters = Math.max(1, Math.floor(maximum / count));
  const baseArtifacts = Math.floor(maximumArtifacts / count);
  let artifactRemainder = maximumArtifacts % count;
  return node.dependsOn.flatMap((dependency) => {
    const run = latestRun(states.get(dependency)!);
    const artifactAllowance = baseArtifacts + (artifactRemainder-- > 0 ? 1 : 0);
    return run ? [priorOutput(run, perInputCharacters, artifactAllowance)] : [];
  });
}

function dependsTransitively(nodeId: string, ancestorId: string, nodes: Map<string, GraphNodeConfig>, seen = new Set<string>()): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);
  const node = nodes.get(nodeId);
  if (!node) return false;
  return node.dependsOn.includes(ancestorId) || node.dependsOn.some((dependency) => dependsTransitively(dependency, ancestorId, nodes, seen));
}

function dependencyWriterIds(node: GraphNodeConfig, nodes: Map<string, GraphNodeConfig>): string[] {
  return [...nodes.values()].filter((candidate) => !candidate.readOnly && dependsTransitively(node.id, candidate.id, nodes)).map((candidate) => candidate.id).sort();
}

function nearestDependencyWriterIds(node: GraphNodeConfig, nodes: Map<string, GraphNodeConfig>): string[] {
  const writers = new Set<string>();
  const visit = (nodeId: string): void => {
    const current = nodes.get(nodeId);
    if (!current) return;
    for (const dependencyId of current.dependsOn) {
      const dependency = nodes.get(dependencyId);
      if (!dependency) continue;
      if (!dependency.readOnly) writers.add(dependency.id);
      else visit(dependency.id);
    }
  };
  visit(node.id);
  return [...writers].sort();
}

function writerInvalidationClosure(targets: Iterable<string>, nodes: Map<string, GraphNodeConfig>): Set<string> {
  const seeds = new Set(targets);
  return new Set([...nodes.values()].flatMap((node) => !node.readOnly && (
    seeds.has(node.id) || [...seeds].some((seed) => dependsTransitively(node.id, seed, nodes))
  ) ? [node.id] : []));
}

function blockerFindings(run: ContributorRun | undefined): Array<Record<string, unknown>> {
  const findings = run?.structured?.findings;
  const nested = findings && typeof findings === "object" && !Array.isArray(findings)
    ? (findings as Record<string, unknown>).blockers
    : undefined;
  const list = Array.isArray(findings) ? findings : Array.isArray(nested) ? nested : [];
  return list.filter((finding): finding is Record<string, unknown> => Boolean(
    finding && typeof finding === "object" && !Array.isArray(finding)
    && ((finding as Record<string, unknown>).findingClass === "blocker" || (finding as Record<string, unknown>).classification === "blocker")
  ));
}

function rejectionDisposition(states: GraphNodeState[]): Record<string, unknown> | undefined {
  const selected = states.find((state) => state.outcome.toLowerCase() === "spec_amendment")
    ?? states.find((state) => state.outcome.toLowerCase() === "target_revision");
  if (!selected) return undefined;
  const blockers = blockerFindings(latestRun(selected));
  const claimIds = [...new Set(blockers.flatMap((finding) => Array.isArray(finding.claimIds)
    ? finding.claimIds.filter((claim): claim is string => typeof claim === "string")
    : []))];
  const evidenceReferences = [...new Set(blockers.flatMap((finding) => Array.isArray(finding.evidence)
    ? finding.evidence.filter((reference): reference is string => typeof reference === "string" && reference.trim().length > 0)
    : []))];
  return {
    kind: selected.outcome.toLowerCase() === "spec_amendment" ? "spec-amendment" : "target-revision",
    rationale: selected.summary,
    claimIds,
    evidenceReferences
  };
}

function validateAuthorityOutput(config: GraphAgentTeamConfig, node: GraphNodeConfig, run: ContributorRun): void {
  if (!config.enforceClaimedBlockers || run.provenance.status !== "complete") return;
  if (node.authority !== "propose" && node.authority !== "approve") return;
  const controlOutcome = run.provenance.outcome.toLowerCase();
  const rejecting = REJECTING_CONTROL_OUTCOMES.has(controlOutcome);
  if (!rejecting && !POSITIVE_CONTROL_OUTCOMES.has(controlOutcome)) throw new AgentTeamOutputContractError(`${node.id} returned unknown control outcome ${run.provenance.outcome}`, [run]);
  if (!rejecting) return;
  const findings = run.structured?.findings;
  const nestedBlockers = findings && typeof findings === "object" && !Array.isArray(findings)
    ? (findings as Record<string, unknown>).blockers
    : undefined;
  const findingList = Array.isArray(findings) ? findings : Array.isArray(nestedBlockers) ? nestedBlockers : undefined;
  if (!findingList) throw new AgentTeamOutputContractError(`${node.id} returned ${run.provenance.outcome} without structured findings`, [run]);
  const blockers = findingList.filter((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const record = finding as Record<string, unknown>;
    if (record.findingClass !== undefined || record.classification !== undefined) {
      return record.findingClass === "blocker" || record.classification === "blocker";
    }
    return Array.isArray(nestedBlockers);
  }) as Array<Record<string, unknown>>;
  if (blockers.length === 0) throw new AgentTeamOutputContractError(`${node.id} returned ${run.provenance.outcome} without a blocker; new scope must be reported as an opportunity`, [run]);
  for (const [index, finding] of blockers.entries()) {
    const claimIds = finding.claimIds;
    if (!Array.isArray(claimIds) || claimIds.length === 0 || claimIds.some((claim) => typeof claim !== "string")) throw new AgentTeamOutputContractError(`${node.id} blocker ${index + 1} must cite at least one claimId`, [run]);
    const unknown = config.claimIds.length > 0 ? (claimIds as string[]).filter((claim) => !config.claimIds.includes(claim)) : [];
    if (unknown.length > 0) throw new AgentTeamOutputContractError(`${node.id} blocker ${index + 1} cites unknown claim(s): ${unknown.join(", ")}`, [run]);
  }
}

function authorityOutputInstruction(config: GraphAgentTeamConfig, node: GraphNodeConfig): string {
  if (node.authority !== "propose" && node.authority !== "approve") return `Authority: ${node.authority}. Do not exceed this authority.`;
  const claimIds = config.claimIds.length > 0
    ? config.claimIds.map((claimId) => `\`${claimId}\``).join(", ")
    : "the existing claimIds in the supplied project contract";
  return [
    `Authority: ${node.authority}. Classify every finding as blocker or opportunity. New scope is an opportunity and cannot force revision.`,
    `If outcome is rejecting (for example revise, reject, fail, or needs_work), payload.findings must be an array with at least one object shaped like { findingClass: \"blocker\", claimIds: [\"claim.id\"], issue: \"...\", evidence: [...] }.`,
    `Every blocker must cite at least one of these existing claimIds: ${claimIds}. If no existing claim is falsified, return outcome pass and report the concern as an opportunity instead. Use pass exactly; do not invent a synonym.`
  ].join(" ");
}

function delegatedHostDriverInstruction(config: GraphAgentTeamConfig, node: GraphNodeConfig): string | undefined {
  if (node.readOnly) return undefined;
  const downstreamDrivers = config.nodes.filter((candidate) => (
    candidate.adapter === "agent-driver" && candidate.dependsOn.includes(node.id)
  ));
  if (downstreamDrivers.length === 0) return undefined;
  const owners = downstreamDrivers.map((candidate) => `${candidate.id} (${candidate.driver})`).join(", ");
  return [
    `Authoritative host-driver boundary: ${owners} run after this writer and exclusively own their host-side execution and evidence verdicts.`,
    "Do not invoke or emulate those host drivers, engine licensing helpers, or provider services from the candidate sandbox.",
    "Run safe local or static checks that are available to this node, but never claim the delegated runtime evidence passed.",
    "If implementation is complete and only a delegated host check is unavailable here, return complete with that verification explicitly pending; do not return blocked or fail for the sandbox limitation. The downstream driver must fail closed if the candidate is invalid."
  ].join(" ");
}

async function runGraph(config: GraphAgentTeamConfig, request: AgentRequest): Promise<AgentResult> {
  const nodesById = new Map(config.nodes.map((node) => [node.id, node]));
  const states = new Map(config.nodes.map((node): [string, GraphNodeState] => [node.id, {
    config: node,
    status: "pending",
    outcome: "pending",
    summary: "pending",
    runs: [],
    inputGenerations: {},
    outputContractRetries: 0
  }]));
  let totalAttempts = 0;
  let repairAttempts = 0;
  let executionRetries = 0;
  let advisorEscalations = 0;
  const repairCounts = new Map<string, number>();
  const writerGenerations = new Map(config.nodes.filter((node) => !node.readOnly).map((node) => [node.id, 0]));
  const snapshotInputs = (state: GraphNodeState): Record<string, number> => Object.fromEntries(dependencyWriterIds(state.config, nodesById).map((id) => [id, writerGenerations.get(id) ?? 0]));
  const completeState = (state: GraphNodeState): void => {
    if (!state.config.readOnly) writerGenerations.set(state.config.id, (writerGenerations.get(state.config.id) ?? 0) + 1);
    state.inputGenerations = snapshotInputs(state);
    state.status = "complete";
  };
  await Promise.all(config.nodes.map((node) => ensureAgentTraceNode(request, node, node.role, node.readOnly)));
  for (const node of config.nodes) {
    for (const dependency of node.dependsOn) {
      await emitAgentTrace(request, {
        type: "edge:created",
        nodeId: `edge:${agentGraphTraceNode(request, dependency)}:${agentGraphTraceNode(request, node.id)}`,
        experimentId: request.experimentId,
        sourceNodeId: agentGraphTraceNode(request, dependency),
        targetNodeId: agentGraphTraceNode(request, node.id),
        role: "dependency"
      });
    }
  }

  const reserveAttempt = (): void => {
    if (totalAttempts >= config.maximumTotalAttempts) {
      throw new AgentTeamExecutionError(
        `agent.team graph exceeded maximumTotalAttempts (${config.maximumTotalAttempts})`,
        [...states.values()].flatMap((nodeState) => nodeState.runs)
      );
    }
    totalAttempts += 1;
  };

  const runAdvisor = async (
    state: GraphNodeState,
    triggeringRun: ContributorRun,
    reason: InvocationReason,
    extraInputs: PriorOutput[]
  ): Promise<void> => {
    const advisor = state.config.advisor;
    if (!advisor) throw new Error("agent.team internal error: advisor escalation without advisor config");
    const advisorNodeId = await ensureAgentTraceNode(request, advisor, state.config.role, state.config.readOnly);
    await emitAgentTrace(request, {
      type: "edge:created",
      nodeId: `edge:${agentGraphTraceNode(request, state.config.id)}:${advisorNodeId}`,
      experimentId: request.experimentId,
      sourceNodeId: agentGraphTraceNode(request, state.config.id),
      targetNodeId: advisorNodeId,
      role: "advisor"
    });
    await emitAgentTrace(request, {
      type: "node:progress",
      nodeId: agentGraphTraceNode(request, state.config.id),
      experimentId: request.experimentId,
      label: state.config.id,
      role: state.config.role,
      message: `Escalating ${triggeringRun.provenance.outcome} to ${advisor.id}`,
      data: journalValue({
        advisorId: advisor.id,
        triggerOutcome: triggeringRun.provenance.outcome,
        triggerStatus: triggeringRun.provenance.status,
        ...(advisor.model ? { model: advisor.model } : {}),
        ...(advisor.reasoningEffort ? { reasoningEffort: advisor.reasoningEffort } : {})
      })
    });
    const priorAdvisorRuns: PriorOutput[] = [];
    let lastOutputContractError: AgentTeamOutputContractError | undefined;
    for (let advisorAttempt = 1; advisorAttempt <= advisor.maximumAttempts; advisorAttempt += 1) {
      if (advisorEscalations >= config.maximumAdvisorEscalations) break;
      reserveAttempt();
      advisorEscalations += 1;
      const attempt = state.runs.length + 1;
      const advisorRun = await invokeContributor(advisor, state.config.role, state.config.readOnly, request, [
        ...graphInputs(state.config, states, config.handoffCharacters, config.maximumHandoffArtifacts),
        ...extraInputs,
        priorOutput(triggeringRun, config.handoffCharacters),
        ...priorAdvisorRuns
      ], {
        mode: "graph",
        nodeId: state.config.id,
        attempt,
        instructions: advisor.instructions ?? [
          `Act as the escalation advisor for ${state.config.id}.`,
          "Continue from the supplied primary attempt and preserve useful evidence instead of restarting blindly.",
          `Resolve the stated uncertainty or failure and return a decisive supported outcome. If it still cannot be resolved, return ${advisor.outcomes[0]} with the remaining gap and evidence.`
        ].join(" "),
        context: [...(state.config.inheritContext ? config.context : []), ...state.config.context],
        historyLimit: config.historyLimit,
        reason: {
          kind: "advisor",
          source: state.config.id,
          ...(reason.repairAttempt !== undefined ? { repairAttempt: reason.repairAttempt } : {})
        },
        handoffCharacters: config.handoffCharacters,
        maximumHandoffArtifacts: config.maximumHandoffArtifacts
      });
      state.runs.push(advisorRun);
      state.outcome = advisorRun.provenance.outcome;
      state.summary = advisorRun.provenance.summary;
      if (advisorRun.provenance.status === "complete" && !advisor.outcomes.includes(advisorRun.provenance.outcome)) {
        try {
          validateAuthorityOutput(config, state.config, advisorRun);
          validateRequiredOutputFields(state.config, advisorRun);
        } catch (error) {
          if (!(error instanceof AgentTeamOutputContractError)) throw error;
          lastOutputContractError = error;
          const feedback = priorOutput(advisorRun, config.handoffCharacters);
          feedback.summary = `ADVISOR OUTPUT CONTRACT REJECTED — preserve the evidence and supply the missing contract fields: ${error.message}`;
          priorAdvisorRuns.push(feedback);
          continue;
        }
        completeState(state);
        return;
      }
      priorAdvisorRuns.push(priorOutput(advisorRun, config.handoffCharacters));
    }
    if (lastOutputContractError) throw new AgentTeamOutputContractError(lastOutputContractError.message, state.runs);
    state.status = "failed";
    state.summary = `Advisor ${advisor.id} did not resolve ${state.config.id}: ${state.summary}`;
  };

  const runActivation = async (
    state: GraphNodeState,
    reason: InvocationReason,
    extraInputs: PriorOutput[] = []
  ): Promise<void> => {
    if (config.reuseCheckpoints && reason.kind === "initial" && !state.config.readOnly && state.config.writePaths.length > 0) {
      const checkpoint = await loadNodeCheckpoint(state.config, states, request, config);
      if (checkpoint) {
        state.runs.push(checkpoint.run);
        state.outcome = checkpoint.run.provenance.outcome;
        state.summary = checkpoint.run.provenance.summary;
        state.checkpointId = checkpoint.checkpointId;
        state.checkpointOutputSha256 = checkpoint.outputSha256;
        validateAuthorityOutput(config, state.config, checkpoint.run);
        validateRequiredOutputFields(state.config, checkpoint.run);
        completeState(state);
        state.reused = true;
        await emitAgentTrace(request, {
          type: "node:progress",
          nodeId: agentGraphTraceNode(request, state.config.id),
          experimentId: request.experimentId,
          label: state.config.id,
          role: state.config.role,
          status: "complete",
          message: "Reused durable writer checkpoint",
          data: { checkpointReused: true, outcome: state.outcome }
        });
        return;
      }
    }
    state.reused = false;
    delete state.checkpointId;
    delete state.checkpointOutputSha256;
    state.status = "running";
    let remainingAttempts = state.config.maximumAttempts;
    let remainingOutputContractRetries = state.config.outputContractRetries;
    let activationAttempt = 0;
    let lastOutputContractError: AgentTeamOutputContractError | undefined;
    let outputContractInputs: PriorOutput[] = [];
    let outputContractRetryPending = false;
    const retryOutputContract = async (error: AgentTeamOutputContractError, run: ContributorRun): Promise<boolean> => {
      lastOutputContractError = error;
      if (!state.config.readOnly || remainingOutputContractRetries <= 0 || executionRetries >= config.maximumExecutionRetries) return false;
      remainingOutputContractRetries -= 1;
      remainingAttempts += 1;
      state.outputContractRetries += 1;
      outputContractRetryPending = true;
      const feedback = priorOutput(run, config.handoffCharacters);
      feedback.summary = `OUTPUT CONTRACT REJECTED — preserve the evidence, but do not repeat this invalid verdict: ${error.message}`;
      outputContractInputs = [feedback];
      await emitAgentTrace(request, {
        type: "node:progress",
        nodeId: agentGraphTraceNode(request, state.config.id),
        experimentId: request.experimentId,
        label: state.config.id,
        role: state.config.role,
        status: "running",
        message: "Reviewer output contract rejected; retrying without invalidating upstream work",
        data: { outputContractRetry: state.outputContractRetries, error: error.message }
      });
      return true;
    };
    while (remainingAttempts > 0) {
      if (activationAttempt > 0 && executionRetries >= config.maximumExecutionRetries) break;
      // A bounded formatting retry repairs only the reviewer's structured output;
      // it must not consume the graph budget reserved for real creative repair.
      if (outputContractRetryPending) outputContractRetryPending = false;
      else reserveAttempt();
      if (activationAttempt > 0) executionRetries += 1;
      activationAttempt += 1;
      remainingAttempts -= 1;
      const attempt = state.runs.length + 1;
      const invocationReason: InvocationReason = activationAttempt === 1 ? reason : {
        kind: "retry",
        ...(reason.source ? { source: reason.source } : {}),
        ...(reason.repairAttempt !== undefined ? { repairAttempt: reason.repairAttempt } : {})
      };
      const hostDriverBoundary = delegatedHostDriverInstruction(config, state.config);
      const instructionLayers = [
        state.config.instructions ?? INSTRUCTIONS[state.config.role],
        hostDriverBoundary,
        authorityOutputInstruction(config, state.config)
      ].filter((layer): layer is string => typeof layer === "string" && layer.length > 0);
      const run = await invokeContributor(state.config, state.config.role, state.config.readOnly, request, [
        ...graphInputs(state.config, states, config.handoffCharacters, config.maximumHandoffArtifacts),
        ...extraInputs,
        ...outputContractInputs
      ], {
        mode: "graph",
        nodeId: state.config.id,
        attempt,
        instructions: state.config.advisor ? [
          ...instructionLayers,
          `A bounded advisor escalation is available. If you cannot produce a sufficiently supported result, return one of these escalation outcomes: ${state.config.advisor.outcomes.join(", ")}. Preserve your partial findings, evidence, assumptions, and exact remaining gap for the advisor. Use escalation only for a material capability or uncertainty gap, not ordinary difficulty.`
        ].join("\n\n") : instructionLayers.join("\n\n"),
        context: [...(state.config.inheritContext ? config.context : []), ...state.config.context],
        historyLimit: config.historyLimit,
        reason: invocationReason,
        handoffCharacters: config.handoffCharacters,
        maximumHandoffArtifacts: config.maximumHandoffArtifacts
      });
      state.runs.push(run);
      state.outcome = run.provenance.outcome;
      state.summary = run.provenance.summary;
      if (run.provenance.failureKind === "output-contract") {
        const error = new AgentTeamOutputContractError(`${state.config.id} returned malformed structured output`, [run]);
        if (await retryOutputContract(error, run)) continue;
        throw new AgentTeamOutputContractError(`${error.message} after ${state.outputContractRetries} bounded contract retr${state.outputContractRetries === 1 ? "y" : "ies"}`, state.runs);
      }
      const advisorRequested = state.config.advisor?.outcomes.includes(run.provenance.outcome) === true;
      const advisorForFailure = state.config.advisor?.onFailure === true && run.provenance.status === "failed" && !request.signal.aborted;
      if (advisorRequested || advisorForFailure) {
        await runAdvisor(state, run, reason, extraInputs);
        return;
      }
      if (run.provenance.status === "complete") {
        try {
          validateAuthorityOutput(config, state.config, run);
          validateRequiredOutputFields(state.config, run);
        } catch (error) {
          if (!(error instanceof AgentTeamOutputContractError)) throw error;
          if (await retryOutputContract(error, run)) continue;
          throw new AgentTeamOutputContractError(`${error.message} after ${state.outputContractRetries} bounded contract retr${state.outputContractRetries === 1 ? "y" : "ies"}`, state.runs);
        }
        completeState(state);
        return;
      }
    }
    if (lastOutputContractError) {
      throw new AgentTeamOutputContractError(`${lastOutputContractError.message}; retry budget exhausted`, state.runs);
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
    const trustedDrivers = readers ? batch.filter((state) => state.config.adapter === "agent-driver") : [];
    const guarded = readers ? batch.filter((state) => state.config.adapter !== "agent-driver") : batch;
    let before: string | undefined;
    let writerState: Map<string, string> | undefined;
    let writerInputState: Map<string, string> | undefined;
    let writerReadInputState: Map<string, string> | undefined;
    try {
      before = guarded.length > 0 && readers ? await gitSnapshot(request) : undefined;
      writerState = !readers && config.enforceWriteContracts ? await meaningfulFileState(request) : undefined;
      writerInputState = !readers && config.reuseCheckpoints ? await scopedContentState(request, batch[0]!.config.writePaths) : undefined;
      writerReadInputState = !readers && config.reuseCheckpoints ? await scopedContentState(request, ["**"]) : undefined;
      for (const state of trustedDrivers) {
        const allowedEvidence = [
          `.factory/runs/${request.experimentId}*/**`,
          `**/.factory/runs/${request.experimentId}*/**`,
          ...state.config.writePaths
        ];
        const driverBefore = await meaningfulFileState(request);
        await runActivation(state, reason, extras.get(state.config.id) ?? []);
        const driverAfter = await meaningfulFileState(request);
        const outside = changedSince(driverBefore, driverAfter).filter((path) => !allowedEvidence.some((pattern) => matchesPath(path, pattern)));
        if (outside.length > 0) {
          throw new AgentTeamInfrastructureError(
            `factory-native read-only driver ${state.config.driver} modified files outside its declared write paths: ${outside.join(", ")}`,
            state.runs
          );
        }
      }
      await mapParallel(guarded, readers ? config.maximumParallel : 1, (state) => runActivation(state, reason, extras.get(state.config.id) ?? []));
    } catch (error) {
      const runs = [...states.values()].flatMap((state) => state.runs);
      if (error instanceof AgentTeamInfrastructureError) throw new AgentTeamInfrastructureError(error.message, runs);
      if (error instanceof AgentTeamInvalidatedError) throw new AgentTeamInvalidatedError(error.message, runs, error.projectDisposition);
      if (error instanceof AgentTeamExecutionError) throw new AgentTeamExecutionError(error.message, runs);
      if (runs.length > 0) throw new AgentTeamExecutionError(error instanceof Error ? error.message : String(error), runs);
      throw error;
    }
    if (before !== undefined) {
      const after = await gitSnapshot(request);
      if (before !== after) {
        throw new AgentTeamInfrastructureError(
          `agent.team read-only graph nodes modified meaningful candidate files: ${batch.map((state) => state.config.id).join(", ")}`,
          batch.flatMap((state) => state.runs)
        );
      }
    }
    if (writerState) {
      const writer = batch[0]!;
      const changed = changedSince(writerState, await meaningfulFileState(request));
      const outside = changed.filter((path) => !writer.config.writePaths.some((pattern) => matchesPath(path, pattern)));
      if (outside.length > 0) {
        throw new AgentTeamInfrastructureError(
          `graph writer ${writer.config.id} modified files outside its writePaths: ${outside.join(", ")}`,
          writer.runs
        );
      }
    }
    if (!readers && config.reuseCheckpoints) {
      const writer = batch[0]!;
      const run = latestRun(writer);
      if (!writer.reused && writer.status === "complete" && run && writer.config.writePaths.length > 0) {
        const checkpoint = await saveNodeCheckpoint(writer.config, states, request, run, config, writerInputState ?? new Map(), writerReadInputState ?? new Map());
        if (checkpoint) {
          writer.checkpointId = checkpoint.checkpointId;
          writer.checkpointOutputSha256 = checkpoint.outputSha256;
        } else {
          delete writer.checkpointId;
          delete writer.checkpointOutputSha256;
        }
      }
    }
  };

  const repairNext = async (): Promise<boolean> => {
    if (repairAttempts >= config.maximumRepairAttempts) return false;
    const source = config.nodes.find((node) => {
      if (!node.repair) return false;
      if (states.get(node.id)!.status !== "complete") return false;
      const count = repairCounts.get(node.id) ?? 0;
      return count < node.repair.maximumAttempts && node.repair.outcomes.includes(states.get(node.id)!.outcome);
    });
    if (!source?.repair) return false;
    const sourceState = states.get(source.id)!;
    const sourceRun = latestRun(sourceState);
    if (!sourceRun) return false;
    const edgeAttempt = (repairCounts.get(source.id) ?? 0) + 1;
    const targetState = states.get(source.repair.target)!;
    if (config.reuseCheckpoints && targetState.checkpointId) {
      await updateNodeCheckpointValidationState(targetState.config, request, targetState.checkpointId, "invalidated", source.id);
    }
    const repairScopeBefore = source.repair.allowedPaths.length > 0 ? await meaningfulFileState(request) : undefined;
    const preserved = source.repair.preserve.flatMap((nodeId): Array<{ id: string; outcome: string; input: PriorOutput }> => {
      const preservedState = states.get(nodeId)!;
      const run = latestRun(preservedState);
      if (!run || preservedState.status !== "complete") return [];
      const input = priorOutput(run, config.handoffCharacters);
      input.summary = `FROZEN CONTRACT — preserve the previously accepted ${nodeId} outcome (${preservedState.outcome}): ${input.summary}`;
      return [{ id: nodeId, outcome: preservedState.outcome, input }];
    });
    await runBatch([targetState], { kind: "repair", source: source.id, repairAttempt: edgeAttempt }, new Map([
      [targetState.config.id, [priorOutput(sourceRun, config.handoffCharacters), ...preserved.map((item) => item.input)]]
    ]));
    if (targetState.status === "failed") {
      sourceState.status = "failed";
      sourceState.summary = `Repair target ${targetState.config.id} failed: ${targetState.summary}`;
      return true;
    }
    repairAttempts += 1;
    repairCounts.set(source.id, edgeAttempt);
    if (repairScopeBefore) {
      const changed = changedSince(repairScopeBefore, await meaningfulFileState(request));
      const outside = changed.filter((path) => !source.repair!.allowedPaths.some((pattern) => matchesPath(path, pattern)));
      if (outside.length > 0) {
        throw new AgentTeamInfrastructureError(
          `Repair from ${source.id} changed files outside its allowedPaths: ${outside.join(", ")}`,
          [...states.values()].flatMap((state) => state.runs)
        );
      }
    }

    const reviewIds = new Set([
      ...config.nodes.filter((node) => node.id !== targetState.config.id && dependsTransitively(node.id, targetState.config.id, nodesById) && states.get(node.id)!.status === "complete").map((node) => node.id),
      ...source.repair.preserve
    ]);
    const reviewers = [...reviewIds]
      .map((nodeId) => states.get(nodeId)!)
      .filter((state) => state.status === "complete");
    const reviewPending = new Set(reviewers.map((state) => state.config.id));
    while (reviewPending.size > 0) {
      const ready = reviewers.filter((state) => reviewPending.has(state.config.id)
        && state.config.dependsOn.every((dependency) => !reviewPending.has(dependency)));
      if (ready.length === 0) throw new AgentTeamExecutionError("Repair review graph could not be scheduled", [...states.values()].flatMap((state) => state.runs));
      const writers = ready.filter((state) => !state.config.readOnly);
      const selected = writers.length > 0 ? [writers[0]!] : ready;
      await runBatch(selected, { kind: "review", source: targetState.config.id, repairAttempt: edgeAttempt });
      for (const state of selected) reviewPending.delete(state.config.id);
      if (selected.some((state) => state.status === "failed")) break;
    }
    if (reviewers.some((state) => state.status === "failed")) {
      sourceState.status = "failed";
      sourceState.summary = `Repair review failed: ${reviewers.filter((state) => state.status === "failed").map((state) => state.config.id).join(", ")}`;
      return true;
    }
    const regressions = preserved.filter((contract) => states.get(contract.id)!.outcome !== contract.outcome);
    if (regressions.length > 0) {
      throw new AgentTeamExecutionError(
        `Repair from ${source.id} regressed frozen contract(s): ${regressions.map((item) => `${item.id} ${item.outcome} -> ${states.get(item.id)!.outcome}`).join(", ")}`,
        [...states.values()].flatMap((state) => state.runs)
      );
    }
    return true;
  };

  const failExhaustedRepairs = (): void => {
    for (const node of config.nodes) {
      if (!node.repair || !node.repair.outcomes.includes(states.get(node.id)!.outcome)) continue;
      const edgeExhausted = (repairCounts.get(node.id) ?? 0) >= node.repair.maximumAttempts;
      const campaignExhausted = repairAttempts >= config.maximumRepairAttempts;
      if (!edgeExhausted && !campaignExhausted) continue;
      const state = states.get(node.id)!;
      state.status = "failed";
      state.summary = `${node.id} still requested ${state.outcome} after ${repairCounts.get(node.id) ?? 0} repair attempt(s)`;
    }
  };

  const pending = new Set(config.nodes.map((node) => node.id));
  while (pending.size > 0) {
    // A critic outcome with a repair edge is a real barrier. Repair and re-review
    // it before any downstream node can consume stale or rejected work.
    if (await repairNext()) continue;
    failExhaustedRepairs();

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
      await emitAgentTrace(request, { type: "node:skipped", nodeId: agentGraphTraceNode(request, node.id), experimentId: request.experimentId, label: node.id, role: node.role, status: "skipped", message: state.summary });
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

  while (await repairNext()) { /* drain repairs triggered by the final scheduled batch */ }
  failExhaustedRepairs();

  const unresolvedRepairs = config.nodes
    .filter((node) => node.repair?.outcomes.includes(states.get(node.id)!.outcome))
    .map((node) => node.id);
  for (const state of states.values()) {
    if (!state.config.required || state.status !== "complete") continue;
    const current = snapshotInputs(state);
    const stale = Object.entries(current).filter(([writer, generation]) => state.inputGenerations[writer] !== generation);
    if (stale.length > 0) {
      state.status = "failed";
      state.summary = `${state.config.id} is stale against current writer generation(s): ${stale.map(([writer, generation]) => `${writer}@${generation}`).join(", ")}`;
    }
  }
  const requiredFailures = [...states.values()].filter((state) => state.config.required && (
    state.status === "failed"
    || (state.status === "complete" && !state.config.advisory && REJECTING_CONTROL_OUTCOMES.has(state.outcome.toLowerCase()))
    || (state.status === "skipped" && (
      conditionAllows(state.config, states)
      || state.config.dependsOn.some((dependency) => states.get(dependency)!.status === "failed")
    ))
  ));
  if (requiredFailures.length > 0) {
    const details = requiredFailures.map((state) => `${state.config.id}: ${state.summary}`).join("; ");
    const completedAndFailedRuns = [...states.values()].flatMap((state) => state.runs);
    const trustedRejections = requiredFailures.filter((state) => {
      const run = latestRun(state);
      return run?.provenance.status === "complete"
        && run.provenance.outcome === state.outcome
        && REJECTING_CONTROL_OUTCOMES.has(state.outcome.toLowerCase());
    });
    if (trustedRejections.length > 0) {
      if (config.reuseCheckpoints) {
        const causalWriters = writerInvalidationClosure(trustedRejections.flatMap((state) => {
          const explicit = state.config.invalidationTargets[state.outcome.toLowerCase()];
          return explicit ?? nearestDependencyWriterIds(state.config, nodesById);
        }), nodesById);
        for (const writerId of causalWriters) {
          const writer = states.get(writerId);
          if (writer?.checkpointId) await updateNodeCheckpointValidationState(writer.config, request, writer.checkpointId, "invalidated", trustedRejections.map((state) => state.config.id).join(","));
        }
      }
      throw new AgentTeamInvalidatedError(`agent.team candidate invalidated by trusted review: ${details}`, completedAndFailedRuns, rejectionDisposition(trustedRejections));
    }
    if (requiredFailures.some((state) => latestRun(state)?.provenance.failureKind === "infrastructure")) {
      throw new AgentTeamInfrastructureError(`agent.team graph infrastructure failed: ${details}`, completedAndFailedRuns);
    }
    throw new AgentTeamExecutionError(`agent.team graph required nodes failed: ${details}`, completedAndFailedRuns);
  }

  const runs = config.nodes.flatMap((node) => states.get(node.id)!.runs);
  const dependedOn = new Set(config.nodes.flatMap((node) => node.dependsOn));
  const sinks = config.nodes.filter((node) => !dependedOn.has(node.id) && states.get(node.id)!.status === "complete");
  const writers = config.nodes.filter((node) => !node.readOnly).flatMap((node) => states.get(node.id)!.runs);
  const finalWriter = writers.at(-1);
  const finalStructured = [...sinks].reverse().flatMap((node) => [...states.get(node.id)!.runs].reverse()).find((run) => run.structured)?.structured;
  const projectSlice = request.campaign.parameters?.projectSlice;
  const sliceRecord = projectSlice && typeof projectSlice === "object" && !Array.isArray(projectSlice) ? projectSlice as Record<string, unknown> : undefined;
  const reportedProjectEvidence = finalStructured?.projectEvidence && typeof finalStructured.projectEvidence === "object" && !Array.isArray(finalStructured.projectEvidence) ? finalStructured.projectEvidence as Record<string, unknown> : undefined;
  const projectEvidence = reportedProjectEvidence ? {
    ...reportedProjectEvidence,
    ...(typeof sliceRecord?.specRevision === "number" ? { specRevision: sliceRecord.specRevision } : {}),
    ...(typeof sliceRecord?.specFingerprint === "string" ? { specFingerprint: sliceRecord.specFingerprint } : {}),
    writerGenerations: Object.fromEntries(writerGenerations)
  } : undefined;
  const sinkSummary = sinks.map((node) => `${node.id}: ${states.get(node.id)!.summary}`).join("; ");
  const summary = [finalWriter?.provenance.summary, sinkSummary].filter(Boolean).join(" | ") || "Agent graph completed";
  const usage = aggregateInvocationUsage(runs.map((run) => run.provenance.usage));
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
    ...(usage ? { usage } : {}),
    artifacts: runs.flatMap((run) => run.artifacts),
    contributors,
    metadata: {
      pipeline: "agent.team",
      mode: "graph",
      checkpointSet: Object.fromEntries([...states.values()].flatMap((state) => !state.config.readOnly && state.checkpointId
        ? [[state.config.id, { checkpointId: state.checkpointId, outputSha256: state.checkpointOutputSha256 }]]
        : [])),
      ...(projectEvidence ? { projectEvidence } : {}),
      ...(finalStructured?.projectDisposition && typeof finalStructured.projectDisposition === "object" && !Array.isArray(finalStructured.projectDisposition) ? { projectDisposition: finalStructured.projectDisposition } : {}),
      maximumParallel: config.maximumParallel,
      totalAttempts,
      repairAttempts,
      executionRetries,
      advisorEscalations,
      writerGenerations: Object.fromEntries(writerGenerations),
      unresolvedRepairs,
      nodes: Object.fromEntries(config.nodes.map((node) => {
        const state = states.get(node.id)!;
        return [node.id, {
          role: node.role,
          readOnly: node.readOnly,
          ...(node.writePaths.length > 0 ? { writePaths: node.writePaths } : {}),
          authority: node.authority,
          advisory: node.advisory,
          dependsOn: node.dependsOn,
          status: state.status,
          outcome: state.outcome,
          ...(state.reused ? { checkpointReused: true } : {}),
          attempts: state.runs.length,
          outputContractRetries: state.outputContractRetries,
          advisorInvocations: state.runs.filter((run) => run.provenance.reason.kind === "advisor").length,
          inputGenerations: state.inputGenerations,
          skills: node.skills.map((skill) => skill.name),
          summary: state.summary
        }];
      }))
    }
  };
}

export class AgentTeam implements AgentDriver {
  readonly id = "agent.team";

  constructor(private readonly resolveAgent?: (id: string) => AgentDriver) {}

  async finalize(request: AgentRequest & { result: AgentResult; evaluations: import("@gamefactory/core").Evaluation[]; accepted: boolean; reason: string }): Promise<void> {
    const config = readConfig(request);
    if (config.kind !== "graph" || !config.reuseCheckpoints) return;
    const rawSet = request.result.metadata?.checkpointSet;
    if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet)) return;
    const checkpointSet = rawSet as Record<string, unknown>;
    const writers = new Map(config.nodes.filter((node) => !node.readOnly).map((node) => [node.id, node]));
    const nodes = new Map(config.nodes.map((node) => [node.id, node]));
    const failedEvaluations = request.evaluations.filter((evaluation) => evaluation.status !== "pass");
    const mappedSeeds = new Set<string>();
    let mappingsComplete = failedEvaluations.length > 0;
    for (const evaluation of failedEvaluations) {
      const violations = evaluation.violations.filter((violation) => violation.severity === "error");
      const causes = violations.length > 0 ? violations : [{ code: "<evaluation>", severity: "error" as const, message: evaluation.summary ?? evaluation.evaluator }];
      for (const violation of causes) {
        const attributed = violation.causalNodeIds?.filter((nodeId) => writers.has(nodeId)) ?? [];
        const exactKey = `${evaluation.evaluator}#${violation.code}`;
        const configured = attributed.length > 0
          ? attributed
          : config.externalInvalidationTargets[exactKey] ?? config.externalInvalidationTargets[evaluation.evaluator];
        if (!configured) mappingsComplete = false;
        else for (const nodeId of configured) mappedSeeds.add(nodeId);
      }
    }
    const causalSeeds = request.accepted
      ? new Set<string>()
      : mappingsComplete
        ? mappedSeeds
        : new Set(writers.keys());
    const causalTargets = writerInvalidationClosure(causalSeeds, nodes);
    for (const [nodeId, raw] of Object.entries(checkpointSet)) {
      const node = writers.get(nodeId);
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
      if (!node || typeof entry?.checkpointId !== "string") continue;
      const validationState = request.accepted || !causalTargets.has(nodeId) ? "accepted" : "invalidated";
      await updateNodeCheckpointValidationState(node, request, entry.checkpointId, validationState, `workflow:${request.reason}`);
    }
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const releaseAppServerSession = await codexAppServers.beginSession();
    try {
      const nodeId = teamTraceNode(request);
      await emitAgentTrace(request, { type: "node:created", nodeId, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: "Agent team", role: "agent-team" });
      await emitAgentTrace(request, { type: "edge:created", nodeId: `edge:experiment:${request.experimentId}:${nodeId}`, experimentId: request.experimentId, sourceNodeId: `experiment:${request.experimentId}`, targetNodeId: nodeId, role: "agent" });
      if (this.resolveAgent) agentDriverResolvers.set(request, this.resolveAgent);
      return await serializeCandidate(request.candidate.root, async () => {
        await emitAgentTrace(request, { type: "node:started", nodeId, experimentId: request.experimentId, label: "Agent team", role: "agent-team" });
        try {
          let config: AgentTeamConfig;
          try {
            config = readConfig(request);
            await preflightSkills(config);
            preflightDriverWriteContracts(config, request);
          } catch (error) {
            if (error instanceof AgentTeamInfrastructureError) throw error;
            throw new AgentTeamInfrastructureError(`agent.team preflight failed: ${error instanceof Error ? error.message : String(error)}`, []);
          }
          const result = config.kind === "legacy" ? await runLegacy(config, request) : await runGraph(config, request);
          for (const contributor of result.contributors ?? []) {
            await emitAgentTrace(request, {
              type: contributor.status === "failed" ? "node:failed" : contributor.status === "skipped" ? "node:skipped" : "node:completed",
              nodeId: agentGraphTraceNode(request, contributor.agentId),
              experimentId: request.experimentId,
              label: contributor.agentId,
              role: contributor.role,
              status: contributor.status,
              message: contributor.summary,
              data: { ...(contributor.invocationId ? { invocationId: contributor.invocationId } : {}), ...(contributor.parentInvocationId ? { parentInvocationId: contributor.parentInvocationId } : {}), ...(contributor.usage ? { usage: { ...contributor.usage } } : {}) }
            });
          }
          await emitAgentTrace(request, { type: "node:completed", nodeId, experimentId: request.experimentId, label: "Agent team", role: "agent-team", status: "complete", message: result.summary, data: { contributors: result.contributors?.length ?? 0, artifacts: result.artifacts?.length ?? 0, ...(result.usage ? { usage: { ...result.usage } } : {}) } });
          return result;
        } catch (error) {
          await emitAgentTrace(request, { type: "node:failed", nodeId, experimentId: request.experimentId, label: "Agent team", role: "agent-team", status: "failed", message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
    } finally {
      agentDriverResolvers.delete(request);
      await releaseAppServerSession();
    }
  }
}

export default defineExtension((api) => {
  const registration = api.register("agent", "agent.team", new AgentTeam((id) => api.get<AgentDriver>("agent", id)));
  return {
    async dispose() {
      await registration.dispose();
      await codexAppServers.dispose();
    }
  };
});
