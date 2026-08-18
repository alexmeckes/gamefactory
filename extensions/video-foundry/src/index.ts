import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCredentialStore, resolveCredential, type AgentContribution, type AgentDriver, type AgentRequest, type AgentResult, type ArtifactReference, type FactoryTraceEventInput } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

const VIDEO_API_VERSION = "gamefactory.video/v1" as const;
const ANIMATION_API_VERSION = "gamefactory.animation/v1" as const;
const DEFAULT_MODEL = "gemini-omni-flash-preview";
const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const COMPILER_PATH = fileURLToPath(new URL("../python/compile.py", import.meta.url));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type VideoTask = "text_to_video" | "image_to_video" | "reference_to_video" | "edit";

interface VideoJob { id: string; prompt: string; outputPath: string; task: VideoTask; aspectRatio: "16:9" | "9:16"; references: Array<{ path: string; mediaType: "image/png" | "image/jpeg" | "video/mp4" }>; previousJobId?: string; }
interface VideoRequest { apiVersion: typeof VIDEO_API_VERSION; jobs: VideoJob[]; }
interface VideoSettings { requestPath: string; credentialName: string; apiKeyEnvironment: string; model: string; timeoutSeconds: number; pollIntervalMilliseconds: number; maxOutputBytes: number; maximumJobs: number; estimatedSecondsPerJob: number; estimatedCostPerSecondUsd: number; maximumEstimatedCostUsd: number; }
interface AnimationJob { id: string; sourceDirectory: string; outputDirectory: string; frameGlob: string; frameStride: number; columns?: number; trimTransparent: boolean; loop: boolean; }
interface AnimationRequest { apiVersion: typeof ANIMATION_API_VERSION; jobs: AnimationJob[]; }
interface AnimationSettings { requestPath: string; command: string[]; timeoutSeconds: number; maxOutputCharacters: number; }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string with at most ${maximum} characters`);
  return value.trim();
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return result;
}
function finite(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} must be a number from ${minimum} to ${maximum}`);
  return result;
}
function bool(value: unknown, fallback: boolean, label: string): boolean {
  const result = value ?? fallback;
  if (typeof result !== "boolean") throw new Error(`${label} must be boolean`);
  return result;
}
function command(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.length || !value.every((part) => typeof part === "string" && part.length)) throw new Error(`${label} must be a non-empty string array`);
  return [...value];
}
function contained(root: string, projectPath: string, label: string): string {
  if (projectPath.includes("\0") || isAbsolute(projectPath)) throw new Error(`${label} must be a relative candidate path`);
  const target = resolve(root, projectPath);
  const traversal = relative(resolve(root), target);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} must stay below the candidate root`);
  return target;
}
async function canonicalContained(root: string, target: string, label: string): Promise<string> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  const traversal = relative(canonicalRoot, canonicalTarget);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} resolves outside the candidate root`);
  return canonicalTarget;
}
function artifact(path: string, kind: ArtifactReference["kind"], label: string, mediaType: string, metadata?: Record<string, unknown>): ArtifactReference {
  return { path, kind, label, mediaType, ...(metadata ? { metadata } : {}) };
}
async function emit(request: AgentRequest, event: FactoryTraceEventInput): Promise<void> { try { await request.trace?.emit(event); } catch { /* observational */ } }
function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

