import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseInvocationUsage, type AgentDriver, type AgentResult, type ArtifactReference, type EffectivePromptManifest, type FactoryTraceEventInput, type InvocationUsage, type JournalJsonValue, type PromptLayer, type UsageBillingMode } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMPATIBILITY_ENVIRONMENT = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR"
] as const;

type AgentRequest = Parameters<AgentDriver["run"]>[0];
export type CommandAgentFailureCode = "nonzero-exit" | "timeout" | "output-limit" | "spawn-error" | "cancelled";

export interface CommandAgentFailureProvenance {
  code: CommandAgentFailureCode;
  command: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  timeoutSeconds: number;
  maximumOutputBytes: number;
  capturedOutputBytes: number;
  evidenceDirectory: string;
}

export class CommandAgentExecutionError extends Error {
  readonly name = "CommandAgentExecutionError";

  constructor(
    message: string,
    readonly provenance: CommandAgentFailureProvenance,
    readonly artifacts: ArtifactReference[],
    options: { cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }

  get code(): CommandAgentFailureCode {
    return this.provenance.code;
  }
}

interface CommandAgentSettings {
  timeoutSeconds: number;
  maximumOutputBytes: number;
  environmentAllowlist: string[];
  environment: Record<string, string>;
  evidenceDirectory?: string;
  provider?: string;
  model?: string;
  billingMode?: UsageBillingMode;
}

interface ProcessOutcome {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  capturedOutputBytes: number;
  failureCode?: Exclude<CommandAgentFailureCode, "nonzero-exit">;
  spawnError?: Error;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function commandFor(request: AgentRequest): string[] {
  const configured = request.campaign.parameters?.agentCommand;
  if (!Array.isArray(configured) || configured.length === 0 || !configured.every((item) => typeof item === "string")) {
    throw new Error("parameters.agentCommand must be a non-empty string array");
  }
  const replacements: Record<string, string> = {
    "{candidate}": request.candidate.root,
    "{experiment}": request.experimentId,
    "{objective}": request.campaign.objective
  };
  return configured.map((part) => Object.entries(replacements).reduce((value, [token, replacement]) => value.replaceAll(token, replacement), part));
}

function agentInstructions(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function layer(id: string, kind: PromptLayer["kind"], source: string, content: string): PromptLayer {
  return { id, kind, source, sha256: hash(content), content: content.length <= 30_000 ? content : `${content.slice(0, 30_000)}\n\n[truncated in trace]` };
}

async function projectInstructions(candidateRoot: string): Promise<{ sources: string[]; layers: PromptLayer[] }> {
  const files: Array<{ path: string; content: string }> = [];
  let current = resolve(candidateRoot);
  for (;;) {
    const path = resolve(current, "AGENTS.md");
    try { files.push({ path, content: await readFile(path, "utf8") }); } catch { /* optional */ }
    const repositoryRoot = await lstat(resolve(current, ".git")).then(() => true, () => false);
    const parent = dirname(current);
    if (repositoryRoot || parent === current) break;
    current = parent;
  }
  files.reverse();
  return { sources: files.map((file) => file.path), layers: files.map((file, index) => layer(`project-${index + 1}`, "project", file.path, file.content)) };
}

async function promptManifest(request: AgentRequest, settings: CommandAgentSettings): Promise<EffectivePromptManifest> {
  const project = await projectInstructions(request.candidate.root);
  const instructions = agentInstructions(request.campaign.parameters?.agentInstructions);
  const boundaries = JSON.stringify({ mutablePaths: request.campaign.mutablePaths ?? [], immutablePaths: request.campaign.immutablePaths ?? [] }, null, 2);
  const designIntent = request.campaign.parameters?.design && typeof request.campaign.parameters.design === "object"
    ? (request.campaign.parameters.design as Record<string, unknown>).intent
    : undefined;
  return {
    version: 1,
    scope: "factory-supplied",
    generatedAt: new Date().toISOString(),
    adapter: "configured-command",
    ...(settings.provider ? { provider: settings.provider } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.billingMode ? { billingMode: settings.billingMode } : {}),
    instructionSources: project.sources,
    layers: [
      ...project.layers,
      layer("campaign-objective", "campaign", "campaign.objective", request.campaign.objective),
      layer("campaign-boundaries", "boundary", "campaign.mutablePaths+immutablePaths", boundaries),
      ...(instructions.length ? [layer("agent-instructions", "task", "campaign.parameters.agentInstructions", instructions.join("\n\n"))] : []),
      ...(designIntent !== undefined ? [layer("design-intent", "context", "campaign.parameters.design.intent", JSON.stringify(designIntent, null, 2))] : []),
      ...(request.history.length ? [layer("experiment-history", "history", "campaign.history", JSON.stringify(request.history.map((item) => ({ id: item.experimentId, status: item.status, summary: item.summary, metrics: item.metrics })), null, 2))] : [])
    ],
    context: { objective: request.campaign.objective, role: "worker", contributorId: "command.agent", experimentId: request.experimentId, candidateRoot: request.candidate.root, readOnly: false, upstreamOutputs: 0, contextReferences: designIntent === undefined ? 0 : 1, historyRecords: request.history.length },
    limitations: ["This manifest records GameFactory-supplied layers; the configured command may add provider instructions that it does not report."]
  };
}

function traceValue(value: unknown): JournalJsonValue {
  return JSON.parse(JSON.stringify(value)) as JournalJsonValue;
}

function settingsFor(request: AgentRequest): CommandAgentSettings {
  const configured = object(request.campaign.parameters?.commandAgent);
  const timeoutSeconds = configured.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
    throw new Error("parameters.commandAgent.timeoutSeconds must be a positive number no greater than 86400");
  }
  const maximumOutputBytes = configured.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  if (typeof maximumOutputBytes !== "number" || !Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1 || maximumOutputBytes > 64 * 1024 * 1024) {
    throw new Error("parameters.commandAgent.maximumOutputBytes must be an integer from 1 to 67108864");
  }
  const environmentAllowlist = configured.environmentAllowlist ?? [];
  if (!Array.isArray(environmentAllowlist) || environmentAllowlist.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("parameters.commandAgent.environmentAllowlist must contain valid environment variable names");
  }
  const rawEnvironment = configured.environment ?? {};
  if (!rawEnvironment || typeof rawEnvironment !== "object" || Array.isArray(rawEnvironment)) {
    throw new Error("parameters.commandAgent.environment must be an object of string values");
  }
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new Error("parameters.commandAgent.environment must be an object of string values with valid variable names");
    }
    if (name.toUpperCase().startsWith("GAMEFACTORY_")) {
      throw new Error(`parameters.commandAgent.environment cannot override reserved variable ${name}`);
    }
    environment[name] = value;
  }
  if (configured.evidenceDirectory !== undefined && (typeof configured.evidenceDirectory !== "string" || configured.evidenceDirectory.trim().length === 0)) {
    throw new Error("parameters.commandAgent.evidenceDirectory must be a non-empty string");
  }
  for (const field of ["provider", "model"] as const) {
    if (configured[field] !== undefined && (typeof configured[field] !== "string" || configured[field].trim().length === 0 || configured[field].length > 256)) {
      throw new Error(`parameters.commandAgent.${field} must be a non-empty string with at most 256 characters`);
    }
  }
  if (configured.billingMode !== undefined && !["subscription", "credits", "metered", "unknown"].includes(String(configured.billingMode))) {
    throw new Error("parameters.commandAgent.billingMode must be subscription, credits, metered, or unknown");
  }
  return {
    timeoutSeconds,
    maximumOutputBytes,
    environmentAllowlist: environmentAllowlist as string[],
    environment,
    ...(typeof configured.evidenceDirectory === "string" ? { evidenceDirectory: configured.evidenceDirectory } : {}),
    ...(typeof configured.provider === "string" ? { provider: configured.provider.trim() } : {}),
    ...(typeof configured.model === "string" ? { model: configured.model.trim() } : {}),
    ...(typeof configured.billingMode === "string" ? { billingMode: configured.billingMode as UsageBillingMode } : {})
  };
}

