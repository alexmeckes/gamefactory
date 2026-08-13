import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentContribution,
  AgentDriver,
  AgentRequest,
  AgentResult,
  ArtifactReference,
  DoctorResult,
  EngineDriver,
  FactoryTraceEventInput
} from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

const API_VERSION = "gamefactory.sam3/v1" as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WORKER_PATH = fileURLToPath(new URL("../python/segment.py", import.meta.url));

interface Sam3Config {
  requestPath: string;
  command: string[];
  doctorCommand: string[];
  model: string;
  device: string;
  checkpointPath?: string;
  timeoutSeconds: number;
  maxOutputCharacters: number;
  environmentAllowlist: string[];
}

interface Sam3Job {
  id: string;
  sourcePath: string;
  prompt: string;
  outputDirectory: string;
  threshold: number;
  maxInstances: number;
  cropPaddingPixels: number;
  maskExpandPixels: number;
  maskFeatherPixels: number;
}

interface Sam3Request {
  apiVersion: typeof API_VERSION;
  jobs: Sam3Job[];
}

interface ProviderInstance {
  index: number;
  score: number;
  bbox: [number, number, number, number];
  maskPath: string;
  cutoutPath: string;
}

interface ProviderJob {
  id: string;
  prompt: string;
  instances: ProviderInstance[];
}

