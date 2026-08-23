import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AgentDriver,
  AgentResult,
  ArtifactReference,
  Campaign,
  Candidate,
  CandidateContext,
  DoctorResult,
  EngineDriver,
  Evaluation,
  Evaluator,
  ExecutionResult,
  ProjectContext,
  ScenarioReference,
  ScenarioResult,
  ScenarioRunner,
  Violation
} from "@gamefactory/core";
import { InfrastructureFailureError } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

export const UNITY_SCENARIO_PROVIDER = "unity.pipeline/v1";
export const EMBODIED_TRACE_PROTOCOL = "gamefactory.embodied-trace/v1";
export const UNITY_EVIDENCE_PRODUCER = "factory-owned-unity-bridge";
export const ENGINE_EVIDENCE_AUTHORITY = "factory-engine";
export const DEFAULT_UNITY_BRIDGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bridges/unity/com.gamefactory.bridge");

export interface UnityBridgeAuthority {
  root: string;
  sha256: string;
}

const UNITY_SNAPSHOT_ROOTS = ["Assets", "ProjectSettings", "Packages"] as const;

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function snapshotFiles(root: string, directory: string): Promise<Array<{ path: string; sha256: string }>> {
  const absolute = resolve(root, directory);
  try {
    if (!(await lstat(absolute)).isDirectory()) return [];
  } catch {
    return [];
  }
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push({ path: relative(root, child).replaceAll("\\", "/"), sha256: await fileSha256(child) });
    }
  };
  await visit(absolute);
  return files;
}

export async function unityCandidateSnapshot(candidate: Candidate): Promise<{ algorithm: "sha256"; sha256: string; fileCount: number; roots: string[]; candidateId: string; baseRevision?: string }> {
  const files = (await Promise.all(UNITY_SNAPSHOT_ROOTS.map((directory) => snapshotFiles(candidate.root, directory)))).flat();
  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.sha256).update("\n");
  return {
    algorithm: "sha256",
    sha256: hash.digest("hex"),
    fileCount: files.length,
    roots: [...UNITY_SNAPSHOT_ROOTS],
    candidateId: candidate.id,
    ...(candidate.baseRevision ? { baseRevision: candidate.baseRevision } : {})
  };
}

export interface UnityProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type UnityProcessRunner = (
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutSeconds: number
) => Promise<UnityProcessResult>;

export type UnityWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type UnityProcessTerminator = (pid: number) => Promise<void>;

export interface UnityEmbodiedProofConfig {
  minimumDurationSeconds: number;
  minimumShippingInputEvents: number;
  minimumDisplacementUnits: number;
  minimumSpatialInteractions: number;
  minimumStateConsequences: number;
  minimumDistinctFrames: number;
}

interface UnityConfig {
  cli: string;
  projectPath?: string;
  timeoutSeconds: number;
  importCheck: boolean;
  command: string;
  prepareCommand: string;
  connectedEditor: boolean;
  bridgePath: string;
  scenarios: Array<{ id: string; reference: ScenarioReference }>;
  embodiedProof?: UnityEmbodiedProofConfig;
}

const ARTIFACT_KINDS = new Set<ArtifactReference["kind"]>([
  "image", "video", "audio", "replay", "telemetry", "profile", "test-report", "log", "build", "crash-dump", "other"
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scenarioReference(value: Record<string, unknown>): ScenarioReference {
  return {
    provider: typeof value.provider === "string" ? value.provider : UNITY_SCENARIO_PROVIDER,
    version: typeof value.version === "string" ? value.version : "1",
    path: typeof value.path === "string" ? value.path : "Assets/GameFactory/scenario.json",
    ...(value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters)
      ? { parameters: value.parameters as Record<string, unknown> }
      : {})
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function proofConfig(value: unknown): UnityEmbodiedProofConfig | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  const number = (key: keyof UnityEmbodiedProofConfig, fallback: number, minimum: number): number => {
    const candidate = raw[key] ?? fallback;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum) {
      throw new Error(`parameters.unity.embodiedProof.${key} must be a finite number at least ${minimum}`);
    }
    return candidate;
  };
  return {
    minimumDurationSeconds: number("minimumDurationSeconds", 1, 0),
    minimumShippingInputEvents: number("minimumShippingInputEvents", 2, 1),
    minimumDisplacementUnits: number("minimumDisplacementUnits", 0.25, 0),
    minimumSpatialInteractions: number("minimumSpatialInteractions", 1, 1),
    minimumStateConsequences: number("minimumStateConsequences", 1, 1),
    minimumDistinctFrames: number("minimumDistinctFrames", 3, 2)
  };
}

function config(campaign: Campaign): UnityConfig {
  const value = object(campaign.parameters?.unity);
  const scenarios: UnityConfig["scenarios"] = [];
  if (value.scenarios !== undefined) {
    if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 16) {
      throw new Error("parameters.unity.scenarios must contain from 1 to 16 named scenarios");
    }
    for (const [index, rawScenario] of value.scenarios.entries()) {
      const record = object(rawScenario);
      if (typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.id)) {
        throw new Error(`parameters.unity.scenarios[${index}].id is invalid`);
      }
      scenarios.push({ id: record.id, reference: scenarioReference(record) });
    }
    if (new Set(scenarios.map((item) => item.id)).size !== scenarios.length) {
      throw new Error("parameters.unity.scenarios contains duplicate ids");
    }
  } else {
    scenarios.push({ id: "primary", reference: scenarioReference(object(value.scenario)) });
  }
  return {
    cli: typeof value.cli === "string" ? value.cli : process.env.UNITY_CLI ?? "unity",
    ...(typeof value.projectPath === "string" ? { projectPath: value.projectPath } : {}),
    timeoutSeconds: typeof value.timeoutSeconds === "number" && value.timeoutSeconds > 0 ? value.timeoutSeconds : 180,
    importCheck: value.importCheck !== false,
    command: typeof value.command === "string" && value.command.length > 0 ? value.command : "gamefactory_run_scenario",
    prepareCommand: typeof value.prepareCommand === "string" && value.prepareCommand.length > 0 ? value.prepareCommand : "gamefactory_prepare_playmode",
    connectedEditor: value.connectedEditor === true,
    bridgePath: typeof value.bridgePath === "string" && value.bridgePath.length > 0 ? value.bridgePath : DEFAULT_UNITY_BRIDGE_ROOT,
    scenarios,
    ...(value.embodiedProof !== undefined ? { embodiedProof: proofConfig(value.embodiedProof)! } : {})
  };
}