async function emitCommandTrace(request: AgentRequest, event: FactoryTraceEventInput): Promise<void> {
  try {
    await request.trace?.emit(event);
  } catch {
    // Usage telemetry is observational and cannot change the agent outcome.
  }
}

function commandOutputMetadata(stdout: string, settings: CommandAgentSettings): { summary?: string; usage?: InvocationUsage } {
  const defaults = {
    ...(settings.provider ? { provider: settings.provider } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.billingMode ? { billingMode: settings.billingMode } : {}),
    ...(settings.provider || settings.model ? { identitySource: "configured" as const } : {})
  };
  let record: Record<string, unknown> | undefined;
  for (const value of [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()]) {
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // Ordinary command output is expected to be non-JSON.
    }
  }
  let usage = parseInvocationUsage(undefined, defaults);
  try {
    usage = parseInvocationUsage(record?.usage, defaults);
  } catch {
    // Malformed usage metadata is omitted rather than failing completed work.
  }
  return {
    ...(typeof record?.summary === "string" ? { summary: record.summary } : {}),
    ...(usage ? { usage } : {})
  };
}

function inheritedEnvironmentValue(name: string): { name: string; value: string } | undefined {
  const entry = Object.entries(process.env).find(([candidate]) => process.platform === "win32"
    ? candidate.toLowerCase() === name.toLowerCase()
    : candidate === name);
  return entry?.[1] === undefined ? undefined : { name: entry[0], value: entry[1] };
}