interface ProviderResult {
  provider: string;
  model: string;
  checkpoint: string;
  jobs: ProviderJob[];
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: "timeout" | "cancelled" | "output-limit" | "spawn-error";
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string with at most ${maximum} characters`);
  }
  return value.trim();
}

function number(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return result;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = number(value, fallback, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function command(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return [...value];
}

function config(campaign: AgentRequest["campaign"]): Sam3Config {
  const raw = campaign.parameters?.sam3;
  const value = raw === undefined ? {} : object(raw, "parameters.sam3");
  const baseCommand = command(value.command, ["python", "{worker}"], "parameters.sam3.command");
  const environmentAllowlist = value.environmentAllowlist === undefined
    ? ["HF_TOKEN", "HF_HOME", "CUDA_VISIBLE_DEVICES"]
    : Array.isArray(value.environmentAllowlist)
      && value.environmentAllowlist.length <= 32
      && value.environmentAllowlist.every((item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item))
      ? [...new Set(value.environmentAllowlist as string[])]
      : (() => { throw new Error("parameters.sam3.environmentAllowlist must contain at most 32 environment variable names"); })();
  return {
    requestPath: string(value.requestPath ?? "sam3.request.json", "parameters.sam3.requestPath"),
    command: baseCommand,
    doctorCommand: command(value.doctorCommand, [...baseCommand, "--doctor"], "parameters.sam3.doctorCommand"),
    model: string(value.model ?? "sam3", "parameters.sam3.model", 256),
    device: string(value.device ?? "cuda", "parameters.sam3.device", 64),
    ...(typeof value.checkpointPath === "string" && value.checkpointPath.length > 0 ? { checkpointPath: value.checkpointPath } : {}),
    timeoutSeconds: integer(value.timeoutSeconds, 900, 1, 86_400, "parameters.sam3.timeoutSeconds"),
    maxOutputCharacters: integer(value.maxOutputCharacters, 30_000, 1_000, 10_000_000, "parameters.sam3.maxOutputCharacters"),
    environmentAllowlist
  };
}

function containedPath(root: string, projectPath: string, label: string): string {
  if (projectPath.includes("\0") || isAbsolute(projectPath)) throw new Error(`${label} must be a relative candidate path`);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, projectPath);
  const traversal = relative(absoluteRoot, target);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) {
    throw new Error(`${label} must stay below the candidate root`);
  }
  return target;
}

async function canonicalContained(root: string, target: string, label: string): Promise<string> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  const traversal = relative(canonicalRoot, canonicalTarget);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) {
    throw new Error(`${label} resolves outside the candidate root`);
  }
  return canonicalTarget;
}

function parseRequest(value: unknown): Sam3Request {
  const record = object(value, "SAM 3 request");
  if (record.apiVersion !== API_VERSION) throw new Error(`SAM 3 request apiVersion must be ${API_VERSION}`);
  if (!Array.isArray(record.jobs) || record.jobs.length === 0 || record.jobs.length > 64) {
    throw new Error("SAM 3 request jobs must contain from 1 to 64 jobs");
  }
  const ids = new Set<string>();
  const jobs = record.jobs.map((rawJob, index): Sam3Job => {
    const job = object(rawJob, `SAM 3 request jobs[${index}]`);
    const id = string(job.id, `SAM 3 request jobs[${index}].id`, 64);
    if (!ID_PATTERN.test(id)) throw new Error(`SAM 3 request jobs[${index}].id contains unsupported characters`);
    if (ids.has(id)) throw new Error(`SAM 3 request contains duplicate job id ${id}`);
    ids.add(id);
    return {
      id,
      sourcePath: string(job.sourcePath, `SAM 3 request jobs[${index}].sourcePath`),
      prompt: string(job.prompt, `SAM 3 request jobs[${index}].prompt`, 512),
      outputDirectory: string(job.outputDirectory, `SAM 3 request jobs[${index}].outputDirectory`),
      threshold: number(job.threshold, 0.5, 0, 1, `SAM 3 request jobs[${index}].threshold`),
      maxInstances: integer(job.maxInstances, 16, 1, 128, `SAM 3 request jobs[${index}].maxInstances`),
      cropPaddingPixels: integer(job.cropPaddingPixels, 0, 0, 4096, `SAM 3 request jobs[${index}].cropPaddingPixels`),
      maskExpandPixels: integer(job.maskExpandPixels, 0, -64, 64, `SAM 3 request jobs[${index}].maskExpandPixels`),
      maskFeatherPixels: number(job.maskFeatherPixels, 0, 0, 64, `SAM 3 request jobs[${index}].maskFeatherPixels`)
    };
  });
  const maximumOutputs = jobs.reduce((sum, job) => sum + job.maxInstances, 0);
  if (maximumOutputs > 512) throw new Error("SAM 3 request may declare at most 512 total instances across all jobs");
  return { apiVersion: API_VERSION, jobs };
}

function renderCommand(parts: string[]): string[] {
  return parts.map((part) => part.replaceAll("{worker}", WORKER_PATH));
}

function childEnvironment(allowlist: string[], additions: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [...inherited, ...allowlist]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...additions };
}

function terminateTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { try { child.kill("SIGKILL"); } catch { /* already stopped */ } });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already stopped */ } }
  }
}

function execute(
  parts: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutSeconds: number,
  maximumCharacters: number,
  environment: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const [executable, ...args] = parts;
    if (!executable) {
      resolveResult({ code: null, stdout: "", stderr: "SAM 3 command has no executable", failure: "spawn-error" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let failure: ProcessResult["failure"];
    let stopping = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const stop = (reason: NonNullable<ProcessResult["failure"]>) => {
      if (stopping) return;
      stopping = true;
      failure = reason;
      terminateTree(child);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
    const abort = () => stop("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (stopping) return;
      const text = String(chunk);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maximumCharacters) {
        const remaining = Math.max(0, maximumCharacters - (stream === "stdout" ? stderr.length : stdout.length));
        if (stream === "stdout") stdout = stdout.slice(0, remaining);
        else stderr = stderr.slice(0, remaining);
        stop("output-limit");
      }
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveResult({ code: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`, failure: failure ?? "spawn-error" });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveResult({ code, stdout, stderr, ...(failure ? { failure } : {}) });
    });
  });
}

function artifact(path: string, kind: ArtifactReference["kind"], label: string, mediaType: string, metadata?: Record<string, unknown>): ArtifactReference {
  return { kind, path, label, mediaType, ...(metadata ? { metadata } : {}) };
}

async function emit(request: AgentRequest, event: FactoryTraceEventInput): Promise<void> {
  try { await request.trace?.emit(event); } catch { /* tracing remains observational */ }
}