function videoSettings(campaign: AgentRequest["campaign"]): VideoSettings {
  const raw = campaign.parameters?.googleOmni;
  const value = raw === undefined ? {} : object(raw, "parameters.googleOmni");
  return {
    requestPath: text(value.requestPath ?? "video.request.json", "parameters.googleOmni.requestPath"),
    credentialName: text(value.credentialName ?? "google.gemini", "parameters.googleOmni.credentialName", 128),
    apiKeyEnvironment: text(value.apiKeyEnvironment ?? "GEMINI_API_KEY", "parameters.googleOmni.apiKeyEnvironment", 128),
    model: text(value.model ?? DEFAULT_MODEL, "parameters.googleOmni.model", 256),
    timeoutSeconds: integer(value.timeoutSeconds, 900, 10, 3600, "parameters.googleOmni.timeoutSeconds"),
    pollIntervalMilliseconds: integer(value.pollIntervalMilliseconds, 5000, 250, 60000, "parameters.googleOmni.pollIntervalMilliseconds"),
    maxOutputBytes: integer(value.maxOutputBytes, 100_000_000, 1024, 500_000_000, "parameters.googleOmni.maxOutputBytes"),
    maximumJobs: integer(value.maximumJobs, 4, 1, 64, "parameters.googleOmni.maximumJobs"),
    estimatedSecondsPerJob: finite(value.estimatedSecondsPerJob, 10, 1, 60, "parameters.googleOmni.estimatedSecondsPerJob"),
    estimatedCostPerSecondUsd: finite(value.estimatedCostPerSecondUsd, 0.10, 0.001, 10, "parameters.googleOmni.estimatedCostPerSecondUsd"),
    maximumEstimatedCostUsd: finite(value.maximumEstimatedCostUsd, 25, 0.01, 10_000, "parameters.googleOmni.maximumEstimatedCostUsd")
  };
}

function parseVideoRequest(value: unknown): VideoRequest {
  const record = object(value, "video request");
  if (record.apiVersion !== VIDEO_API_VERSION) throw new Error(`video request apiVersion must be ${VIDEO_API_VERSION}`);
  if (!Array.isArray(record.jobs) || !record.jobs.length || record.jobs.length > 8) throw new Error("video request jobs must contain from 1 to 8 jobs");
  const ids = new Set<string>();
  const jobs = record.jobs.map((raw, index): VideoJob => {
    const job = object(raw, `video jobs[${index}]`);
    const id = text(job.id, `video jobs[${index}].id`, 64);
    if (!ID_PATTERN.test(id) || ids.has(id)) throw new Error(`video job id ${id} is invalid or duplicated`);
    ids.add(id);
    const task = job.task ?? "text_to_video";
    if (task !== "text_to_video" && task !== "image_to_video" && task !== "reference_to_video" && task !== "edit") throw new Error(`video jobs[${index}].task is unsupported`);
    const aspectRatio = job.aspectRatio ?? "16:9";
    if (aspectRatio !== "16:9" && aspectRatio !== "9:16") throw new Error(`video jobs[${index}].aspectRatio must be 16:9 or 9:16`);
    const references = job.references === undefined ? [] : Array.isArray(job.references) && job.references.length <= 4 ? job.references.map((rawReference, referenceIndex) => {
      const reference = object(rawReference, `video jobs[${index}].references[${referenceIndex}]`);
      const mediaType = reference.mediaType;
      if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "video/mp4") throw new Error(`video reference mediaType is unsupported`);
      return { path: text(reference.path, `video reference path`), mediaType: mediaType as "image/png" | "image/jpeg" | "video/mp4" };
    }) : (() => { throw new Error(`video jobs[${index}].references must contain at most 4 references`); })();
    return { id, prompt: text(job.prompt, `video jobs[${index}].prompt`, 16000), outputPath: text(job.outputPath, `video jobs[${index}].outputPath`), task, aspectRatio, references, ...(typeof job.previousJobId === "string" ? { previousJobId: text(job.previousJobId, `video jobs[${index}].previousJobId`, 64) } : {}) };
  });
  for (const job of jobs) if (job.previousJobId && !ids.has(job.previousJobId)) throw new Error(`video job ${job.id} refers to unknown previousJobId ${job.previousJobId}`);
  return { apiVersion: VIDEO_API_VERSION, jobs };
}

function recursiveFind(value: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (predicate(record)) return record;
    for (const child of Object.values(record)) { const found = recursiveFind(child, predicate); if (found) return found; }
  } else for (const child of value) { const found = recursiveFind(child, predicate); if (found) return found; }
  return undefined;
}

async function fetchWithDeadline(fetchImpl: typeof fetch, input: string, init: RequestInit, timeoutSeconds: number, signal: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  return fetchImpl(input, { ...init, signal: AbortSignal.any([signal, deadline]) });
}