function childEnvironment(settings: CommandAgentSettings, requestPath: string, candidateRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of new Set<string>([...COMPATIBILITY_ENVIRONMENT, ...settings.environmentAllowlist])) {
    const inherited = inheritedEnvironmentValue(name);
    if (inherited) environment[inherited.name] = inherited.value;
  }
  Object.assign(environment, settings.environment);
  environment.GAMEFACTORY_REQUEST = requestPath;
  environment.GAMEFACTORY_CANDIDATE = candidateRoot;
  return environment;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 500);
    force.unref();
    child.once("close", () => clearTimeout(force));
    killer.once("error", () => { child.kill(); });
    killer.once("close", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 500);
  force.unref();
}

function execute(
  executable: string,
  args: string[],
  request: AgentRequest,
  requestPath: string,
  settings: CommandAgentSettings
): Promise<ProcessOutcome> {
  if (request.signal.aborted) {
    return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), capturedOutputBytes: 0, failureCode: "cancelled" });
  }
  return new Promise((resolveResult) => {
    let settled = false;
    let capturedOutputBytes = 0;
    let failureCode: ProcessOutcome["failureCode"];
    let stopping = false;
    let spawnError: Error | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, args, {
      cwd: request.candidate.root,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: childEnvironment(settings, requestPath, request.candidate.root)
    });

    const stop = (reason: NonNullable<ProcessOutcome["failureCode"]>): void => {
      if (stopping) return;
      stopping = true;
      failureCode = reason;
      terminateProcessTree(child);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = settings.maximumOutputBytes - capturedOutputBytes;
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(Buffer.from(kept));
        capturedOutputBytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) stop("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => { capture(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { capture(stderr, chunk); });

    const timeout = setTimeout(() => stop("timeout"), settings.timeoutSeconds * 1000);
    timeout.unref();
    const abort = () => stop("cancelled");
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      resolveResult({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        capturedOutputBytes,
        ...(failureCode ? { failureCode } : {}),
        ...(spawnError ? { spawnError } : {})
      });
    };
    child.once("error", (error) => {
      spawnError = error;
      failureCode = "spawn-error";
      finish(null);
    });
    child.once("close", finish);
  });
}