function parseProviderResult(value: unknown): ProviderResult {
  const record = object(value, "SAM 3 provider result");
  if (!Array.isArray(record.jobs)) throw new Error("SAM 3 provider result jobs must be an array");
  const jobs = record.jobs.map((rawJob, jobIndex): ProviderJob => {
    const job = object(rawJob, `SAM 3 provider result jobs[${jobIndex}]`);
    if (!Array.isArray(job.instances)) throw new Error(`SAM 3 provider result jobs[${jobIndex}].instances must be an array`);
    return {
      id: string(job.id, `SAM 3 provider result jobs[${jobIndex}].id`, 64),
      prompt: string(job.prompt, `SAM 3 provider result jobs[${jobIndex}].prompt`, 512),
      instances: job.instances.map((rawInstance, instanceIndex): ProviderInstance => {
        const instance = object(rawInstance, `SAM 3 provider result jobs[${jobIndex}].instances[${instanceIndex}]`);
        if (!Array.isArray(instance.bbox) || instance.bbox.length !== 4 || !instance.bbox.every((item) => typeof item === "number" && Number.isFinite(item))) {
          throw new Error(`SAM 3 provider result jobs[${jobIndex}].instances[${instanceIndex}].bbox must contain four finite numbers`);
        }
        return {
          index: integer(instance.index, instanceIndex + 1, 1, 1_000_000, `SAM 3 provider instance index`),
          score: number(instance.score, 0, 0, 1, `SAM 3 provider instance score`),
          bbox: instance.bbox as [number, number, number, number],
          maskPath: string(instance.maskPath, `SAM 3 provider instance maskPath`),
          cutoutPath: string(instance.cutoutPath, `SAM 3 provider instance cutoutPath`)
        };
      })
    };
  });
  return {
    provider: string(record.provider, "SAM 3 provider result provider", 256),
    model: string(record.model, "SAM 3 provider result model", 256),
    checkpoint: string(record.checkpoint, "SAM 3 provider result checkpoint", 4096),
    jobs
  };
}