function projectRoot(settings: UnityConfig, fallback: string): string {
  return resolve(settings.projectPath ?? fallback);
}

export function unityImportArgs(project: string, timeoutSeconds: number, logPath: string): string[] {
  return [
    "--non-interactive", "--format", "ndjson",
    "run", project,
    "--timeout", String(timeoutSeconds),
    "--", "-logFile", logPath
  ];
}

export function unityPrepareArgs(project: string, command: string, timeoutSeconds: number, statePath: string, connectedEditor = false): string[] {
  return connectedEditor
    ? ["--non-interactive", "--format", "ndjson", "command", command, "--project-path", project, "--timeout", String(timeoutSeconds), "--", "--state", statePath]
    : ["--non-interactive", "--format", "ndjson", "run", project, "--command", command, "--timeout", String(timeoutSeconds), "--", "--state", statePath];
}

export function unityScenarioArgs(project: string, command: string, timeoutSeconds: number, requestPath: string, resultPath: string, connectedEditor = false): string[] {
  if (connectedEditor) {
    return [
      "--non-interactive", "--format", "ndjson",
      "command", command,
      "--project-path", project,
      "--timeout", String(timeoutSeconds),
      "--", "--request", requestPath, "--output", resultPath
    ];
  }
  return [
    "--non-interactive", "--format", "ndjson",
    "run", project,
    "--command", command,
    "--timeout", String(timeoutSeconds),
    "--", "--request", requestPath, "--output", resultPath
  ];
}

export function unityOpenArgs(project: string): string[] {
  return ["--non-interactive", "--format", "json", "open", project];
}

export function unityStatusArgs(project: string): string[] {
  return ["--non-interactive", "--format", "json", "status", "--project-path", project];
}

export const executeUnity: UnityProcessRunner = async (binary, args, cwd, signal, timeoutSeconds) => new Promise((resolvePromise, reject) => {
  const child = spawn(binary, args, { cwd, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, UNITY_NO_CONSENT_PROMPT: "1" } });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const terminateTree = (): void => {
    if (!child.pid) { child.kill(); return; }
    const pid = child.pid;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
      killer.on("exit", (code) => { if (code !== 0) child.kill(); });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
      const force = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } }, 2_000);
      force.unref();
    } catch { child.kill(); }
  };
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree();
  }, timeoutSeconds * 1000);
  const abort = () => terminateTree();
  signal.addEventListener("abort", abort, { once: true });
  child.on("error", (error) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reject(error);
  });
  child.on("exit", (exitCode) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    resolvePromise({ exitCode, stdout, stderr, timedOut });
  });
});