function isWithin(root: string, path: string): boolean {
  const traversal = relative(resolve(root), resolve(path));
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function safeSegment(value: string): string {
  const result = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return result.slice(0, 100) || "unnamed";
}

function preferredEvidenceBase(request: AgentRequest, settings: CommandAgentSettings): string {
  const configured = settings.evidenceDirectory
    ? resolve(request.campaign.projectRoot, settings.evidenceDirectory)
    : resolve(request.campaign.projectRoot, ".factory", "agent-evidence");
  return isWithin(request.candidate.root, configured)
    ? resolve(tmpdir(), "gamefactory-agent-evidence")
    : configured;
}

function evidenceArtifacts(directory: string, metadata: Record<string, unknown>): ArtifactReference[] {
  return [
    { kind: "log", path: resolve(directory, "stdout.log"), mediaType: "text/plain", label: "Failed agent stdout", metadata },
    { kind: "log", path: resolve(directory, "stderr.log"), mediaType: "text/plain", label: "Failed agent stderr", metadata },
    { kind: "other", path: resolve(directory, "request.json"), mediaType: "application/json", label: "Failed agent request", metadata }
  ];
}

async function retainFailureEvidence(
  request: AgentRequest,
  settings: CommandAgentSettings,
  requestContent: string,
  outcome: ProcessOutcome,
  metadata: Record<string, unknown>
): Promise<{ directory: string; artifacts: ArtifactReference[] }> {
  const run = `${Date.now()}-${randomUUID()}`;
  const relativeDirectory = join(safeSegment(request.campaign.id), safeSegment(request.experimentId), run);
  const preferred = resolve(preferredEvidenceBase(request, settings), relativeDirectory);
  const fallback = resolve(tmpdir(), "gamefactory-agent-evidence", relativeDirectory);
  let firstError: unknown;
  for (const directory of preferred === fallback ? [preferred] : [preferred, fallback]) {
    try {
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(resolve(directory, "request.json"), requestContent, "utf8"),
        writeFile(resolve(directory, "stdout.log"), outcome.stdout),
        writeFile(resolve(directory, "stderr.log"), outcome.stderr)
      ]);
      return { directory, artifacts: evidenceArtifacts(directory, metadata) };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw new Error("Unable to retain failed command-agent evidence outside the candidate.", { cause: firstError });
}

function failureMessage(code: CommandAgentFailureCode, outcome: ProcessOutcome, evidenceDirectory: string): string {
  const detail = outcome.stderr.toString("utf8").trim().slice(-1000);
  const reason = code === "nonzero-exit"
    ? `exited ${String(outcome.code)}`
    : code === "timeout"
      ? "timed out"
      : code === "output-limit"
        ? "exceeded its output byte limit"
        : code === "cancelled"
          ? "was cancelled"
          : `could not start${outcome.spawnError ? `: ${outcome.spawnError.message}` : ""}`;
  return `Agent command ${reason}. Evidence retained at ${evidenceDirectory}.${detail ? ` ${detail}` : ""}`;
}

export class CommandAgent implements AgentDriver {
  readonly id = "command.agent";

  async run(request: AgentRequest): Promise<AgentResult> {
    const command = commandFor(request);
    const [executable, ...args] = command;
    if (!executable) throw new Error("Agent command has no executable");
    const settings = settingsFor(request);
    const effectivePrompt = await promptManifest(request, settings);
    const traceNodeId = `agent:${request.experimentId}:command.agent:attempt-1`;
    const traceData = { invocationId: traceNodeId, parentInvocationId: `experiment:${request.experimentId}`, promptManifest: effectivePrompt, ...(settings.provider ? { provider: settings.provider } : {}), ...(settings.model ? { model: settings.model } : {}), ...(settings.billingMode ? { billingMode: settings.billingMode } : {}), ...(settings.provider || settings.model ? { identitySource: "configured" as const } : {}) };
    await emitCommandTrace(request, { type: "node:created", nodeId: traceNodeId, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: this.id, role: "worker", attempt: 1, data: traceValue(traceData) });
    await emitCommandTrace(request, { type: "edge:created", nodeId: `edge:experiment:${request.experimentId}:${traceNodeId}`, experimentId: request.experimentId, sourceNodeId: `experiment:${request.experimentId}`, targetNodeId: traceNodeId, role: "agent" });
    await emitCommandTrace(request, { type: "node:started", nodeId: traceNodeId, experimentId: request.experimentId, label: this.id, role: "worker", attempt: 1, data: traceValue(traceData) });
    const prompt = {
      objective: request.campaign.objective,
      experimentId: request.experimentId,
      candidateRoot: request.candidate.root,
      candidateMetadata: request.candidate.metadata,
      mutablePaths: request.campaign.mutablePaths ?? [],
      immutablePaths: request.campaign.immutablePaths ?? [],
      instructions: agentInstructions(request.campaign.parameters?.agentInstructions),
      designIntent: request.campaign.parameters?.design && typeof request.campaign.parameters.design === "object"
        ? (request.campaign.parameters.design as Record<string, unknown>).intent
        : undefined,
      history: request.history.map((item) => ({ id: item.experimentId, status: item.status, summary: item.summary, metrics: item.metrics })),
      effectivePrompt
    };
    const outputDirectory = resolve(request.candidate.root, ".factory", "agent", request.experimentId);
    await mkdir(outputDirectory, { recursive: true });
    const requestPath = resolve(outputDirectory, "request.json");
    const promptManifestPath = resolve(outputDirectory, "prompt-manifest.json");
    const stdoutPath = resolve(outputDirectory, "stdout.log");
    const stderrPath = resolve(outputDirectory, "stderr.log");
    const requestContent = `${JSON.stringify(prompt, null, 2)}\n`;
    await Promise.all([
      writeFile(requestPath, requestContent, "utf8"),
      writeFile(promptManifestPath, `${JSON.stringify(effectivePrompt, null, 2)}\n`, "utf8")
    ]);

    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const outcome = await execute(executable, args, request, requestPath, settings);
    const finished = Date.now();
    const failureCode: CommandAgentFailureCode | undefined = outcome.failureCode ?? (outcome.code === 0 ? undefined : "nonzero-exit");
    if (failureCode) {
      const metadata = {
        failureCode,
        exitCode: outcome.code,
        timeoutSeconds: settings.timeoutSeconds,
        maximumOutputBytes: settings.maximumOutputBytes,
        capturedOutputBytes: outcome.capturedOutputBytes
      };
      const retained = await retainFailureEvidence(request, settings, requestContent, outcome, metadata);
      const provenance: CommandAgentFailureProvenance = {
        code: failureCode,
        command,
        cwd: request.candidate.root,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        exitCode: outcome.code,
        timeoutSeconds: settings.timeoutSeconds,
        maximumOutputBytes: settings.maximumOutputBytes,
        capturedOutputBytes: outcome.capturedOutputBytes,
        evidenceDirectory: retained.directory
      };
      await emitCommandTrace(request, { type: "node:failed", nodeId: traceNodeId, experimentId: request.experimentId, label: this.id, role: "worker", attempt: 1, status: failureCode, message: failureMessage(failureCode, outcome, retained.directory), data: traceValue({ ...traceData, durationMs: finished - started, capturedOutputBytes: outcome.capturedOutputBytes }) });
      throw new CommandAgentExecutionError(
        failureMessage(failureCode, outcome, retained.directory),
        provenance,
        retained.artifacts,
        outcome.spawnError ? { cause: outcome.spawnError } : {}
      );
    }

    await Promise.all([writeFile(stdoutPath, outcome.stdout), writeFile(stderrPath, outcome.stderr)]);
    const stdout = outcome.stdout.toString("utf8");
    const metadata = commandOutputMetadata(stdout, settings);
    const summary = metadata.summary ?? (stdout.trim().split(/\r?\n/).at(-1) || `Agent command completed experiment ${request.experimentId}.`);
    const artifacts: ArtifactReference[] = [
      { kind: "log", path: stdoutPath, mediaType: "text/plain", label: "Agent stdout" },
      { kind: "log", path: stderrPath, mediaType: "text/plain", label: "Agent stderr" },
      { kind: "other", path: requestPath, mediaType: "application/json", label: "Agent request" },
      { kind: "other", path: promptManifestPath, mediaType: "application/json", label: "Agent effective prompt manifest", metadata: { promptManifestVersion: 1 } }
    ];
    await emitCommandTrace(request, { type: "node:completed", nodeId: traceNodeId, experimentId: request.experimentId, label: this.id, role: "worker", attempt: 1, status: "complete", message: summary, data: traceValue({ ...traceData, durationMs: finished - started, ...(metadata.usage ? { usage: { ...metadata.usage } } : {}) }) });
    return {
      summary,
      artifacts,
      ...(metadata.usage ? { usage: metadata.usage } : {}),
      contributors: [{
        agentId: this.id,
        role: "worker",
        status: "complete",
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        summary,
        artifacts: [],
        invocationId: traceNodeId,
        parentInvocationId: `experiment:${request.experimentId}`,
        ...(metadata.usage ? { usage: metadata.usage } : {}),
        metadata: { promptManifest: effectivePrompt, promptManifestPath }
      }]
    };
  }
}

export default defineExtension((api) => api.register("agent", "command.agent", new CommandAgent()));
