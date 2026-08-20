import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDriver, AgentResult, ArtifactReference, Campaign, Candidate, DoctorResult, EngineDriver, Evaluation, Evaluator, ExecutionResult, ScenarioReference, ScenarioResult, ScenarioRunner } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

interface GodotConfig {
  binary: string;
  importCheck: boolean;
  timeoutSeconds: number;
  rendered: boolean;
  scenarios: Array<{ id: string; reference: ScenarioReference }>;
  embodiedProof?: EmbodiedProofConfig;
  embodiedProbe?: Record<string, unknown>;
}

export interface EmbodiedProofConfig {
  minimumDurationSeconds: number;
  minimumShippingInputEvents: number;
  minimumDisplacementPixels: number;
  minimumSpatialInteractions: number;
  minimumStateConsequences: number;
  minimumDistinctFrames: number;
}

interface VisualViewConfig {
  id: string;
  path: string;
  baselineSha256?: string;
}

interface VisualSequenceConfig {
  id: string;
  paths: string[];
  minimumFrames: number;
}

interface VisualReviewConfig {
  reviewNode: string;
  minimumScore: number;
  minimumDimensionScore: number;
  requiredDimensions: string[];
  requiredViews: VisualViewConfig[];
  requiredSequences: VisualSequenceConfig[];
  minimumWidth: number;
  minimumHeight: number;
}

interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }

const ARTIFACT_KINDS = new Set<ArtifactReference["kind"]>([
  "image", "video", "audio", "replay", "telemetry", "profile", "test-report", "log", "build", "crash-dump", "other"
]);

const EMBODIED_TRACE_PROTOCOL = "gamefactory.embodied-trace/v1";
const EMBODIED_PROBE_PRODUCER = "factory-owned-godot-probe";

export function embodiedProbeScriptPath(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "runtime", "embodied_probe.gd");
}

function hasEmbodiedProbe(probe: unknown): probe is Record<string, unknown> {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) return false;
  const value = probe as Record<string, unknown>;
  return typeof value.actorPath === "string"
    && value.actorPath.length > 0
    && Array.isArray(value.steps)
    && value.steps.length > 0
    && Array.isArray(value.stateObservations)
    && value.stateObservations.length > 0;
}

function hasTemplatePlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /^__REPLACE_[A-Z0-9_]+__$/.test(value);
  if (Array.isArray(value)) return value.some(hasTemplatePlaceholder);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(hasTemplatePlaceholder);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function position(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

export async function verifyEmbodiedScenarioArtifacts(
  artifacts: ArtifactReference[],
  requirements: EmbodiedProofConfig,
  requiredProducer?: string
): Promise<{ verified: boolean; metrics: Record<string, number>; violations: ScenarioResult["violations"] }> {
  const violations: ScenarioResult["violations"] = [];
  const traceArtifact = artifacts.find((artifact) =>
    (artifact.kind === "replay" || artifact.kind === "telemetry")
    && artifact.metadata?.protocol === EMBODIED_TRACE_PROTOCOL);
  if (!traceArtifact) return {
    verified: false,
    metrics: { embodied_proof: 0 },
    violations: [{ code: "godot.embodied.trace-missing", message: `Embodied proof requires a replay or telemetry artifact using ${EMBODIED_TRACE_PROTOCOL}.`, severity: "error" }]
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(traceArtifact.path, "utf8"));
  } catch {
    return {
      verified: false,
      metrics: { embodied_proof: 0 },
      violations: [{ code: "godot.embodied.trace-invalid", message: "Embodied gameplay trace is missing or malformed JSON.", severity: "error" }]
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).apiVersion !== EMBODIED_TRACE_PROTOCOL) {
    return {
      verified: false,
      metrics: { embodied_proof: 0 },
      violations: [{ code: "godot.embodied.trace-protocol", message: `Embodied gameplay trace must declare ${EMBODIED_TRACE_PROTOCOL}.`, severity: "error" }]
    };
  }
  if (requiredProducer && (
    traceArtifact.metadata?.producer !== requiredProducer
    || (parsed as Record<string, unknown>).producer !== requiredProducer
  )) {
    return {
      verified: false,
      metrics: { embodied_proof: 0 },
      violations: [{ code: "godot.embodied.untrusted-producer", message: "Embodied gameplay evidence was not produced by the factory-owned Godot probe.", severity: "error" }]
    };
  }
  const samples = (parsed as Record<string, unknown>).samples;
  if (!Array.isArray(samples) || samples.length < 2) {
    return {
      verified: false,
      metrics: { embodied_proof: 0 },
      violations: [{ code: "godot.embodied.samples", message: "Embodied gameplay trace must contain at least two chronological samples.", severity: "error" }]
    };
  }

  let firstTime: number | undefined;
  let lastTime: number | undefined;
  let origin: { x: number; y: number } | undefined;
  let maximumDisplacement = 0;
  let shippingInputs = 0;
  let visibleSamples = 0;
  let spatialInteractions = 0;
  let stateConsequences = 0;
  let chronological = true;
  for (const item of samples) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const sample = item as Record<string, unknown>;
    const time = finiteNumber(sample.time);
    if (time !== undefined) {
      if (lastTime !== undefined && time < lastTime) chronological = false;
      firstTime ??= time;
      lastTime = time;
    }
    const actor = sample.actor && typeof sample.actor === "object" && !Array.isArray(sample.actor) ? sample.actor as Record<string, unknown> : undefined;
    const actorPosition = position(actor?.position);
    if (actor?.visible === true) visibleSamples += 1;
    if (actorPosition) {
      origin ??= actorPosition;
      maximumDisplacement = Math.max(maximumDisplacement, Math.hypot(actorPosition.x - origin.x, actorPosition.y - origin.y));
    }
    const input = sample.input && typeof sample.input === "object" && !Array.isArray(sample.input) ? sample.input as Record<string, unknown> : undefined;
    if (input?.delivery === "godot-input-event" && (input.kind === "axis" || input.kind === "action")) shippingInputs += 1;
    if (Array.isArray(sample.events)) for (const rawEvent of sample.events) {
      if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) continue;
      const event = rawEvent as Record<string, unknown>;
      if (event.kind === "spatial-interaction") {
        const distance = finiteNumber(event.distance);
        const range = finiteNumber(event.range);
        if (typeof event.targetId === "string" && distance !== undefined && range !== undefined && distance <= range && event.outcome === "applied") spatialInteractions += 1;
      }
      if (event.kind === "state-change" && event.cause === "player-input" && typeof event.state === "string") stateConsequences += 1;
    }
  }
  const duration = firstTime === undefined || lastTime === undefined ? 0 : lastTime - firstTime;
  const frameArtifacts = artifacts.filter((artifact) => artifact.kind === "image" && artifact.metadata?.evidenceRole === "continuous-frame");
  const frameHashes = new Set<string>();
  for (const artifact of frameArtifacts) {
    try { frameHashes.add(createHash("sha256").update(await readFile(artifact.path)).digest("hex")); } catch { /* normalized artifacts should exist; fail through count below */ }
  }

  if (!chronological) violations.push({ code: "godot.embodied.chronology", message: "Embodied gameplay samples are not chronological.", severity: "error" });
  if (duration < requirements.minimumDurationSeconds) violations.push({ code: "godot.embodied.duration", message: `Embodied capture lasts ${duration.toFixed(2)}s; expected at least ${requirements.minimumDurationSeconds}s.`, severity: "error" });
  if (shippingInputs < requirements.minimumShippingInputEvents) violations.push({ code: "godot.embodied.shipping-input", message: `Only ${shippingInputs} shipping InputEvent samples were observed; direct function replay is not acceptable.`, severity: "error" });
  if (visibleSamples === 0) violations.push({ code: "godot.embodied.actor-visible", message: "No trace sample establishes a visible player-controlled runtime actor.", severity: "error" });
  if (maximumDisplacement < requirements.minimumDisplacementPixels) violations.push({ code: "godot.embodied.displacement", message: `Visible actor displacement was ${maximumDisplacement.toFixed(2)}px; expected at least ${requirements.minimumDisplacementPixels}px.`, severity: "error" });
  if (spatialInteractions < requirements.minimumSpatialInteractions) violations.push({ code: "godot.embodied.spatial-interaction", message: `Only ${spatialInteractions} in-range runtime interactions were traced; expected ${requirements.minimumSpatialInteractions}.`, severity: "error" });
  if (stateConsequences < requirements.minimumStateConsequences) violations.push({ code: "godot.embodied.consequence", message: `Only ${stateConsequences} player-caused state consequences were traced; expected ${requirements.minimumStateConsequences}.`, severity: "error" });
  if (frameHashes.size < requirements.minimumDistinctFrames) violations.push({ code: "godot.embodied.visible-motion", message: `Continuous engine evidence contains ${frameHashes.size} distinct frame(s); expected at least ${requirements.minimumDistinctFrames}.`, severity: "error" });
  const verified = !violations.some((violation) => violation.severity === "error");
  return {
    verified,
    metrics: {
      embodied_proof: verified ? 1 : 0,
      embodied_duration_seconds: duration,
      embodied_shipping_inputs: shippingInputs,
      embodied_visible_samples: visibleSamples,
      embodied_displacement_pixels: maximumDisplacement,
      embodied_spatial_interactions: spatialInteractions,
      embodied_state_consequences: stateConsequences,
      embodied_distinct_frames: frameHashes.size
    },
    violations
  };
}

export async function normalizeScenarioArtifacts(value: unknown, allowedRoot?: string): Promise<{ artifacts: ArtifactReference[]; violations: ScenarioResult["violations"] }> {
  if (value === undefined) return { artifacts: [], violations: [] };
  if (!Array.isArray(value)) return {
    artifacts: [],
    violations: [{ code: "godot.artifact.list", message: "Scenario artifacts must be an array.", severity: "error" }]
  };
  const artifacts: ArtifactReference[] = [];
  const violations: ScenarioResult["violations"] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).path !== "string" || !(item as Record<string, unknown>).path) {
      violations.push({ code: `godot.artifact.${index}.path`, message: "Scenario artifact must contain a non-empty path.", severity: "error" });
      continue;
    }
    const record = item as Record<string, unknown>;
    const declaredKind = typeof record.kind === "string" ? record.kind : "other";
    const supported = ARTIFACT_KINDS.has(declaredKind as ArtifactReference["kind"]);
    let artifactPath = record.path as string;
    if (allowedRoot) {
      try {
        const requested = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(allowedRoot, artifactPath);
        const [canonicalRoot, canonicalArtifact] = await Promise.all([realpath(allowedRoot), realpath(requested)]);
        const traversal = relative(canonicalRoot, canonicalArtifact);
        if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error("outside scenario output");
        const bytes = await readFile(canonicalArtifact);
        if (declaredKind === "image" && (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) throw new Error("image artifact is not a PNG");
        if (declaredKind === "video") {
          const isMp4 = bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
          const isWebm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
          if (!isMp4 && !isWebm) throw new Error("video artifact is neither MP4 nor WebM");
        }
        artifactPath = canonicalArtifact;
      } catch {
        violations.push({ code: `godot.artifact.${index}.containment`, message: "Scenario artifact must resolve to a regular output beneath the factory-owned scenario directory.", severity: "error" });
        continue;
      }
    }
    const reference: ArtifactReference = {
      kind: supported ? declaredKind as ArtifactReference["kind"] : "other",
      path: artifactPath
    };
    if (typeof record.mediaType === "string") reference.mediaType = record.mediaType;
    if (typeof record.label === "string") reference.label = record.label;
    if (record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)) reference.metadata = { ...(record.metadata as Record<string, unknown>) };
    if (!supported) {
      reference.metadata = { ...(reference.metadata ?? {}), declaredKind };
      violations.push({ code: `godot.artifact.${index}.kind`, message: `Normalized unsupported scenario artifact kind ${declaredKind} to other.`, severity: "warning" });
    }
    artifacts.push(reference);
  }
  return { artifacts, violations };
}