export const terminateUnityEditor: UnityProcessTerminator = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Refusing to terminate invalid Unity Editor PID ${pid}`);
  await new Promise<void>((resolvePromise, reject) => {
    if (process.platform === "win32") {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 || code === 128 ? resolvePromise() : reject(new Error(`taskkill exited ${code} for Unity Editor PID ${pid}`)));
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      resolvePromise();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") resolvePromise();
      else reject(error);
    }
  });
};

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function packageManifest(project: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(resolve(project, "Packages", "manifest.json"), "utf8")) as Record<string, unknown>;
    return object(parsed.dependencies) as Record<string, string>;
  } catch { return {}; }
}

const TRUSTED_BRIDGE_FILES = [
  "package.json",
  "Editor/GameFactory.UnityBridge.Editor.asmdef",
  "Editor/GameFactoryScenarioCommand.cs"
];

function localPackageCandidates(project: string, dependency: string): string[] {
  if (!dependency.startsWith("file:")) return [];
  const path = dependency.slice("file:".length);
  if (isAbsolute(path)) return [resolve(path)];
  return [resolve(project, path), resolve(project, "Packages", path)];
}

export async function resolveUnityBridgeAuthority(campaign: Campaign, candidateRoot = campaign.projectRoot): Promise<UnityBridgeAuthority> {
  const settings = config(campaign);
  const project = projectRoot(settings, candidateRoot);
  const expected = isAbsolute(settings.bridgePath) ? resolve(settings.bridgePath) : resolve(campaign.projectRoot, settings.bridgePath);
  const [canonicalCandidate, canonicalBridge] = await Promise.all([realpath(candidateRoot), realpath(expected)]);
  const bridgeTraversal = relative(canonicalCandidate, canonicalBridge);
  if (!bridgeTraversal || (!bridgeTraversal.startsWith("..\\") && !bridgeTraversal.startsWith("../") && bridgeTraversal !== ".." && !isAbsolute(bridgeTraversal))) {
    throw new Error("The trusted Unity bridge must live outside the candidate workspace");
  }
  const dependency = (await packageManifest(project))["com.gamefactory.bridge"];
  if (typeof dependency !== "string") throw new Error("Packages/manifest.json must declare com.gamefactory.bridge");
  const declared = await Promise.all(localPackageCandidates(project, dependency).map(async (path) => realpath(path).catch(() => undefined)));
  if (!declared.includes(canonicalBridge)) throw new Error("com.gamefactory.bridge must reference the configured host-owned bridge path");
  const digest = createHash("sha256");
  for (const path of TRUSTED_BRIDGE_FILES) {
    digest.update(path.replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(await readFile(resolve(canonicalBridge, path)));
    digest.update("\0");
  }
  return { root: canonicalBridge, sha256: digest.digest("hex") };
}

async function projectVersion(project: string): Promise<string | undefined> {
  try {
    const source = await readFile(resolve(project, "ProjectSettings", "ProjectVersion.txt"), "utf8");
    return /^m_EditorVersion:\s*(\S+)/m.exec(source)?.[1];
  } catch { return undefined; }
}

function unitySix(version: string | undefined): boolean {
  if (!version) return false;
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 6000;
}

const UNITY_LOG_ERROR = /(?:\berror CS\d+:|Scripts have compiler errors|Compilation failed|Aborting batchmode due to failure|Unhandled Exception|^\s*Error:\s)/im;

export function unityLogHasErrors(content: string): boolean {
  return UNITY_LOG_ERROR.test(content);
}

async function processLogs(directory: string, prefix: string, result: UnityProcessResult): Promise<ArtifactReference[]> {
  await mkdir(directory, { recursive: true });
  const stdoutPath = resolve(directory, `${prefix}.stdout.log`);
  const stderrPath = resolve(directory, `${prefix}.stderr.log`);
  await Promise.all([writeFile(stdoutPath, redactUnitySecrets(result.stdout), "utf8"), writeFile(stderrPath, redactUnitySecrets(result.stderr), "utf8")]);
  return [
    { kind: "log", path: stdoutPath, mediaType: "text/plain", label: `${prefix} stdout`, metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity" } },
    { kind: "log", path: stderrPath, mediaType: "text/plain", label: `${prefix} stderr`, metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity" } }
  ];
}

export function redactUnitySecrets(content: string): string {
  return content.replace(/((?:--?)?access[-_]?token(?:=|\s+))([^\s]+)/gi, "$1[REDACTED]");
}

function pipelineServerBusy(result: UnityProcessResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return /503 Service Unavailable/i.test(output) && /Server Busy|still settling|not serviceable yet/i.test(output);
}

function combineProcessResults(results: UnityProcessResult[]): UnityProcessResult {
  const final = results.at(-1) ?? { exitCode: null, stdout: "", stderr: "", timedOut: false };
  const join = (key: "stdout" | "stderr"): string => results
    .map((result, index) => result[key].length > 0 ? `--- attempt ${index + 1} ---\n${result[key]}` : "")
    .filter(Boolean)
    .join("\n");
  return { ...final, stdout: join("stdout"), stderr: join("stderr") };
}

function jsonDocuments(output: string): unknown[] {
  const documents: unknown[] = [];
  try { documents.push(JSON.parse(output)); } catch { /* fall through to NDJSON */ }
  if (documents.length === 0) {
    for (const line of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try { documents.push(JSON.parse(line)); } catch { /* diagnostic text */ }
    }
  }
  return documents;
}

export function unityEditorPid(output: string): number | undefined {
  const visit = (value: unknown): number | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const record = object(value);
    for (const key of ["pid", "processId", "process_id"]) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
      if (typeof candidate === "string" && /^[1-9]\d*$/.test(candidate)) return Number.parseInt(candidate, 10);
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const document of jsonDocuments(output)) {
    const found = visit(document);
    if (found !== undefined) return found;
  }
  return undefined;
}

export class UnityEngine implements EngineDriver {
  readonly id = "unity.engine";
  constructor(private readonly runProcess: UnityProcessRunner = executeUnity) {}

  async doctor(context: ProjectContext): Promise<DoctorResult> {
    const settings = config(context.campaign);
    const root = projectRoot(settings, context.projectRoot);
    const version = await projectVersion(root);
    const dependencies = await packageManifest(root);
    let cliOk = false;
    let cliMessage = `Unity CLI not found at ${settings.cli}`;
    let authOk = false;
    let authMessage = "Unity CLI authentication has not been verified";
    try {
      const result = await this.runProcess(settings.cli, ["--version"], root, context.signal, 15);
      cliOk = result.exitCode === 0 && !result.timedOut;
      cliMessage = cliOk ? `Unity CLI ${result.stdout.trim() || "available"}` : (result.stderr.trim() || cliMessage);
    } catch (error) { cliMessage = error instanceof Error ? error.message : String(error); }
    if (cliOk) {
      try {
        const result = await this.runProcess(settings.cli, ["auth", "status"], root, context.signal, 30);
        authOk = result.exitCode === 0 && !result.timedOut;
        authMessage = authOk ? (result.stdout.trim() || "Unity CLI authentication is active") : (result.stderr.trim() || "Run unity auth login");
      } catch (error) { authMessage = error instanceof Error ? error.message : String(error); }
    }
    const projectOk = Boolean(version);
    const pipeline = typeof dependencies["com.unity.pipeline"] === "string";
    let bridgeAuthority: UnityBridgeAuthority | undefined;
    let bridgeMessage = "Unity bridge trust has not been verified";
    try {
      bridgeAuthority = await resolveUnityBridgeAuthority(context.campaign, context.projectRoot);
      bridgeMessage = `Host-owned com.gamefactory.bridge ${bridgeAuthority.sha256.slice(0, 12)}`;
    } catch (error) { bridgeMessage = error instanceof Error ? error.message : String(error); }
    const inputSystem = typeof dependencies["com.unity.inputsystem"] === "string";
    const checks = [
      { name: "unity.cli", ok: cliOk, message: cliMessage },
      { name: "unity.auth", ok: authOk, message: authMessage },
      { name: "unity.project", ok: projectOk, message: version ? `Unity project ${version}` : "ProjectSettings/ProjectVersion.txt is missing" },
      { name: "unity.version", ok: unitySix(version), message: version ? `Editor ${version}` : "Unity 6.0 or later is required" },
      { name: "unity.pipeline", ok: pipeline, message: pipeline ? `com.unity.pipeline ${dependencies["com.unity.pipeline"]}` : "Run unity pipeline install --project-path <project>" },
      { name: "unity.bridge", ok: Boolean(bridgeAuthority), message: bridgeMessage },
      { name: "unity.input-system", ok: inputSystem, message: inputSystem ? `com.unity.inputsystem ${dependencies["com.unity.inputsystem"]}` : "Trusted input injection requires com.unity.inputsystem" }
    ];
    return { ok: checks.every((check) => check.ok), checks };
  }

  async build(context: CandidateContext): Promise<ExecutionResult> {
    const settings = config(context.campaign);
    const root = projectRoot(settings, context.candidate.root);
    const output = resolve(context.candidate.root, ".factory", "runs", context.experimentId, "engine-evidence");
    await mkdir(output, { recursive: true });
    const logPath = resolve(output, "unity-import.log");
    const privateLogRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-unity-import-"));
    const privateLogPath = resolve(privateLogRoot, "unity-import.raw.log");
    try {
      const rawResult = await this.runProcess(settings.cli, unityImportArgs(root, settings.timeoutSeconds, privateLogPath), root, context.signal, settings.timeoutSeconds + 15);
      const result = { ...rawResult, stdout: redactUnitySecrets(rawResult.stdout), stderr: redactUnitySecrets(rawResult.stderr) };
      const artifacts = await processLogs(output, "unity-import", result);
      const importLog = redactUnitySecrets(await readFile(privateLogPath, "utf8").catch(() => ""));
      if (importLog) await writeFile(logPath, importLog, "utf8");
      if (importLog) artifacts.push({ kind: "log", path: logPath, mediaType: "text/plain", label: "Unity import log", metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity" } });
      const hiddenErrors = unityLogHasErrors(`${result.stdout}\n${result.stderr}\n${importLog}`);
      const ok = result.exitCode === 0 && !result.timedOut && !hiddenErrors;
      return {
        ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: [
          result.stderr,
          hiddenErrors ? "Unity logs contain compiler or batch-mode errors despite a successful launcher exit." : "",
          result.timedOut ? "Unity import process timed out." : ""
        ].filter(Boolean).join("\n"),
        artifacts,
        metrics: { import_ok: ok ? 1 : 0, unity_process_timed_out: result.timedOut ? 1 : 0 }
      };
    } catch (error) {
      return { ok: false, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), artifacts: [], metrics: { import_ok: 0, unity_process_launch_failed: 1 } };
    } finally {
      await rm(privateLogRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

function contained(root: string, value: string, label: string): string {
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const traversal = relative(resolve(root), target);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) {
    throw new Error(`${label} must resolve beneath ${root}`);
  }
  return target;
}

async function normalizeArtifacts(value: unknown, output: string, authority: UnityBridgeAuthority): Promise<{ artifacts: ArtifactReference[]; violations: Violation[] }> {
  if (!Array.isArray(value)) return { artifacts: [], violations: [{ code: "unity.artifact.list", message: "Scenario artifacts must be an array.", severity: "error" }] };
  const artifacts: ArtifactReference[] = [];
  const violations: Violation[] = [];
  const canonicalOutput = await realpath(output);
  for (const [index, item] of value.entries()) {
    const record = object(item);
    if (typeof record.path !== "string" || typeof record.kind !== "string") {
      violations.push({ code: `unity.artifact.${index}.shape`, message: "Artifact requires path and kind.", severity: "error" });
      continue;
    }
    try {
      const requested = contained(output, record.path, `artifact ${index}`);
      const canonical = await realpath(requested);
      const traversal = relative(canonicalOutput, canonical);
      if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error("outside output");
      const kind = ARTIFACT_KINDS.has(record.kind as ArtifactReference["kind"]) ? record.kind as ArtifactReference["kind"] : "other";
      artifacts.push({
        kind,
        path: canonical,
        sha256: await fileSha256(canonical),
        ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
        ...(typeof record.label === "string" ? { label: record.label } : {}),
        metadata: { ...object(record.metadata), evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity", trustedBridgeSha256: authority.sha256 }
      });
      if (kind === "other" && record.kind !== "other") violations.push({ code: `unity.artifact.${index}.kind`, message: `Normalized unsupported artifact kind ${record.kind} to other.`, severity: "warning" });
    } catch {
      violations.push({ code: `unity.artifact.${index}.containment`, message: "Scenario artifact must resolve beneath the factory-owned output directory.", severity: "error" });
    }
  }
  return { artifacts, violations };
}

function position(value: unknown): { x: number; y: number; z: number } | undefined {
  const record = object(value);
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const z = finiteNumber(record.z) ?? 0;
  return x === undefined || y === undefined ? undefined : { x, y, z };
}

export async function verifyUnityEmbodiedArtifacts(
  artifacts: ArtifactReference[],
  requirements: UnityEmbodiedProofConfig,
  authority?: UnityBridgeAuthority
): Promise<{ verified: boolean; metrics: Record<string, number>; violations: Violation[] }> {
  if (!authority) return { verified: false, metrics: { embodied_proof: 0 }, violations: [{ code: "unity.embodied.untrusted-authority", message: "Embodied proof requires a verified host-owned Unity bridge.", severity: "error" }] };
  const traceArtifact = artifacts.find((artifact) =>
    (artifact.kind === "replay" || artifact.kind === "telemetry")
    && artifact.metadata?.protocol === EMBODIED_TRACE_PROTOCOL);
  if (!traceArtifact) return { verified: false, metrics: { embodied_proof: 0 }, violations: [{ code: "unity.embodied.trace-missing", message: `Embodied proof requires ${EMBODIED_TRACE_PROTOCOL}.`, severity: "error" }] };
  let trace: Record<string, unknown>;
  try { trace = object(JSON.parse(await readFile(traceArtifact.path, "utf8"))); }
  catch { return { verified: false, metrics: { embodied_proof: 0 }, violations: [{ code: "unity.embodied.trace-invalid", message: "Embodied trace is missing or malformed JSON.", severity: "error" }] }; }
  if (trace.apiVersion !== EMBODIED_TRACE_PROTOCOL || trace.producer !== UNITY_EVIDENCE_PRODUCER || traceArtifact.metadata?.producer !== UNITY_EVIDENCE_PRODUCER || traceArtifact.metadata?.trustedBridgeSha256 !== authority.sha256) {
    return { verified: false, metrics: { embodied_proof: 0 }, violations: [{ code: "unity.embodied.untrusted-producer", message: "Embodied evidence was not produced by the factory-owned Unity bridge.", severity: "error" }] };
  }
  const samples = Array.isArray(trace.samples) ? trace.samples : [];
  let firstTime: number | undefined;
  let lastTime: number | undefined;
  let origin: { x: number; y: number; z: number } | undefined;
  let displacement = 0;
  let shippingInputs = 0;
  let visibleSamples = 0;
  let spatialInteractions = 0;
  let stateConsequences = 0;
  let chronological = true;
  for (const raw of samples) {
    const sample = object(raw);
    const time = finiteNumber(sample.time);
    if (time !== undefined) {
      if (lastTime !== undefined && time < lastTime) chronological = false;
      firstTime ??= time;
      lastTime = time;
    }
    const actor = object(sample.actor);
    const actorPosition = position(actor.position);
    if (actor.visible === true) visibleSamples += 1;
    if (actorPosition) {
      origin ??= actorPosition;
      displacement = Math.max(displacement, Math.hypot(actorPosition.x - origin.x, actorPosition.y - origin.y, actorPosition.z - origin.z));
    }
    const input = object(sample.input);
    if (input.delivery === "unity-input-system" && typeof input.control === "string") shippingInputs += 1;
    if (Array.isArray(sample.events)) for (const rawEvent of sample.events) {
      const event = object(rawEvent);
      if (event.kind === "spatial-interaction" && event.outcome === "applied") spatialInteractions += 1;
      if (event.kind === "state-change" && event.cause === "player-input" && typeof event.state === "string") stateConsequences += 1;
    }
  }
  const hashes = new Set<string>();
  for (const artifact of artifacts.filter((candidate) => candidate.kind === "image" && candidate.metadata?.evidenceRole === "continuous-frame")) {
    try { hashes.add(createHash("sha256").update(await readFile(artifact.path)).digest("hex")); } catch { /* count remains conservative */ }
  }
  const duration = firstTime === undefined || lastTime === undefined ? 0 : lastTime - firstTime;
  const violations: Violation[] = [];
  if (samples.length < 2) violations.push({ code: "unity.embodied.samples", message: "Embodied trace requires at least two samples.", severity: "error" });
  if (!chronological) violations.push({ code: "unity.embodied.chronology", message: "Embodied trace samples are not chronological.", severity: "error" });
  if (duration < requirements.minimumDurationSeconds) violations.push({ code: "unity.embodied.duration", message: `Capture lasts ${duration.toFixed(2)}s; expected at least ${requirements.minimumDurationSeconds}s.`, severity: "error" });
  if (shippingInputs < requirements.minimumShippingInputEvents) violations.push({ code: "unity.embodied.shipping-input", message: `Observed ${shippingInputs} Unity Input System events; expected ${requirements.minimumShippingInputEvents}.`, severity: "error" });
  if (visibleSamples === 0) violations.push({ code: "unity.embodied.actor-visible", message: "No sample establishes a visible player-controlled actor.", severity: "error" });
  if (displacement < requirements.minimumDisplacementUnits) violations.push({ code: "unity.embodied.displacement", message: `Actor displacement was ${displacement.toFixed(3)} units; expected at least ${requirements.minimumDisplacementUnits}.`, severity: "error" });
  if (spatialInteractions < requirements.minimumSpatialInteractions) violations.push({ code: "unity.embodied.spatial-interaction", message: `Observed ${spatialInteractions} attributable spatial interactions; expected ${requirements.minimumSpatialInteractions}.`, severity: "error" });
  if (stateConsequences < requirements.minimumStateConsequences) violations.push({ code: "unity.embodied.consequence", message: `Observed ${stateConsequences} input-caused consequences; expected ${requirements.minimumStateConsequences}.`, severity: "error" });
  if (hashes.size < requirements.minimumDistinctFrames) violations.push({ code: "unity.embodied.visible-motion", message: `Continuous evidence contains ${hashes.size} distinct frames; expected ${requirements.minimumDistinctFrames}.`, severity: "error" });
  const verified = !violations.some((violation) => violation.severity === "error");
  return { verified, metrics: { embodied_proof: verified ? 1 : 0, embodied_duration_seconds: duration, embodied_shipping_inputs: shippingInputs, embodied_visible_samples: visibleSamples, embodied_displacement_units: displacement, embodied_spatial_interactions: spatialInteractions, embodied_state_consequences: stateConsequences, embodied_distinct_frames: hashes.size }, violations };
}

export class UnityScenarioRunner implements ScenarioRunner {
  readonly id = "unity.scenario";
  private readonly ownedEditors = new Map<string, number>();
  constructor(
    private readonly runProcess: UnityProcessRunner = executeUnity,
    private readonly wait: UnityWait = async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    },
    private readonly terminateProcess: UnityProcessTerminator = terminateUnityEditor
  ) {}

  private async ensureProjectEditor(binary: string, root: string, signal: AbortSignal, timeoutSeconds: number): Promise<void> {
    if (this.ownedEditors.has(root)) return;
    const opened = await this.runProcess(binary, unityOpenArgs(root), root, signal, Math.min(timeoutSeconds, 60));
    if (opened.exitCode !== 0 || opened.timedOut) {
      throw new Error(`Unity Editor launch failed with exit code ${opened.exitCode}. ${opened.stderr || opened.stdout}`.trim());
    }
    const statusAttempts: UnityProcessResult[] = [];
    const maximumAttempts = Math.max(8, Math.ceil(timeoutSeconds / 2));
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const status = await this.runProcess(binary, unityStatusArgs(root), root, signal, 15);
      statusAttempts.push(status);
      const pid = status.exitCode === 0 && !status.timedOut ? unityEditorPid(status.stdout) : undefined;
      if (pid !== undefined) {
        this.ownedEditors.set(root, pid);
        return;
      }
      if (status.timedOut || signal.aborted) break;
      const detail = `${status.stdout}\n${status.stderr}`;
      const starting = /STATUS_NO_INSTANCES|No Unity Editor instances|503 Service Unavailable|Server Busy|settling|connection (?:failed|refused)/i.test(detail);
      if (!starting) break;
      await this.wait(2_000, signal);
    }
    const combined = combineProcessResults(statusAttempts);
    throw new Error(`Unity Editor did not become Pipeline-ready after one launch. ${combined.stderr || combined.stdout}`.trim());
  }

  async releaseProject(root: string): Promise<void> {
    const canonical = resolve(root);
    const pid = this.ownedEditors.get(canonical);
    if (pid === undefined) return;
    this.ownedEditors.delete(canonical);
    await this.terminateProcess(pid);
  }

  async dispose(): Promise<void> {
    const editors = [...this.ownedEditors.values()];
    this.ownedEditors.clear();
    await Promise.allSettled(editors.map((pid) => this.terminateProcess(pid)));
  }

  private async runPipelineWhenReady(binary: string, args: string[], cwd: string, signal: AbortSignal, timeoutSeconds: number): Promise<UnityProcessResult> {
    const attempts: UnityProcessResult[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const result = await this.runProcess(binary, args, cwd, signal, timeoutSeconds);
      attempts.push(result);
      if (!pipelineServerBusy(result) || result.timedOut || signal.aborted || attempt === 8) {
        return combineProcessResults(attempts);
      }
      await this.wait(1_000, signal);
    }
    return combineProcessResults(attempts);
  }

  async run(input: CandidateContext & { scenario: ScenarioReference }): Promise<ScenarioResult> {
    const settings = config(input.campaign);
    if (input.scenario.provider !== UNITY_SCENARIO_PROVIDER) return { status: "fail", metrics: {}, artifacts: [], violations: [{ code: "unity.scenario.provider", message: `Expected ${UNITY_SCENARIO_PROVIDER}.`, severity: "error" }] };
    const root = projectRoot(settings, input.candidate.root);
    let authority: UnityBridgeAuthority;
    try {
      authority = await resolveUnityBridgeAuthority(input.campaign, input.candidate.root);
    } catch (error) {
      return { status: "fail", metrics: {}, artifacts: [], violations: [{ code: "unity.bridge.untrusted", message: error instanceof Error ? error.message : String(error), severity: "error" }] };
    }
    let scenarioPath: string;
    try {
      scenarioPath = contained(input.candidate.root, input.scenario.path, "Unity scenario path");
      await access(scenarioPath);
    } catch (error) {
      return { status: "fail", metrics: {}, artifacts: [], violations: [{ code: "unity.scenario.contract", message: error instanceof Error ? error.message : String(error), severity: "error" }] };
    }
    const output = resolve(input.candidate.root, ".factory", "runs", input.experimentId, "engine-evidence");
    await mkdir(output, { recursive: true });
    const requestPath = resolve(output, "request.json");
    const resultPath = resolve(output, "result.json");
    const playModeStatePath = resolve(output, "playmode-settings.json");
    await writeFile(requestPath, `${JSON.stringify({ apiVersion: UNITY_SCENARIO_PROVIDER, scenarioPath, outputDirectory: output, playModeStatePath, parameters: input.scenario.parameters ?? {} }, null, 2)}\n`, "utf8");
    let processResult: UnityProcessResult;
    let artifacts: ArtifactReference[] = [];
    try {
      if (!settings.connectedEditor) await this.ensureProjectEditor(settings.cli, root, input.signal, settings.timeoutSeconds);
      const preparation = await this.runPipelineWhenReady(settings.cli, unityPrepareArgs(root, settings.prepareCommand, settings.timeoutSeconds, playModeStatePath, true), root, input.signal, settings.timeoutSeconds + 30);
      artifacts = await processLogs(output, "unity-playmode-prepare", preparation);
      if (preparation.exitCode !== 0 || preparation.timedOut) {
        return { status: "crash", metrics: {}, artifacts, violations: [{ code: "unity.playmode.prepare", message: `Unity play-mode preparation failed with exit code ${preparation.exitCode}.${settings.connectedEditor ? " Confirm the Editor is open and Pipeline status is ready." : ""}`, severity: "error" }] };
      }
      processResult = await this.runPipelineWhenReady(settings.cli, unityScenarioArgs(root, settings.command, settings.timeoutSeconds, requestPath, resultPath, true), root, input.signal, settings.timeoutSeconds + 30);
    } catch (error) {
      return { status: "crash", metrics: {}, artifacts, violations: [{ code: "unity.launch", message: error instanceof Error ? error.message : String(error), severity: "error" }] };
    }
    artifacts.push(...await processLogs(output, "unity-scenario", processResult));
    try {
      const raw = object(JSON.parse(await readFile(resultPath, "utf8")));
      const resultArtifact: ArtifactReference = { kind: "test-report", path: resultPath, mediaType: "application/json", label: "Unity scenario result", metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity" } };
      resultArtifact.sha256 = await fileSha256(resultPath);
      artifacts.push(resultArtifact);
      const normalized = await normalizeArtifacts(raw.artifacts, output, authority);
      artifacts.push(...normalized.artifacts);
      const embodied = settings.embodiedProof ? await verifyUnityEmbodiedArtifacts(normalized.artifacts, settings.embodiedProof, authority) : { verified: false, metrics: {}, violations: [] as Violation[] };
      if (embodied.verified) {
        const verification = { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity", evidenceClass: "embodied-gameplay", verified: true, protocol: EMBODIED_TRACE_PROTOCOL };
        resultArtifact.metadata = { ...(resultArtifact.metadata ?? {}), ...verification };
        const trace = normalized.artifacts.find((artifact) => (artifact.kind === "replay" || artifact.kind === "telemetry") && artifact.metadata?.protocol === EMBODIED_TRACE_PROTOCOL);
        if (trace) trace.metadata = { ...(trace.metadata ?? {}), ...verification };
      }
      const bridgeViolations = Array.isArray(raw.violations) ? raw.violations.filter((item): item is Violation => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).code === "string")) : [];
      const violations = [
        ...(processResult.exitCode === 0 && !processResult.timedOut ? [] : [{ code: "unity.process", message: `Unity command failed with exit code ${processResult.exitCode}.`, severity: "error" as const }]),
        ...bridgeViolations,
        ...normalized.violations,
        ...embodied.violations
      ];
      const rawStatus = raw.status === "pass" || raw.status === "fail" || raw.status === "crash" ? raw.status : "fail";
      const status = processResult.exitCode !== 0 || processResult.timedOut ? "crash" : violations.some((item) => item.severity === "error") ? "fail" : rawStatus;
      return { status, metrics: { ...object(raw.metrics) as Record<string, number>, ...embodied.metrics }, artifacts, violations, metadata: { ...object(raw.metadata), evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity", trustedBridgeSha256: authority.sha256 } };
    } catch {
      return { status: "crash", metrics: {}, artifacts, violations: [{ code: "unity.result.missing", message: `Unity exited ${processResult.exitCode} without a valid result.json.`, severity: "error" }], metadata: { timedOut: processResult.timedOut } };
    }
  }
}

async function configuredEvidence(input: { campaign: Campaign; candidate: Candidate; experimentId: string; signal: AbortSignal; runner: ScenarioRunner }): Promise<ScenarioResult & { scenarios: Array<{ id: string; status: ScenarioResult["status"] }> }> {
  const settings = config(input.campaign);
  const artifacts: ArtifactReference[] = [];
  const violations: Violation[] = [];
  const metrics: Record<string, number> = {};
  const scenarios: Array<{ id: string; status: ScenarioResult["status"] }> = [];
  let status: ScenarioResult["status"] = "pass";
  try {
    for (const [index, configured] of settings.scenarios.entries()) {
      const result = await input.runner.run({ campaign: input.campaign, projectRoot: input.candidate.root, candidate: input.candidate, experimentId: `${input.experimentId}-${configured.id}`, scenario: configured.reference, signal: input.signal });
      artifacts.push(...result.artifacts.map((artifact) => ({
        ...artifact,
        metadata: { ...(artifact.metadata ?? {}), scenarioId: configured.id }
      })));
      scenarios.push({ id: configured.id, status: result.status });
      for (const [name, value] of Object.entries(result.metrics)) {
        if (settings.scenarios.length > 1) metrics[`${configured.id}.${name}`] = value;
        if (index === 0) metrics[name] = value;
      }
      violations.push(...result.violations.map((violation) => ({ ...violation, code: `unity.scenario.${configured.id}.${violation.code}` })));
      if (result.status === "crash") status = "crash";
      else if (result.status === "fail" && status !== "crash") status = "fail";
    }
  } finally {
    if (input.runner instanceof UnityScenarioRunner && !settings.connectedEditor) {
      await input.runner.releaseProject(projectRoot(settings, input.candidate.root));
    }
  }
  if (settings.scenarios.length > 1) {
    metrics.scenarios_total = settings.scenarios.length;
    metrics.scenarios_passed = scenarios.filter((item) => item.status === "pass").length;
  }
  return { status, metrics, artifacts, violations, scenarios };
}

export class UnityScenarioEvaluator implements Evaluator {
  readonly id = "unity.scenario";
  readonly version = "1.0.0";
  constructor(private readonly engine: EngineDriver, private readonly scenarios: ScenarioRunner) {}
  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    const settings = config(input.campaign);
    const artifacts: ArtifactReference[] = [];
    if (settings.importCheck && this.engine.build) {
      const built = await this.engine.build({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: input.experimentId, signal: input.signal });
      artifacts.push(...built.artifacts);
      if (!built.ok) return { evaluator: this.id, version: this.version, status: "fail", metrics: built.metrics ?? { import_ok: 0 }, violations: [{ code: "unity.import", message: "Unity import or compile validation failed.", severity: "error" }], artifacts, confidence: 1, summary: "Stopped at the Unity import gate." };
    }
    const run = await configuredEvidence({ campaign: input.campaign, candidate, experimentId: input.experimentId, signal: input.signal, runner: this.scenarios });
    artifacts.push(...run.artifacts);
    return { evaluator: this.id, version: this.version, status: run.status === "pass" ? "pass" : "fail", metrics: { import_ok: 1, ...run.metrics }, violations: run.violations, artifacts, confidence: run.status === "crash" ? 0 : 1, summary: run.status === "pass" ? `${run.scenarios.length} configured Unity scenario(s) passed.` : `Configured Unity scenarios ${run.status}.` };
  }
}

export class UnityEvidenceAgent implements AgentDriver {
  readonly id = "unity.evidence";
  readonly writePaths = ["evidence/**"] as const;
  constructor(private readonly engine: EngineDriver, private readonly scenarios: ScenarioRunner) {}
  async run(request: Parameters<AgentDriver["run"]>[0]): Promise<AgentResult> {
    const settings = config(request.campaign);
    const artifacts: ArtifactReference[] = [];
    if (settings.importCheck && this.engine.build) {
      const built = await this.engine.build({ campaign: request.campaign, projectRoot: request.candidate.root, candidate: request.candidate, experimentId: request.experimentId, signal: request.signal });
      artifacts.push(...built.artifacts);
      if (!built.ok) {
        const detail = [built.stderr, built.stdout].filter(Boolean).join("\n").trim();
        const infrastructure = built.exitCode === null
          || built.metrics?.unity_process_timed_out === 1
          || built.metrics?.unity_process_launch_failed === 1
          || /licen[cs]|ipc|authentication|editor .*busy|connection (?:failed|refused)|timed? out/i.test(detail);
        if (infrastructure) {
          const error = new InfrastructureFailureError(`Unity import infrastructure failed before scenario evidence.${detail ? ` ${detail}` : ""}`) as InfrastructureFailureError & { artifacts: ArtifactReference[] };
          error.artifacts = artifacts;
          throw error;
        }
        return {
          summary: `Unity import or compile validation failed before scenario evidence.${detail ? ` ${detail}` : ""}`,
          artifacts,
          metadata: {
            outcome: "revise",
            structured: {
              status: "fail",
              metrics: built.metrics ?? { import_ok: 0 },
              violations: [{ code: "unity.import", message: "Unity import or compile validation failed.", severity: "error" }]
            },
            evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY,
            engine: "unity"
          }
        };
      }
    }
    const run = await configuredEvidence({ campaign: request.campaign, candidate: request.candidate, experimentId: request.experimentId, signal: request.signal, runner: this.scenarios });
    artifacts.push(...run.artifacts);
    const output = resolve(request.candidate.root, ".factory", "runs", request.experimentId, "engine-evidence");
    await mkdir(output, { recursive: true });
    const manifestPath = resolve(output, "result.json");
    const candidateSnapshot = await unityCandidateSnapshot(request.candidate);
    const scenarioBundles = run.scenarios.map((scenario) => {
      const scenarioArtifacts = artifacts.filter((artifact) => artifact.metadata?.scenarioId === scenario.id);
      const trace = scenarioArtifacts.find((artifact) => artifact.kind === "replay" || artifact.kind === "telemetry");
      const frames = scenarioArtifacts
        .filter((artifact) => artifact.kind === "image" && artifact.metadata?.evidenceRole === "continuous-frame")
        .sort((left, right) => Number(left.metadata?.frame ?? 0) - Number(right.metadata?.frame ?? 0));
      return {
        id: scenario.id,
        status: scenario.status,
        ...(trace ? { trace: { path: trace.path, sha256: trace.sha256 } } : {}),
        frames: frames.map((frame, sampleIndex) => ({ path: frame.path, sha256: frame.sha256, frame: frame.metadata?.frame, sampleIndex }))
      };
    });
    await writeFile(manifestPath, `${JSON.stringify({ apiVersion: "gamefactory.engine-evidence/v1", evaluator: "unity.scenario", engine: "unity", evidenceRunId: request.experimentId, candidateSnapshot, status: run.status, metrics: run.metrics, violations: run.violations, scenarios: run.scenarios, scenarioBundles, artifacts }, null, 2)}\n`, "utf8");
    const manifest: ArtifactReference = { kind: "test-report", path: manifestPath, sha256: await fileSha256(manifestPath), mediaType: "application/json", label: "Fresh Unity evidence manifest", metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity", status: run.status, candidateSnapshotSha256: candidateSnapshot.sha256 } };
    artifacts.unshift(manifest);
    return { summary: run.status === "pass" ? `Fresh Unity evidence passed ${run.scenarios.length} scenario(s).` : `Fresh Unity evidence ${run.status}.`, artifacts, metadata: { outcome: run.status === "pass" ? "pass" : "fail", structured: { status: run.status, metrics: run.metrics, violations: run.violations, scenarios: run.scenarios }, evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY, engine: "unity" } };
  }
}

export default defineExtension((api) => {
  const engine = new UnityEngine();
  const scenarios = new UnityScenarioRunner();
  return combineDisposables(
    { dispose: () => scenarios.dispose() },
    api.register("engine", "unity.engine", engine),
    api.register("scenario", "unity.scenario", scenarios),
    api.register("agent", "unity.evidence", new UnityEvidenceAgent(engine, scenarios)),
    api.register("evaluator", "unity.scenario", new UnityScenarioEvaluator(engine, scenarios))
  );
});