async function verifyPng(root: string, path: string, expectedDirectory: string, label: string): Promise<{ path: string; sha256: string; bytes: number }> {
  const absolute = isAbsolute(path) ? resolve(path) : containedPath(root, path, label);
  const canonical = await canonicalContained(root, absolute, label);
  const canonicalDirectory = await realpath(expectedDirectory);
  const directoryTraversal = relative(canonicalDirectory, canonical);
  if (!directoryTraversal || directoryTraversal === ".." || directoryTraversal.startsWith("..\\") || directoryTraversal.startsWith("../") || isAbsolute(directoryTraversal)) {
    throw new Error(`${label} is outside its declared output directory`);
  }
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error(`${label} is not a regular file`);
  const content = await readFile(canonical);
  if (content.length < PNG_SIGNATURE.length || !content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG file`);
  }
  return { path: canonical, sha256: createHash("sha256").update(content).digest("hex"), bytes: details.size };
}

export class Sam3ExecutionError extends Error {
  readonly provenance: Record<string, unknown>;
  constructor(message: string, readonly artifacts: ArtifactReference[], provenance: Record<string, unknown> = {}) {
    super(message);
    this.name = "Sam3ExecutionError";
    this.provenance = provenance;
  }
}

export class Sam3SegmentAgent implements AgentDriver {
  readonly id = "sam3.segment";

  async run(request: AgentRequest): Promise<AgentResult> {
    const settings = config(request.campaign);
    const sourceRequestPath = containedPath(request.candidate.root, settings.requestPath, "parameters.sam3.requestPath");
    await canonicalContained(request.candidate.root, sourceRequestPath, "SAM 3 request");
    const segmentationRequest = parseRequest(JSON.parse(await readFile(sourceRequestPath, "utf8")) as unknown);
    const preparedJobs = await Promise.all(segmentationRequest.jobs.map(async (job) => {
      const sourcePath = containedPath(request.candidate.root, job.sourcePath, `SAM 3 job ${job.id} sourcePath`);
      const canonicalSource = await canonicalContained(request.candidate.root, sourcePath, `SAM 3 job ${job.id} sourcePath`);
      if (!(await lstat(canonicalSource)).isFile()) throw new Error(`SAM 3 job ${job.id} source is not a regular file`);
      const outputDirectory = containedPath(request.candidate.root, job.outputDirectory, `SAM 3 job ${job.id} outputDirectory`);
      await mkdir(outputDirectory, { recursive: true });
      await canonicalContained(request.candidate.root, outputDirectory, `SAM 3 job ${job.id} outputDirectory`);
      return { ...job, sourcePath: canonicalSource, outputDirectory };
    }));
    const runDirectory = resolve(request.candidate.root, ".factory", "sam3", request.experimentId);
    await mkdir(runDirectory, { recursive: true });
    const providerRequestPath = resolve(runDirectory, "request.json");
    const resultPath = resolve(runDirectory, "result.json");
    const stdoutPath = resolve(runDirectory, "stdout.log");
    const stderrPath = resolve(runDirectory, "stderr.log");
    const providerRequest = {
      apiVersion: API_VERSION,
      experimentId: request.experimentId,
      candidateId: request.candidate.id,
      model: settings.model,
      device: settings.device,
      ...(settings.checkpointPath ? { checkpointPath: settings.checkpointPath } : {}),
      jobs: preparedJobs
    };
    await writeFile(providerRequestPath, `${JSON.stringify(providerRequest, null, 2)}\n`, "utf8");
    const baseArtifacts = [
      artifact(sourceRequestPath, "other", "SAM 3 segmentation request", "application/json"),
      artifact(providerRequestPath, "other", "SAM 3 provider request", "application/json"),
      artifact(stdoutPath, "log", "SAM 3 stdout", "text/plain"),
      artifact(stderrPath, "log", "SAM 3 stderr", "text/plain")
    ];
    const traceNode = `agent:${request.experimentId}:sam3.segment`;
    await emit(request, { type: "node:created", nodeId: traceNode, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: "SAM 3 segmentation", role: "asset-processor", data: { model: settings.model, jobs: preparedJobs.length } });
    await emit(request, { type: "node:started", nodeId: traceNode, experimentId: request.experimentId, label: "SAM 3 segmentation", role: "asset-processor" });
    const startedAt = new Date().toISOString();
    const renderedCommand = renderCommand(settings.command);
    const processResult = await execute(
      renderedCommand,
      request.candidate.root,
      request.signal,
      settings.timeoutSeconds,
      settings.maxOutputCharacters,
      childEnvironment(settings.environmentAllowlist, {
        GAMEFACTORY_SAM3_REQUEST: providerRequestPath,
        GAMEFACTORY_SAM3_RESULT: resultPath
      })
    );
    await Promise.all([writeFile(stdoutPath, processResult.stdout, "utf8"), writeFile(stderrPath, processResult.stderr, "utf8")]);
    if (processResult.code !== 0 || processResult.failure) {
      const detail = processResult.failure ?? `exit-${String(processResult.code)}`;
      await emit(request, { type: "node:failed", nodeId: traceNode, experimentId: request.experimentId, label: "SAM 3 segmentation", role: "asset-processor", status: "failed", message: detail });
      throw new Sam3ExecutionError(`SAM 3 segmentation failed (${detail}): ${processResult.stderr.trim()}`, baseArtifacts, { command: renderedCommand, failure: detail, model: settings.model });
    }
    let provider: ProviderResult;
    try {
      provider = parseProviderResult(JSON.parse(await readFile(resultPath, "utf8")) as unknown);
    } catch (error) {
      throw new Sam3ExecutionError(`SAM 3 provider did not return a valid result: ${error instanceof Error ? error.message : String(error)}`, [...baseArtifacts, artifact(resultPath, "other", "Invalid SAM 3 result", "application/json")], { command: renderedCommand, model: settings.model });
    }
    const requestById = new Map(preparedJobs.map((job) => [job.id, job]));
    const returnedJobIds = new Set<string>();
    const outputArtifacts: ArtifactReference[] = [];
    const outputRecords: Array<Record<string, unknown>> = [];
    try {
      for (const job of provider.jobs) {
        const declared = requestById.get(job.id);
        if (!declared) throw new Error(`SAM 3 provider returned undeclared job ${job.id}`);
        if (returnedJobIds.has(job.id)) throw new Error(`SAM 3 provider returned duplicate job ${job.id}`);
        returnedJobIds.add(job.id);
        if (job.prompt !== declared.prompt) throw new Error(`SAM 3 provider changed the prompt for job ${job.id}`);
        for (const instance of job.instances) {
          const mask = await verifyPng(request.candidate.root, instance.maskPath, declared.outputDirectory, `SAM 3 ${job.id} mask`);
          const cutout = await verifyPng(request.candidate.root, instance.cutoutPath, declared.outputDirectory, `SAM 3 ${job.id} cutout`);
          const metadata = { jobId: job.id, prompt: job.prompt, instance: instance.index, confidence: instance.score, bbox: instance.bbox, model: provider.model, checkpoint: provider.checkpoint };
          outputArtifacts.push(
            { ...artifact(mask.path, "image", `${job.id} mask ${instance.index}`, "image/png", metadata), sha256: mask.sha256 },
            { ...artifact(cutout.path, "image", `${job.id} cutout ${instance.index}`, "image/png", metadata), sha256: cutout.sha256 }
          );
          outputRecords.push({ jobId: job.id, instance: instance.index, confidence: instance.score, bbox: instance.bbox, mask: { path: mask.path, sha256: mask.sha256, bytes: mask.bytes }, cutout: { path: cutout.path, sha256: cutout.sha256, bytes: cutout.bytes } });
        }
      }
      const missingJobs = preparedJobs.filter((job) => !returnedJobIds.has(job.id));
      if (missingJobs.length > 0) throw new Error(`SAM 3 provider omitted job(s): ${missingJobs.map((job) => job.id).join(", ")}`);
    } catch (error) {
      throw new Sam3ExecutionError(`SAM 3 output verification failed: ${error instanceof Error ? error.message : String(error)}`, [...baseArtifacts, artifact(resultPath, "other", "SAM 3 provider result", "application/json"), ...outputArtifacts], { provider: provider.provider, model: provider.model, checkpoint: provider.checkpoint });
    }
    const finishedAt = new Date().toISOString();
    const artifacts = [...baseArtifacts, artifact(resultPath, "other", "SAM 3 provider result", "application/json"), ...outputArtifacts];
    await emit(request, { type: "artifact:produced", nodeId: traceNode, experimentId: request.experimentId, label: "SAM 3 outputs", role: "asset-processor", message: `${outputArtifacts.length} image artifacts`, data: { outputs: outputRecords.length } });
    await emit(request, { type: "node:completed", nodeId: traceNode, experimentId: request.experimentId, label: "SAM 3 segmentation", role: "asset-processor", status: "complete", message: `${outputRecords.length} instances extracted`, data: { provider: provider.provider, model: provider.model, checkpoint: provider.checkpoint, instances: outputRecords.length } });
    const contributor: AgentContribution = {
      agentId: `sam3:${provider.model}`,
      role: "worker",
      status: "complete",
      startedAt,
      finishedAt,
      summary: `Segmented ${preparedJobs.length} concept job(s) into ${outputRecords.length} instance(s)`,
      artifacts,
      metadata: { provider: provider.provider, model: provider.model, checkpoint: provider.checkpoint, outputs: outputRecords }
    };
    return {
      summary: contributor.summary,
      artifacts,
      contributors: [contributor],
      metadata: { apiVersion: API_VERSION, outcome: outputRecords.length > 0 ? "segmented" : "no_instances", provider: provider.provider, model: provider.model, checkpoint: provider.checkpoint, requestPath: settings.requestPath, jobs: preparedJobs.length, instances: outputRecords.length, outputs: outputRecords }
    };
  }
}

export class Sam3Runtime implements EngineDriver {
  readonly id = "sam3.runtime";

  async doctor(context: Parameters<EngineDriver["doctor"]>[0]): Promise<DoctorResult> {
    try {
      const settings = config(context.campaign);
      const rendered = renderCommand(settings.doctorCommand);
      const result = await execute(rendered, context.projectRoot, context.signal, Math.min(settings.timeoutSeconds, 60), settings.maxOutputCharacters, childEnvironment(settings.environmentAllowlist, { GAMEFACTORY_SAM3_DEVICE: settings.device }));
      const message = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? (result.stderr.trim() || `exit ${String(result.code)}`);
      return { ok: result.code === 0 && !result.failure, checks: [{ name: "python-worker", ok: result.code === 0 && !result.failure, message }] };
    } catch (error) {
      return { ok: false, checks: [{ name: "python-worker", ok: false, message: error instanceof Error ? error.message : String(error) }] };
    }
  }
}

export default defineExtension((api) => {
  const segment = api.register("agent", "sam3.segment", new Sam3SegmentAgent());
  const runtime = api.register("engine", "sam3.runtime", new Sam3Runtime());
  return { async dispose() { await runtime.dispose(); await segment.dispose(); } };
});