// Factory runs are non-interactive and already preserve stderr and exit status.
// On Windows, a forcibly cancelled Godot process can otherwise enter the native
// crash handler and leave an Application Error dialog blocking later runs.
export function automationArgs(args: string[]): string[] {
  return ["--disable-crash-handler", ...args];
}

const GODOT_ERROR = /(?:SCRIPT ERROR:|PARSE ERROR:|\bERROR:|Cannot call method|Invalid call\.)/i;

export function godotProcessSucceeded(result: ProcessResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`
    // A locked-down Windows worker cannot query the machine certificate store.
    // Local imports and deterministic scenarios do not use TLS, so retain this
    // exact host diagnostic in stderr without converting it into a game failure.
    .replace(/ERROR: Failed to read the root certificate store\.\r?\n\s*at: get_system_ca_certificates \(platform\/windows\/os_windows\.cpp:\d+\)\r?\n?/g, "");
  return result.exitCode === 0 && !result.timedOut && !GODOT_ERROR.test(output);
}

function scenarioReference(value: Record<string, unknown>): ScenarioReference {
  return {
    provider: typeof value.provider === "string" ? value.provider : "godot.factory/v1",
    version: typeof value.version === "string" ? value.version : "1",
    path: typeof value.path === "string" ? value.path : "res://main.tscn",
    ...(value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters)
      ? { parameters: value.parameters as Record<string, unknown> }
      : {})
  };
}

function config(campaign: Campaign): GodotConfig {
  const raw = campaign.parameters?.godot;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const scenarioRaw = value.scenario && typeof value.scenario === "object" && !Array.isArray(value.scenario)
    ? value.scenario as Record<string, unknown>
    : {};
  let scenarios: GodotConfig["scenarios"];
  if (value.scenarios !== undefined) {
    if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 16) throw new Error("parameters.godot.scenarios must contain from 1 to 16 named scenarios");
    scenarios = value.scenarios.map((rawScenario, index) => {
      if (!rawScenario || typeof rawScenario !== "object" || Array.isArray(rawScenario)) throw new Error(`parameters.godot.scenarios[${index}] must be an object`);
      const record = rawScenario as Record<string, unknown>;
      if (typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.id)) throw new Error(`parameters.godot.scenarios[${index}].id is invalid`);
      return { id: record.id, reference: scenarioReference(record) };
    });
    if (new Set(scenarios.map((item) => item.id)).size !== scenarios.length) throw new Error("parameters.godot.scenarios contains duplicate ids");
  } else {
    scenarios = [{ id: "primary", reference: scenarioReference(scenarioRaw) }];
  }
  let embodiedProof: EmbodiedProofConfig | undefined;
  if (value.embodiedProof !== undefined) {
    if (!value.embodiedProof || typeof value.embodiedProof !== "object" || Array.isArray(value.embodiedProof)) throw new Error("parameters.godot.embodiedProof must be an object");
    const proof = value.embodiedProof as Record<string, unknown>;
    const number = (key: keyof EmbodiedProofConfig, fallback: number, minimum: number): number => {
      const raw = proof[key];
      const parsed = raw === undefined ? fallback : raw;
      if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < minimum) throw new Error(`parameters.godot.embodiedProof.${key} must be a finite number at least ${minimum}`);
      return parsed;
    };
    embodiedProof = {
      minimumDurationSeconds: number("minimumDurationSeconds", 1, 0),
      minimumShippingInputEvents: number("minimumShippingInputEvents", 2, 1),
      minimumDisplacementPixels: number("minimumDisplacementPixels", 12, 0),
      minimumSpatialInteractions: number("minimumSpatialInteractions", 1, 1),
      minimumStateConsequences: number("minimumStateConsequences", 1, 1),
      minimumDistinctFrames: number("minimumDistinctFrames", 3, 2)
    };
  }
  const embodiedProbe = value.embodiedProbe && typeof value.embodiedProbe === "object" && !Array.isArray(value.embodiedProbe)
    ? value.embodiedProbe as Record<string, unknown>
    : undefined;
  if (embodiedProbe && hasTemplatePlaceholder(embodiedProbe)) {
    throw new Error("parameters.godot.embodiedProbe contains unresolved __REPLACE_*__ template values");
  }
  for (const scenario of scenarios) {
    const override = scenario.reference.parameters?.embodiedProbe;
    if (override && hasTemplatePlaceholder(override)) {
      throw new Error(`parameters.godot.scenarios.${scenario.id}.embodiedProbe contains unresolved __REPLACE_*__ template values`);
    }
  }
  return {
    binary: typeof value.binary === "string" ? value.binary : process.env.GODOT_BINARY ?? "godot",
    importCheck: value.importCheck !== false,
    timeoutSeconds: typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : 90,
    // Continuous viewport evidence is part of the embodied contract. Godot's
    // headless renderer does not emit frame_post_draw reliably, so enable the
    // normal renderer automatically whenever the trusted probe is active.
    rendered: value.rendered === true || embodiedProof !== undefined,
    scenarios,
    ...(embodiedProof ? { embodiedProof } : {}),
    ...(embodiedProbe ? { embodiedProbe } : {})
  };
}

function visualReviewConfig(campaign: Campaign): VisualReviewConfig | undefined {
  const rawGodot = campaign.parameters?.godot;
  if (!rawGodot || typeof rawGodot !== "object" || Array.isArray(rawGodot)) return undefined;
  const raw = (rawGodot as Record<string, unknown>).visualReview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const dimensions = Array.isArray(value.requiredDimensions)
    ? value.requiredDimensions.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const views = Array.isArray(value.requiredViews) ? value.requiredViews.flatMap((item): VisualViewConfig[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const view = item as Record<string, unknown>;
    if (typeof view.id !== "string" || typeof view.path !== "string") return [];
    return [{ id: view.id, path: view.path, ...(typeof view.baselineSha256 === "string" ? { baselineSha256: view.baselineSha256.toLowerCase() } : {}) }];
  }) : [];
  if (value.requiredSequences !== undefined && (!Array.isArray(value.requiredSequences) || value.requiredSequences.length === 0)) {
    throw new Error("parameters.godot.visualReview.requiredSequences must be a non-empty array when configured");
  }
  const sequences = Array.isArray(value.requiredSequences) ? value.requiredSequences.flatMap((item): VisualSequenceConfig[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const sequence = item as Record<string, unknown>;
    const paths = Array.isArray(sequence.paths)
      ? sequence.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    if (typeof sequence.id !== "string" || paths.length < 2 || paths.length > 32 || new Set(paths).size !== paths.length) return [];
    const minimumFrames = typeof sequence.minimumFrames === "number" ? sequence.minimumFrames : paths.length;
    if (!Number.isInteger(minimumFrames) || minimumFrames < 2 || minimumFrames > paths.length) return [];
    return [{ id: sequence.id, paths, minimumFrames }];
  }) : [];
  if (Array.isArray(value.requiredSequences) && sequences.length !== value.requiredSequences.length) {
    throw new Error("parameters.godot.visualReview.requiredSequences contains an invalid id, path list, or minimumFrames value");
  }
  const evidenceIds = [...views.map((view) => view.id), ...sequences.map((sequence) => sequence.id)];
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("parameters.godot.visualReview view and sequence ids must be unique");
  if (typeof value.reviewNode !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.reviewNode) || dimensions.length === 0 || views.length === 0) {
    throw new Error("parameters.godot.visualReview requires reviewNode, requiredDimensions, and requiredViews");
  }
  const result: VisualReviewConfig = {
    reviewNode: value.reviewNode,
    minimumScore: typeof value.minimumScore === "number" ? value.minimumScore : 72,
    minimumDimensionScore: typeof value.minimumDimensionScore === "number" ? value.minimumDimensionScore : 55,
    requiredDimensions: dimensions,
    requiredViews: views,
    requiredSequences: sequences,
    minimumWidth: typeof value.minimumWidth === "number" ? value.minimumWidth : 640,
    minimumHeight: typeof value.minimumHeight === "number" ? value.minimumHeight : 360
  };
  if (result.minimumScore < 0 || result.minimumScore > 100 || result.minimumDimensionScore < 0 || result.minimumDimensionScore > 100) {
    throw new Error("parameters.godot.visualReview score thresholds must be between 0 and 100");
  }
  if (!Number.isInteger(result.minimumWidth) || result.minimumWidth < 1 || !Number.isInteger(result.minimumHeight) || result.minimumHeight < 1) {
    throw new Error("parameters.godot.visualReview capture dimensions must be positive integers");
  }
  return result;
}

function candidateLocalPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const traversal = relative(resolve(root), absolute);
  if (traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) {
    throw new Error("Visual evidence paths must stay inside the candidate root");
  }
  return absolute;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function latestReviewOutput(root: string, experimentId: string, node: string): Promise<{ path: string; value: Record<string, unknown> }> {
  const directory = resolve(root, ".factory", "agent-team", experimentId, "graph", node);
  const attempts = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.slice(8)) - Number(left.name.slice(8)));
  if (attempts.length === 0) throw new Error(`No attempts found for visual review node ${node}`);
  const path = resolve(directory, attempts[0]!.name, "output.json");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Visual review output must be a JSON object");
  return { path, value: parsed as Record<string, unknown> };
}

async function godotHostEnvironment(root: string, experimentId: string): Promise<NodeJS.ProcessEnv> {
  const host = resolve(root, ".factory", "runs", experimentId, "godot-host");
  const appData = resolve(host, "appdata");
  const localAppData = resolve(host, "localappdata");
  const temporary = resolve(host, "temp");
  await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true }), mkdir(temporary, { recursive: true })]);
  return { APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temporary, TMP: temporary };
}

function execute(binary: string, args: string[], cwd: string, signal: AbortSignal, timeoutSeconds: number, environment?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Godot timed out")); }, timeoutSeconds * 1000);
    const child = spawn(binary, args, { cwd, signal: controller.signal, windowsHide: true, env: { ...process.env, ...environment } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      if (timedOut) resolveResult({ exitCode: null, stdout, stderr: `${stderr}\nGodot timed out.`, timedOut });
      else reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      resolveResult({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function logArtifact(path: string, label: string): ArtifactReference {
  return { kind: "log", path, mediaType: "text/plain", label };
}

async function writeProcessLogs(directory: string, prefix: string, processResult: ProcessResult): Promise<ArtifactReference[]> {
  const stdoutPath = resolve(directory, `${prefix}.stdout.log`);
  const stderrPath = resolve(directory, `${prefix}.stderr.log`);
  await Promise.all([writeFile(stdoutPath, processResult.stdout, "utf8"), writeFile(stderrPath, processResult.stderr, "utf8")]);
  return [logArtifact(stdoutPath, `${prefix} stdout`), logArtifact(stderrPath, `${prefix} stderr`)];
}

export class GodotEngine implements EngineDriver {
  readonly id = "godot.engine";

  async doctor({ campaign, projectRoot, signal }: Parameters<EngineDriver["doctor"]>[0]): Promise<DoctorResult> {
    const settings = config(campaign);
    try {
      const version = await execute(settings.binary, automationArgs(["--version"]), projectRoot, signal, 15);
      return { ok: version.exitCode === 0, checks: [{ name: "godot-binary", ok: version.exitCode === 0, message: version.stdout.trim() || version.stderr.trim() }] };
    } catch (error) {
      return { ok: false, checks: [{ name: "godot-binary", ok: false, message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async build(context: Parameters<NonNullable<EngineDriver["build"]>>[0]): Promise<ExecutionResult> {
    const settings = config(context.campaign);
    const output = resolve(context.candidate.root, ".factory", "runs", context.experimentId, "import");
    await mkdir(output, { recursive: true });
    const environment = await godotHostEnvironment(context.candidate.root, context.experimentId);
    const run = await execute(settings.binary, automationArgs(["--headless", "--editor", "--quit", "--path", context.candidate.root]), context.candidate.root, context.signal, settings.timeoutSeconds, environment);
    const artifacts = await writeProcessLogs(output, "godot-import", run);
    const ok = godotProcessSucceeded(run);
    return { ok, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, artifacts, metrics: { import_ok: ok ? 1 : 0 } };
  }
}

export class GodotScenarioRunner implements ScenarioRunner {
  readonly id = "godot.scenario";

  async run(input: Parameters<ScenarioRunner["run"]>[0]): Promise<ScenarioResult> {
    const settings = config(input.campaign);
    const useEmbodiedProbe = settings.embodiedProof !== undefined;
    const scenarioProbe = input.scenario.parameters?.embodiedProbe ?? settings.embodiedProbe;
    if (useEmbodiedProbe && !hasEmbodiedProbe(scenarioProbe)) {
      return {
        status: "fail",
        metrics: { embodied_proof: 0 },
        artifacts: [],
        violations: [{
          code: "godot.embodied.probe-config",
          message: "An embodiedProof campaign must configure godot.embodiedProbe (or a scenario override) with actorPath, input steps, and stateObservations.",
          severity: "error"
        }]
      };
    }
    const output = resolve(input.candidate.root, ".factory", "runs", input.experimentId, "scenario");
    await mkdir(output, { recursive: true });
    const requestPath = resolve(output, "request.json");
    const scenarioRequest = useEmbodiedProbe
      ? { ...input.scenario, parameters: { ...(input.scenario.parameters ?? {}), embodiedProbe: scenarioProbe } }
      : input.scenario;
    await writeFile(requestPath, `${JSON.stringify(scenarioRequest, null, 2)}\n`, "utf8");
    const args = [
      "--disable-crash-handler",
      ...(settings.rendered ? [] : ["--headless"]),
      "--path", input.candidate.root,
      "--script", useEmbodiedProbe ? embodiedProbeScriptPath() : "res://addons/gamefactory/scenario_runner.gd",
      "--", "--request", requestPath, "--output", output
    ];
    let processResult: ProcessResult;
    try {
      const environment = await godotHostEnvironment(input.candidate.root, input.experimentId);
      processResult = await execute(settings.binary, args, input.candidate.root, input.signal, settings.timeoutSeconds, environment);
    } catch (error) {
      return { status: "crash", metrics: {}, artifacts: [], violations: [{ code: "godot.launch", message: error instanceof Error ? error.message : String(error), severity: "error" }] };
    }
    const artifacts = await writeProcessLogs(output, "godot-scenario", processResult);
    const processSucceeded = godotProcessSucceeded(processResult);
    const resultPath = resolve(output, "result.json");
    try {
      const raw = JSON.parse(await readFile(resultPath, "utf8")) as Partial<ScenarioResult>;
      const resultArtifact: ArtifactReference = { kind: "test-report", path: resultPath, mediaType: "application/json", label: "Godot scenario result" };
      artifacts.push(resultArtifact);
      const normalized = await normalizeScenarioArtifacts(raw.artifacts, output);
      artifacts.push(...normalized.artifacts);
      const embodied = settings.embodiedProof
        ? await verifyEmbodiedScenarioArtifacts(normalized.artifacts, settings.embodiedProof, EMBODIED_PROBE_PRODUCER)
        : { verified: false, metrics: {}, violations: [] as ScenarioResult["violations"] };
      if (settings.embodiedProof && embodied.verified) {
        const verification = { evidenceClass: "embodied-gameplay", verified: true, protocol: EMBODIED_TRACE_PROTOCOL };
        resultArtifact.metadata = verification;
        const traceArtifact = normalized.artifacts.find((artifact) =>
          (artifact.kind === "replay" || artifact.kind === "telemetry")
          && artifact.metadata?.protocol === EMBODIED_TRACE_PROTOCOL);
        if (traceArtifact) traceArtifact.metadata = { ...(traceArtifact.metadata ?? {}), ...verification };
      }
      const resultViolations = [
        ...(!processSucceeded ? [{ code: "godot.process", message: `Godot reported an engine or script error with exit code ${processResult.exitCode}.`, severity: "error" as const }] : []),
        ...(raw.violations ?? []),
        ...normalized.violations,
        ...embodied.violations
      ];
      const invalidArtifacts = [...normalized.violations, ...embodied.violations].some((violation) => violation.severity === "error");
      return {
        status: !processSucceeded ? "crash" : invalidArtifacts ? "fail" : raw.status ?? "pass",
        metrics: { ...(raw.metrics ?? {}), ...embodied.metrics },
        artifacts,
        violations: resultViolations,
        ...(raw.metadata ? { metadata: raw.metadata } : {})
      };
    } catch {
      return {
        status: "crash",
        metrics: {},
        artifacts,
        violations: [{ code: "godot.result.missing", message: `Godot exited ${processResult.exitCode} without a valid result.json`, severity: "error" }],
        metadata: { timedOut: processResult.timedOut }
      };
    }
  }
}

interface ConfiguredScenarioEvidence {
  status: "pass" | "fail" | "crash";
  metrics: Record<string, number>;
  violations: ScenarioResult["violations"];
  artifacts: ArtifactReference[];
  scenarios: Array<{ id: string; status: ScenarioResult["status"]; metrics: Record<string, number>; violations: ScenarioResult["violations"] }>;
}

async function runConfiguredScenarios(input: {
  campaign: Campaign;
  candidate: Candidate;
  experimentId: string;
  signal: AbortSignal;
  settings: GodotConfig;
  runner: ScenarioRunner;
}): Promise<ConfiguredScenarioEvidence> {
  const artifacts: ArtifactReference[] = [];
  const violations: ScenarioResult["violations"] = [];
  const metrics: Record<string, number> = {};
  const scenarios: ConfiguredScenarioEvidence["scenarios"] = [];
  let passed = 0;
  let status: ConfiguredScenarioEvidence["status"] = "pass";
  for (const [index, configured] of input.settings.scenarios.entries()) {
    const result = await input.runner.run({
      campaign: input.campaign,
      projectRoot: input.candidate.root,
      candidate: input.candidate,
      experimentId: `${input.experimentId}-${configured.id}`,
      scenario: configured.reference,
      signal: input.signal
    });
    artifacts.push(...result.artifacts);
    scenarios.push({ id: configured.id, status: result.status, metrics: result.metrics, violations: result.violations });
    for (const [metric, value] of Object.entries(result.metrics)) {
      if (input.settings.scenarios.length > 1) metrics[`${configured.id}.${metric}`] = value;
      if (index === 0) metrics[metric] = value;
    }
    violations.push(...result.violations.map((violation) => ({ ...violation, code: `godot.scenario.${configured.id}.${violation.code}` })));
    if (result.status === "pass") passed += 1;
    else if (result.status === "crash") status = "crash";
    else if (status !== "crash") status = "fail";
  }
  if (input.settings.scenarios.length > 1) {
    metrics.scenarios_total = input.settings.scenarios.length;
    metrics.scenarios_passed = passed;
  }
  return { status, metrics, violations, artifacts, scenarios };
}

export class GodotScenarioEvaluator implements Evaluator {
  readonly id = "godot.scenario";
  readonly version = "1.0.0";
  constructor(private readonly engine: GodotEngine, private readonly scenarios: GodotScenarioRunner) {}

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    const settings = config(input.campaign);
    const artifacts: ArtifactReference[] = [];
    if (settings.importCheck) {
      const imported = await this.engine.build!({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: input.experimentId, signal: input.signal });
      artifacts.push(...imported.artifacts);
      if (!imported.ok) return { evaluator: this.id, version: this.version, status: "fail", metrics: imported.metrics ?? { import_ok: 0 }, violations: [{ code: "godot.import", message: "Godot import or script validation failed.", severity: "error" }], artifacts, summary: "Stopped at the import gate." };
    }
    const run = await runConfiguredScenarios({ campaign: input.campaign, candidate, experimentId: input.experimentId, signal: input.signal, settings, runner: this.scenarios });
    artifacts.push(...run.artifacts);
    return {
      evaluator: this.id,
      version: this.version,
      status: run.status === "pass" ? "pass" : "fail",
      metrics: { import_ok: 1, ...run.metrics },
      violations: run.violations,
      artifacts,
      confidence: run.status === "crash" ? 0 : 1,
      summary: run.status === "pass" ? `${run.scenarios.length} configured Godot scenario(s) passed.` : `Configured Godot scenarios ${run.status}.`
    };
  }
}

/**
 * Refreshes engine evidence inside the candidate before a read-only semantic
 * reviewer runs. Keeping this as an agent capability lets agent-team schedule
 * it after every repair without granting the critic write access or asking a
 * model to discover and launch the host engine itself.
 */
export class GodotEvidenceAgent implements AgentDriver {
  readonly id = "godot.evidence";

  constructor(
    private readonly engine: EngineDriver,
    private readonly scenarios: ScenarioRunner
  ) {}

  async run(request: Parameters<AgentDriver["run"]>[0]): Promise<AgentResult> {
    const settings = config(request.campaign);
    const output = resolve(request.candidate.root, ".factory", "runs", request.experimentId, "godot-evidence");
    await mkdir(output, { recursive: true });
    const manifestPath = resolve(output, "result.json");
    const artifacts: ArtifactReference[] = [];
    let status: "pass" | "fail" | "crash" = "crash";
    let metrics: Record<string, number> = {};
    let violations: ScenarioResult["violations"] = [];
    let scenarioRuns: ConfiguredScenarioEvidence["scenarios"] = [];

    try {
      if (settings.importCheck) {
        if (!this.engine.build) throw new Error("Configured Godot engine cannot perform an import check");
        const imported = await this.engine.build({
          campaign: request.campaign,
          projectRoot: request.candidate.root,
          candidate: request.candidate,
          experimentId: request.experimentId,
          signal: request.signal
        });
        artifacts.push(...imported.artifacts);
        metrics = { ...(imported.metrics ?? {}), import_ok: imported.ok ? 1 : 0 };
        if (!imported.ok) {
          status = "fail";
          violations = [{ code: "godot.import", message: "Godot import or script validation failed.", severity: "error" }];
        }
      }

      if (!settings.importCheck || metrics.import_ok === 1) {
        const scenario = await runConfiguredScenarios({
          campaign: request.campaign,
          candidate: request.candidate,
          experimentId: request.experimentId,
          signal: request.signal,
          settings,
          runner: this.scenarios
        });
        artifacts.push(...scenario.artifacts);
        status = scenario.status;
        metrics = { ...(settings.importCheck ? { import_ok: 1 } : {}), ...scenario.metrics };
        violations = scenario.violations;
        scenarioRuns = scenario.scenarios;
      }
    } catch (error) {
      status = "crash";
      violations = [{ code: "godot.evidence", message: error instanceof Error ? error.message : String(error), severity: "error" }];
    }

    const manifest = {
      apiVersion: "gamefactory.godot-evidence/v1",
      experimentId: request.experimentId,
      candidateId: request.candidate.id,
      generatedAt: new Date().toISOString(),
      status,
      metrics,
      violations,
      artifacts,
      scenarios: scenarioRuns
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    artifacts.push({ kind: "test-report", path: manifestPath, mediaType: "application/json", label: "Fresh Godot evidence manifest" });
    return {
      summary: status === "pass"
        ? "Fresh Godot import and deterministic scenario evidence passed."
        : `Fresh Godot evidence ${status} with ${violations.length} violation(s).`,
      artifacts,
      metadata: { outcome: status === "pass" ? "pass" : "revise", status, metrics, violations, manifestPath }
    };
  }
}

export class GodotVisualEvaluator implements Evaluator {
  readonly id = "godot.visual";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    if (!input.candidate) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "pass",
        metrics: { visual_quality: 0 },
        violations: [],
        artifacts: [],
        confidence: 1,
        summary: "Visual evidence is evaluated on generated candidates."
      };
    }
    const settings = visualReviewConfig(input.campaign);
    if (!settings) {
      return { evaluator: this.id, version: this.version, status: "fail", metrics: { visual_quality: 0 }, violations: [{ code: "godot.visual.config", message: "Visual review is not configured.", severity: "error" }], artifacts: [], confidence: 1 };
    }
    const violations: Evaluation["violations"] = [];
    const artifacts: ArtifactReference[] = [];
    let review: { path: string; value: Record<string, unknown> };
    try {
      review = await latestReviewOutput(input.candidate.root, input.experimentId, settings.reviewNode);
      artifacts.push({ kind: "test-report", path: review.path, mediaType: "application/json", label: "Semantic visual review" });
    } catch (error) {
      return { evaluator: this.id, version: this.version, status: "fail", metrics: { visual_quality: 0 }, violations: [{ code: "godot.visual.review-missing", message: error instanceof Error ? error.message : String(error), severity: "error" }], artifacts, confidence: 1 };
    }

    const findings = review.value.findings && typeof review.value.findings === "object" && !Array.isArray(review.value.findings)
      ? review.value.findings as Record<string, unknown>
      : {};
    const geminiScores = review.value.scores && typeof review.value.scores === "object" && !Array.isArray(review.value.scores)
      ? review.value.scores as Record<string, unknown>
      : undefined;
    const rawScorecard = geminiScores ?? (findings.scorecard && typeof findings.scorecard === "object" && !Array.isArray(findings.scorecard)
      ? findings.scorecard as Record<string, unknown>
      : {});
    const geminiReview = Array.isArray(review.value.findings) && geminiScores !== undefined;
    if (geminiReview && (!Array.isArray(review.value.evidence) || review.value.evidence.length === 0)) {
      violations.push({ code: "godot.visual.review-evidence", message: "Gemini visual review did not preserve its reviewed evidence inventory.", severity: "error" });
    }
    const scores: number[] = [];
    for (const dimension of settings.requiredDimensions) {
      const score = rawScorecard[dimension];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
        violations.push({ code: "godot.visual.scorecard", message: `Visual review is missing a valid 0-100 score for ${dimension}.`, severity: "error" });
        continue;
      }
      scores.push(score);
      if (score < settings.minimumDimensionScore) {
        violations.push({ code: `godot.visual.dimension.${dimension}`, message: `${dimension} scored ${score}, below ${settings.minimumDimensionScore}.`, severity: "error" });
      }
    }
    const quality = scores.length === settings.requiredDimensions.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : 0;
    if (quality < settings.minimumScore) {
      violations.push({ code: "godot.visual.minimum", message: `Visual quality scored ${quality.toFixed(1)}, below ${settings.minimumScore}.`, severity: "error" });
    }

    const evidence = findings.evidence;
    const citesEvidence = (kind: "view" | "sequence", id: string): boolean => {
      if (Array.isArray(evidence)) {
        return evidence.some((item) => item && typeof item === "object" && !Array.isArray(item)
          && (item as Record<string, unknown>)[kind] === id
          && typeof (item as Record<string, unknown>).observation === "string"
          && ((item as Record<string, unknown>).observation as string).trim().length > 0);
      }
      if (!evidence || typeof evidence !== "object") return false;
      const item = (evidence as Record<string, unknown>)[id];
      if (typeof item === "string") return item.trim().length > 0;
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      const observation = record.observation ?? record.finding;
      return typeof observation === "string" && observation.trim().length > 0;
    };
    for (const view of settings.requiredViews) {
      let path: string;
      try {
        path = candidateLocalPath(input.candidate.root, view.path);
      } catch (error) {
        violations.push({ code: `godot.visual.capture.${view.id}`, message: error instanceof Error ? error.message : String(error), severity: "error" });
        continue;
      }
      try {
        const bytes = await readFile(path);
        const dimensions = pngDimensions(bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        artifacts.push({ kind: "image", path, mediaType: "image/png", label: `Visual review: ${view.id}`, metadata: { view: view.id, sha256, ...(dimensions ?? {}) } });
        if (!dimensions || dimensions.width < settings.minimumWidth || dimensions.height < settings.minimumHeight) {
          violations.push({ code: `godot.visual.capture.${view.id}`, message: `${view.id} is not a valid ${settings.minimumWidth}x${settings.minimumHeight}+ PNG capture.`, severity: "error" });
        }
        if (view.baselineSha256 && sha256 === view.baselineSha256) {
          violations.push({ code: `godot.visual.unchanged.${view.id}`, message: `${view.id} is byte-identical to the pinned unpolished baseline.`, severity: "error" });
        }
      } catch (error) {
        violations.push({ code: `godot.visual.capture.${view.id}`, message: `Missing required ${view.id} capture: ${error instanceof Error ? error.message : String(error)}`, severity: "error" });
      }
      if (!geminiReview && !citesEvidence("view", view.id)) violations.push({ code: `godot.visual.evidence.${view.id}`, message: `Visual review did not record an observation for ${view.id}.`, severity: "error" });
    }
    for (const sequence of settings.requiredSequences) {
      const hashes = new Set<string>();
      let validFrames = 0;
      for (const [frame, configuredPath] of sequence.paths.entries()) {
        try {
          const path = candidateLocalPath(input.candidate.root, configuredPath);
          const bytes = await readFile(path);
          const dimensions = pngDimensions(bytes);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          hashes.add(sha256);
          if (dimensions && dimensions.width >= settings.minimumWidth && dimensions.height >= settings.minimumHeight) validFrames += 1;
          else violations.push({ code: `godot.visual.sequence.${sequence.id}`, message: `${sequence.id} frame ${frame + 1} is not a valid ${settings.minimumWidth}x${settings.minimumHeight}+ PNG capture.`, severity: "error" });
          artifacts.push({ kind: "image", path, mediaType: "image/png", label: `Visual sequence ${sequence.id}: frame ${frame + 1}`, metadata: { sequence: sequence.id, frame, sha256, ...(dimensions ?? {}) } });
        } catch (error) {
          violations.push({ code: `godot.visual.sequence.${sequence.id}`, message: `Missing ${sequence.id} frame ${frame + 1}: ${error instanceof Error ? error.message : String(error)}`, severity: "error" });
        }
      }
      if (validFrames < sequence.minimumFrames) {
        violations.push({ code: `godot.visual.sequence.${sequence.id}.frames`, message: `${sequence.id} has ${validFrames} valid frame(s); ${sequence.minimumFrames} are required.`, severity: "error" });
      }
      if (hashes.size < 2) {
        violations.push({ code: `godot.visual.sequence.${sequence.id}.motion`, message: `${sequence.id} does not demonstrate visible change across frames.`, severity: "error" });
      }
      if (!geminiReview && !citesEvidence("sequence", sequence.id)) violations.push({ code: `godot.visual.evidence.${sequence.id}`, message: `Visual review did not record an observation for sequence ${sequence.id}.`, severity: "error" });
    }
    if (review.value.outcome !== "pass") {
      violations.push({ code: "godot.visual.judgment", message: `Visual critic returned ${String(review.value.outcome ?? "no outcome")} instead of pass.`, severity: "error" });
    }
    return {
      evaluator: this.id,
      version: this.version,
      status: violations.length === 0 ? "pass" : "fail",
      metrics: { visual_quality: quality },
      violations,
      artifacts,
      confidence: scores.length === settings.requiredDimensions.length ? 1 : 0,
      summary: violations.length === 0 ? `Visual evidence passed at ${quality.toFixed(1)}.` : `Visual evidence failed with ${violations.length} issue(s).`
    };
  }
}

export default defineExtension((api) => {
  const engine = new GodotEngine();
  const scenarios = new GodotScenarioRunner();
  return combineDisposables(
    api.register("engine", "godot.engine", engine),
    api.register("scenario", "godot.scenario", scenarios),
    api.register("agent", "godot.evidence", new GodotEvidenceAgent(engine, scenarios)),
    api.register("evaluator", "godot.scenario", new GodotScenarioEvaluator(engine, scenarios)),
    api.register("evaluator", "godot.visual", new GodotVisualEvaluator())
  );
});