async function responseVideo(fetchImpl: typeof fetch, response: Response, key: string, settings: VideoSettings, signal: AbortSignal): Promise<{ bytes: Buffer; interactionId?: string }> {
  if (!response.ok) throw new Error(`Google Omni request failed with HTTP ${response.status}`);
  const raw = await response.json() as unknown;
  const root = object(raw, "Google Omni response");
  const interactionId = typeof root.id === "string" ? root.id : typeof root.interaction_id === "string" ? root.interaction_id : undefined;
  const direct = recursiveFind(raw, (record) => record.type === "video" && typeof record.data === "string");
  if (direct && typeof direct.data === "string") return { bytes: Buffer.from(direct.data, "base64"), ...(interactionId ? { interactionId } : {}) };
  const uriRecord = recursiveFind(raw, (record) => record.type === "video" && typeof record.uri === "string") ?? recursiveFind(raw, (record) => typeof record.uri === "string" && String(record.mime_type ?? record.mimeType ?? "").startsWith("video/"));
  if (!uriRecord || typeof uriRecord.uri !== "string") throw new Error("Google Omni response contained no downloadable video");
  const started = Date.now();
  let uri = uriRecord.uri;
  while (Date.now() - started < settings.timeoutSeconds * 1000) {
    const download = await fetchWithDeadline(fetchImpl, uri, { headers: { "x-goog-api-key": key, Accept: "video/mp4, application/json" } }, settings.timeoutSeconds, signal);
    const type = download.headers.get("content-type") ?? "";
    if (download.ok && !type.includes("json")) return { bytes: Buffer.from(await download.arrayBuffer()), ...(interactionId ? { interactionId } : {}) };
    if (download.ok) {
      const status = await download.json() as unknown;
      const next = recursiveFind(status, (record) => typeof record.download_uri === "string" || typeof record.downloadUri === "string");
      const nextUri = next?.download_uri ?? next?.downloadUri;
      if (typeof nextUri === "string") uri = nextUri;
    }
    await new Promise<void>((resolveWait, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolveWait(); }, settings.pollIntervalMilliseconds);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw new Error("Google Omni video did not become downloadable before the configured timeout");
}

export class VideoFoundryExecutionError extends Error {
  constructor(message: string, readonly artifacts: ArtifactReference[], readonly provenance: Record<string, unknown> = {}) { super(message); this.name = "VideoFoundryExecutionError"; }
}

export class GoogleOmniVideoAgent implements AgentDriver {
  readonly id = "video.google-omni";
  private readonly campaignReservations = new Map<string, { jobs: number; estimatedCostUsd: number }>();
  constructor(private readonly dependencies: { fetchImpl?: typeof fetch; credentialStore?: LocalCredentialStore } = {}) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    const settings = videoSettings(request.campaign);
    const requestPath = contained(request.candidate.root, settings.requestPath, "Google Omni requestPath");
    await canonicalContained(request.candidate.root, requestPath, "Google Omni request");
    const specification = parseVideoRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
    const priorReservation = this.campaignReservations.get(request.campaign.id) ?? { jobs: 0, estimatedCostUsd: 0 };
    const estimatedCostUsd = specification.jobs.length * settings.estimatedSecondsPerJob * settings.estimatedCostPerSecondUsd;
    const reserved = { jobs: priorReservation.jobs + specification.jobs.length, estimatedCostUsd: priorReservation.estimatedCostUsd + estimatedCostUsd };
    if (reserved.jobs > settings.maximumJobs) throw new VideoFoundryExecutionError(`Google Omni campaign job cap exceeded: ${reserved.jobs} requested, maximum ${settings.maximumJobs}`, [artifact(requestPath, "other", "Video generation request", "application/json")], { configuredModel: settings.model, maximumJobs: settings.maximumJobs, priorReservedJobs: priorReservation.jobs });
    if (reserved.estimatedCostUsd > settings.maximumEstimatedCostUsd + Number.EPSILON) throw new VideoFoundryExecutionError(`Google Omni estimated campaign cost cap exceeded: $${reserved.estimatedCostUsd.toFixed(2)} requested, maximum $${settings.maximumEstimatedCostUsd.toFixed(2)}`, [artifact(requestPath, "other", "Video generation request", "application/json")], { configuredModel: settings.model, maximumEstimatedCostUsd: settings.maximumEstimatedCostUsd, priorReservedCostUsd: priorReservation.estimatedCostUsd });
    // Reserve before credential resolution or network I/O and retain failed reservations.
    // Unknown provider outcomes must not permit a retry to spend the same allowance twice.
    this.campaignReservations.set(request.campaign.id, reserved);
    const credential = await resolveCredential(settings.credentialName, settings.apiKeyEnvironment, this.dependencies.credentialStore);
    if (!credential) throw new VideoFoundryExecutionError(`Credential ${settings.credentialName} is unavailable; run gamefactory credentials set ${settings.credentialName} or set ${settings.apiKeyEnvironment}`, [artifact(requestPath, "other", "Video generation request", "application/json")], { model: settings.model, credentialName: settings.credentialName });
    const runDirectory = resolve(request.candidate.root, ".factory", "video-foundry", request.experimentId);
    await mkdir(runDirectory, { recursive: true });
    const reportPath = resolve(runDirectory, "video-result.json");
    const baseArtifacts = [artifact(requestPath, "other", "Video generation request", "application/json"), artifact(reportPath, "other", "Sanitized video result", "application/json")];
    const traceNode = `agent:${request.experimentId}:video.google-omni`;
    const spend = { estimatedCostUsd, campaignReservedCostUsd: reserved.estimatedCostUsd, campaignReservedJobs: reserved.jobs, maximumEstimatedCostUsd: settings.maximumEstimatedCostUsd, maximumJobs: settings.maximumJobs, estimatedSecondsPerJob: settings.estimatedSecondsPerJob, estimatedCostPerSecondUsd: settings.estimatedCostPerSecondUsd };
    await emit(request, { type: "node:created", nodeId: traceNode, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: "Google Omni video", role: "asset-generator", data: { configuredModel: settings.model, credentialSource: credential.source, jobs: specification.jobs.length, ...spend } });
    await emit(request, { type: "node:started", nodeId: traceNode, experimentId: request.experimentId, label: "Google Omni video", role: "asset-generator" });
    const startedAt = new Date().toISOString();
    const outputs: Array<Record<string, unknown>> = [];
    const outputArtifacts: ArtifactReference[] = [];
    const interactions = new Map<string, string>();
    try {
      for (const job of specification.jobs) {
        const outputPath = contained(request.candidate.root, job.outputPath, `video job ${job.id} outputPath`);
        await mkdir(dirname(outputPath), { recursive: true });
        await canonicalContained(request.candidate.root, dirname(outputPath), `video job ${job.id} output directory`);
        const content: Array<Record<string, unknown>> = [];
        for (const reference of job.references) {
          const referencePath = contained(request.candidate.root, reference.path, `video job ${job.id} reference`);
          const canonical = await canonicalContained(request.candidate.root, referencePath, `video job ${job.id} reference`);
          if (!(await lstat(canonical)).isFile()) throw new Error(`video job ${job.id} reference is not a regular file`);
          content.push({ type: reference.mediaType === "video/mp4" ? "video" : "image", data: (await readFile(canonical)).toString("base64"), mime_type: reference.mediaType });
        }
        content.push({ type: "text", text: job.prompt });
        const previous = job.previousJobId ? interactions.get(job.previousJobId) : undefined;
        if (job.previousJobId && !previous) throw new Error(`video job ${job.id} could not resolve prior interaction ${job.previousJobId}`);
        const body = { model: settings.model, input: content.length === 1 ? job.prompt : content, response_format: { type: "video", delivery: "uri", aspect_ratio: job.aspectRatio }, generation_config: { video_config: { task: job.task } }, ...(previous ? { previous_interaction_id: previous } : {}) };
        const response = await fetchWithDeadline(this.dependencies.fetchImpl ?? fetch, INTERACTIONS_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": credential.value }, body: JSON.stringify(body) }, settings.timeoutSeconds, request.signal);
        const generated = await responseVideo(this.dependencies.fetchImpl ?? fetch, response, credential.value, settings, request.signal);
        if (generated.bytes.length > settings.maxOutputBytes) throw new Error(`video job ${job.id} exceeded maxOutputBytes`);
        if (generated.bytes.length < 12 || generated.bytes.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error(`video job ${job.id} did not return an MP4 file`);
        await writeFile(outputPath, generated.bytes, { flag: "wx" });
        if (generated.interactionId) interactions.set(job.id, generated.interactionId);
        const hash = sha256(generated.bytes);
        outputs.push({ id: job.id, task: job.task, outputPath: job.outputPath.replaceAll("\\", "/"), sha256: hash, bytes: generated.bytes.length, ...(generated.interactionId ? { interactionId: generated.interactionId } : {}) });
        outputArtifacts.push({ ...artifact(outputPath, "video", `${job.id} generated video`, "video/mp4", { jobId: job.id, task: job.task, configuredModel: settings.model }), sha256: hash });
      }
    } catch (error) {
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: VIDEO_API_VERSION, status: "failed", configuredModel: settings.model, credentialSource: credential.source, spend, outputs, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
      await emit(request, { type: "node:failed", nodeId: traceNode, experimentId: request.experimentId, label: "Google Omni video", role: "asset-generator", status: "failed", message: error instanceof Error ? error.message : String(error) });
      throw new VideoFoundryExecutionError(`Google Omni video generation failed: ${error instanceof Error ? error.message : String(error)}`, [...baseArtifacts, ...outputArtifacts], { configuredModel: settings.model, credentialSource: credential.source, spend, outputs });
    }
    const finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify({ apiVersion: VIDEO_API_VERSION, status: "complete", configuredModel: settings.model, credentialSource: credential.source, spend, outputs }, null, 2)}\n`, "utf8");
    const artifacts = [...baseArtifacts, ...outputArtifacts];
    await emit(request, { type: "artifact:produced", nodeId: traceNode, experimentId: request.experimentId, label: "Generated videos", role: "asset-generator", message: `${outputs.length} video(s)`, data: { configuredModel: settings.model, outputCount: outputs.length } });
    await emit(request, { type: "node:completed", nodeId: traceNode, experimentId: request.experimentId, label: "Google Omni video", role: "asset-generator", status: "complete", message: `${outputs.length} video(s) generated`, data: { configuredModel: settings.model, credentialSource: credential.source } });
    const metadata = { provider: "google", configuredModel: settings.model, credentialSource: credential.source, billingMode: "metered", spend, outputs }; const contributor: AgentContribution = { agentId: `google-omni:${settings.model}`, role: "worker", status: "complete", startedAt, finishedAt, summary: `Generated ${outputs.length} video(s)`, artifacts, metadata };
    return { summary: contributor.summary, artifacts, contributors: [contributor], metadata };
  }
}

function animationSettings(campaign: AgentRequest["campaign"]): AnimationSettings {
  const raw = campaign.parameters?.animationCompiler;
  const value = raw === undefined ? {} : object(raw, "parameters.animationCompiler");
  return { requestPath: text(value.requestPath ?? "animation.request.json", "parameters.animationCompiler.requestPath"), command: command(value.command, ["python", COMPILER_PATH], "parameters.animationCompiler.command"), timeoutSeconds: integer(value.timeoutSeconds, 120, 1, 3600, "parameters.animationCompiler.timeoutSeconds"), maxOutputCharacters: integer(value.maxOutputCharacters, 30000, 1000, 1000000, "parameters.animationCompiler.maxOutputCharacters") };
}
function parseAnimationRequest(value: unknown): AnimationRequest {
  const record = object(value, "animation request");
  if (record.apiVersion !== ANIMATION_API_VERSION) throw new Error(`animation request apiVersion must be ${ANIMATION_API_VERSION}`);
  if (!Array.isArray(record.jobs) || !record.jobs.length || record.jobs.length > 32) throw new Error("animation request jobs must contain from 1 to 32 jobs");
  const ids = new Set<string>();
  const jobs = record.jobs.map((raw, index): AnimationJob => {
    const job = object(raw, `animation jobs[${index}]`); const id = text(job.id, `animation jobs[${index}].id`, 64);
    if (!ID_PATTERN.test(id) || ids.has(id)) throw new Error(`animation job id ${id} is invalid or duplicated`); ids.add(id);
    return { id, sourceDirectory: text(job.sourceDirectory, `animation jobs[${index}].sourceDirectory`), outputDirectory: text(job.outputDirectory, `animation jobs[${index}].outputDirectory`), frameGlob: text(job.frameGlob ?? "*.cutout.png", `animation jobs[${index}].frameGlob`, 256), frameStride: integer(job.frameStride, 1, 1, 1000, `animation jobs[${index}].frameStride`), ...(job.columns === undefined ? {} : { columns: integer(job.columns, 1, 1, 256, `animation jobs[${index}].columns`) }), trimTransparent: bool(job.trimTransparent, true, `animation jobs[${index}].trimTransparent`), loop: bool(job.loop, true, `animation jobs[${index}].loop`) };
  }); return { apiVersion: ANIMATION_API_VERSION, jobs };
}
function execute(parts: string[], cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, timeoutSeconds: number, maximum: number): Promise<{ code: number | null; stdout: string; stderr: string; failure?: string }> {
  return new Promise((resolveResult) => { const [executable, ...args] = parts; if (!executable) return resolveResult({ code: null, stdout: "", stderr: "missing executable", failure: "spawn" }); let stdout = "", stderr = "", failure: string | undefined, stopping = false, settled = false; const child = spawn(executable, args, { cwd, env: environment, windowsHide: true, detached: process.platform !== "win32" }); const stop = (reason: string) => { if (stopping) return; stopping = true; failure = reason; if (process.platform === "win32" && child.pid) { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); killer.once("error", () => { try { child.kill("SIGKILL"); } catch {} }); } else { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } } }; const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000); const abort = () => stop("cancelled"); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); const append = (which: "stdout" | "stderr", chunk: unknown) => { if (stopping) return; if (which === "stdout") stdout += String(chunk); else stderr += String(chunk); if (stdout.length + stderr.length > maximum) stop("output-limit"); }; child.stdout?.on("data", (chunk) => append("stdout", chunk)); child.stderr?.on("data", (chunk) => append("stderr", chunk)); const finish = (code: number | null, extra?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolveResult({ code, stdout, stderr: extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr, ...(failure ? { failure } : {}) }); }; child.once("error", (error) => finish(null, error.message)); child.once("close", (code) => finish(code)); });
}

export class AnimationCompilerAgent implements AgentDriver {
  readonly id = "animation.compile";
  async run(request: AgentRequest): Promise<AgentResult> {
    const settings = animationSettings(request.campaign); const sourceRequestPath = contained(request.candidate.root, settings.requestPath, "animation requestPath"); await canonicalContained(request.candidate.root, sourceRequestPath, "animation request"); const specification = parseAnimationRequest(JSON.parse(await readFile(sourceRequestPath, "utf8")) as unknown);
    const prepared = await Promise.all(specification.jobs.map(async (job) => { const sourceDirectory = contained(request.candidate.root, job.sourceDirectory, `animation ${job.id} sourceDirectory`); await canonicalContained(request.candidate.root, sourceDirectory, `animation ${job.id} sourceDirectory`); const outputDirectory = contained(request.candidate.root, job.outputDirectory, `animation ${job.id} outputDirectory`); await mkdir(outputDirectory, { recursive: true }); await canonicalContained(request.candidate.root, outputDirectory, `animation ${job.id} outputDirectory`); return { ...job, sourceDirectory, outputDirectory }; }));
    const runDirectory = resolve(request.candidate.root, ".factory", "animation-compiler", request.experimentId); await mkdir(runDirectory, { recursive: true }); const providerRequestPath = resolve(runDirectory, "request.json"), resultPath = resolve(runDirectory, "result.json"), stdoutPath = resolve(runDirectory, "stdout.log"), stderrPath = resolve(runDirectory, "stderr.log"); await writeFile(providerRequestPath, `${JSON.stringify({ apiVersion: ANIMATION_API_VERSION, jobs: prepared }, null, 2)}\n`, "utf8");
    const baseArtifacts = [artifact(sourceRequestPath, "other", "Animation request", "application/json"), artifact(providerRequestPath, "other", "Compiler request", "application/json"), artifact(resultPath, "other", "Compiler result", "application/json"), artifact(stdoutPath, "log", "Compiler stdout", "text/plain"), artifact(stderrPath, "log", "Compiler stderr", "text/plain")]; const traceNode = `agent:${request.experimentId}:animation.compile`; await emit(request, { type: "node:created", nodeId: traceNode, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: "Animation compiler", role: "asset-processor", data: { jobs: prepared.length } }); await emit(request, { type: "node:started", nodeId: traceNode, experimentId: request.experimentId, label: "Animation compiler", role: "asset-processor" }); const startedAt = new Date().toISOString();
    const environment: NodeJS.ProcessEnv = {}; for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name] !== undefined) environment[name] = process.env[name]; environment.GAMEFACTORY_ANIMATION_REQUEST = providerRequestPath; environment.GAMEFACTORY_ANIMATION_RESULT = resultPath; const processResult = await execute(settings.command.map((part) => part.replaceAll("{worker}", COMPILER_PATH)), request.candidate.root, environment, request.signal, settings.timeoutSeconds, settings.maxOutputCharacters); await Promise.all([writeFile(stdoutPath, processResult.stdout, "utf8"), writeFile(stderrPath, processResult.stderr, "utf8")]); if (processResult.code !== 0 || processResult.failure) throw new VideoFoundryExecutionError(`Animation compiler failed (${processResult.failure ?? `exit-${String(processResult.code)}`}): ${processResult.stderr.trim()}`, baseArtifacts, { command: settings.command, failure: processResult.failure });
    const result = object(JSON.parse(await readFile(resultPath, "utf8")) as unknown, "animation compiler result"); if (!Array.isArray(result.jobs)) throw new VideoFoundryExecutionError("Animation compiler result has no jobs", baseArtifacts);
    const outputArtifacts: ArtifactReference[] = []; for (const raw of result.jobs) { const job = object(raw, "animation result job"); for (const [field, mediaType, kind] of [["atlasPath", "image/png", "image"], ["metadataPath", "application/json", "other"]] as const) { const declared = text(job[field], `animation result ${field}`); const path = isAbsolute(declared) ? resolve(declared) : contained(request.candidate.root, declared, `animation result ${field}`); const canonical = await canonicalContained(request.candidate.root, path, `animation result ${field}`); const content = await readFile(canonical); if (field === "atlasPath" && (content.length < 8 || !content.subarray(0, 8).equals(PNG_SIGNATURE))) throw new Error("animation atlas is not PNG"); outputArtifacts.push({ ...artifact(canonical, kind, `${text(job.id, "animation result id")} ${field}`, mediaType, { diagnostics: job.diagnostics }), sha256: sha256(content) }); } }
    const finishedAt = new Date().toISOString(); const artifacts = [...baseArtifacts, ...outputArtifacts]; await emit(request, { type: "artifact:produced", nodeId: traceNode, experimentId: request.experimentId, label: "Compiled animation", role: "asset-processor", message: `${result.jobs.length} atlas(es)`, data: { jobCount: result.jobs.length } }); await emit(request, { type: "node:completed", nodeId: traceNode, experimentId: request.experimentId, label: "Animation compiler", role: "asset-processor", status: "complete", message: `${result.jobs.length} animation(s) compiled` }); const metadata = { provider: "bundled", jobs: result.jobs }; const contributor: AgentContribution = { agentId: "animation-compiler:bundled", role: "worker", status: "complete", startedAt, finishedAt, summary: `Compiled ${result.jobs.length} animation(s)`, artifacts, metadata }; return { summary: contributor.summary, artifacts, contributors: [contributor], metadata };
  }
}

export default defineExtension((api) => {
  const video = api.register("agent", "video.google-omni", new GoogleOmniVideoAgent());
  const animation = api.register("agent", "animation.compile", new AnimationCompilerAgent());
  return { async dispose() { await animation.dispose(); await video.dispose(); } };
});
