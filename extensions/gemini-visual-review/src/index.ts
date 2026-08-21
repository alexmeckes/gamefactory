import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  LocalCredentialStore,
  resolveCredential,
  type ArtifactReference,
  type AgentContribution,
  type AgentDriver,
  type AgentResult,
  type Campaign,
  type Evaluation,
  type Evaluator,
  type InvocationUsage,
  type Violation
} from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const DEFAULT_MODEL = "gemini-3.6-flash";
const REPORT_VERSION = "gamefactory.gemini-visual-review/v1";
const TRACE_PROTOCOL = "gamefactory.embodied-trace/v1";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DIMENSIONS = [
  "gameplayLegibility",
  "focalHierarchy",
  "layoutIntegrity",
  "typography",
  "scaleConsistency",
  "authoredSpecificity",
  "targetFidelity",
  "motionFeedback",
  "sceneLife"
] as const;
type Dimension = typeof DIMENSIONS[number];
type Severity = "blocker" | "major" | "minor" | "opportunity";

export class GeminiVisualReviewUnavailableError extends Error {
  readonly artifacts: ArtifactReference[];

  constructor(message: string, artifacts: ArtifactReference[]) {
    super(message);
    this.name = "GeminiVisualReviewUnavailableError";
    this.artifacts = artifacts;
  }
}

interface Settings {
  checkpoint: "embodied" | "production";
  model: string;
  credentialName: string;
  apiKeyEnvironment: string;
  timeoutSeconds: number;
  minimumImages: number;
  maximumImages: number;
  maximumTotalBytes: number;
  maximumContractBytes: number;
  minimumScore: number;
  maximumReviews: number;
  requireEmbodiedTrace: boolean;
  failureSeverities: Severity[];
  evidencePaths: string[];
  contractPaths: string[];
  mediaResolution: "low" | "medium" | "high";
}

interface EvidenceInput {
  id: string;
  path: string;
  kind: "image" | "video";
  mediaType: string;
  role: "runtime" | "target";
  label: string;
  sha256: string;
  bytes: Buffer;
  metadata: Record<string, unknown>;
}

interface Finding {
  id: string;
  severity: Severity;
  owner: "implementation" | "target" | "spec";
  affectedState: string;
  evidenceIds: string[];
  timestampSeconds: number | null;
  violatedContract: string;
  playerImpact: string;
  repair: string;
  regressionEvidence: string;
}

interface GeminiReview {
  verdict: "pass" | "revise" | "blocked";
  confidence: number;
  summary: string;
  scores: Record<Dimension, number>;
  notApplicable: Dimension[];
  strengths: string[];
  findings: Finding[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback: string, label: string, maximum = 4096): string {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim() || result.length > maximum) throw new Error(`${label} must be a non-empty string with at most ${maximum} characters`);
  return result.trim();
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

function strings(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)) throw new Error(`${label} must contain at most ${maximum} non-empty strings`);
  return [...new Set(value)];
}

function settings(campaign: Campaign): Settings {
  const raw = campaign.parameters?.geminiVisualReview;
  const value = raw === undefined ? {} : record(raw, "parameters.geminiVisualReview");
  const checkpoint = value.checkpoint ?? "production";
  if (checkpoint !== "embodied" && checkpoint !== "production") throw new Error("parameters.geminiVisualReview.checkpoint must be embodied or production");
  const failureSeverities = strings(value.failureSeverities, "parameters.geminiVisualReview.failureSeverities", 4);
  if (failureSeverities.some((severity) => severity !== "blocker" && severity !== "major" && severity !== "minor" && severity !== "opportunity")) throw new Error("parameters.geminiVisualReview.failureSeverities contains an unsupported severity");
  const mediaResolution = value.mediaResolution ?? "high";
  if (mediaResolution !== "low" && mediaResolution !== "medium" && mediaResolution !== "high") throw new Error("parameters.geminiVisualReview.mediaResolution must be low, medium, or high");
  const minimumImages = integer(value.minimumImages, checkpoint === "embodied" ? 3 : 5, 2, 24, "parameters.geminiVisualReview.minimumImages");
  const maximumImages = integer(value.maximumImages, 12, minimumImages, 24, "parameters.geminiVisualReview.maximumImages");
  return {
    checkpoint,
    model: text(value.model, DEFAULT_MODEL, "parameters.geminiVisualReview.model", 256),
    credentialName: text(value.credentialName, "google.gemini", "parameters.geminiVisualReview.credentialName", 128),
    apiKeyEnvironment: text(value.apiKeyEnvironment, "GEMINI_API_KEY", "parameters.geminiVisualReview.apiKeyEnvironment", 128),
    timeoutSeconds: integer(value.timeoutSeconds, 120, 10, 600, "parameters.geminiVisualReview.timeoutSeconds"),
    minimumImages,
    maximumImages,
    maximumTotalBytes: integer(value.maximumTotalBytes, 25_000_000, 1024, 90_000_000, "parameters.geminiVisualReview.maximumTotalBytes"),
    maximumContractBytes: integer(value.maximumContractBytes, 300_000, 1024, 2_000_000, "parameters.geminiVisualReview.maximumContractBytes"),
    minimumScore: finite(value.minimumScore, checkpoint === "embodied" ? 60 : 76, 0, 100, "parameters.geminiVisualReview.minimumScore"),
    maximumReviews: integer(value.maximumReviews, 4, 1, 32, "parameters.geminiVisualReview.maximumReviews"),
    requireEmbodiedTrace: value.requireEmbodiedTrace !== false,
    failureSeverities: (failureSeverities.length ? failureSeverities : checkpoint === "embodied" ? ["blocker"] : ["blocker", "major"]) as Severity[],
    evidencePaths: strings(value.evidencePaths, "parameters.geminiVisualReview.evidencePaths", 24),
    contractPaths: strings(value.contractPaths, "parameters.geminiVisualReview.contractPaths", 8),
    mediaResolution
  };
}

function candidatePath(root: string, path: string, label: string): string {
  if (isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be candidate-relative`);
  const target = resolve(root, path);
  const traversal = relative(resolve(root), target);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} must stay below the candidate root`);
  return target;
}

async function canonicalCandidatePath(root: string, path: string, label: string): Promise<string> {
  const target = candidatePath(root, path, label);
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  const traversal = relative(canonicalRoot, canonicalTarget);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} resolves outside the candidate root`);
  if (!(await lstat(canonicalTarget)).isFile()) throw new Error(`${label} is not a regular file`);
  return canonicalTarget;
}

function mediaType(path: string, declared?: string): string | undefined {
  if (declared === "image/png" || declared === "image/jpeg" || declared === "image/webp" || declared === "video/mp4") return declared;
  const extension = extname(path).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".mp4" ? "video/mp4" : undefined;
}

function validateMedia(bytes: Buffer, type: string, label: string): void {
  const valid = type === "image/png" ? bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG)
    : type === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : type === "image/webp" ? bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        : type === "video/mp4" ? bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
          : false;
  if (!valid) throw new Error(`${label} does not match declared media type ${type}`);
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function visualReviewPaths(campaign: Campaign): string[] {
  const godot = campaign.parameters?.godot;
  if (!godot || typeof godot !== "object" || Array.isArray(godot)) return [];
  const review = (godot as Record<string, unknown>).visualReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) return [];
  const config = review as Record<string, unknown>;
  const paths: string[] = [];
  if (Array.isArray(config.requiredViews)) for (const raw of config.requiredViews) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).path === "string") paths.push((raw as Record<string, unknown>).path as string);
  }
  if (Array.isArray(config.requiredSequences)) for (const raw of config.requiredSequences) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const sequence = (raw as Record<string, unknown>).paths;
    if (Array.isArray(sequence)) for (const path of sequence) if (typeof path === "string") paths.push(path);
  }
  return [...new Set(paths)];
}

async function contractEvidence(root: string, paths: string[], maximumBytes: number): Promise<{ text: string; targetPaths: Array<{ path: string; expectedSha256?: string }>; artifacts: ArtifactReference[] }> {
  const sections: string[] = [];
  const targetPaths: Array<{ path: string; expectedSha256?: string }> = [];
  const artifacts: ArtifactReference[] = [];
  let consumed = 0;
  for (const configured of paths) {
    const path = await canonicalCandidatePath(root, configured, `Gemini contract ${configured}`);
    const bytes = await readFile(path);
    consumed += bytes.length;
    if (consumed > maximumBytes) throw new Error(`Gemini visual contracts exceed maximumContractBytes ${maximumBytes}`);
    const body = bytes.toString("utf8");
    sections.push(`--- ${configured} ---\n${body}`);
    artifacts.push({ kind: "profile", path, mediaType: configured.endsWith(".json") ? "application/json" : "text/plain", label: `Gemini review contract: ${configured}`, sha256: sha256(bytes) });
    if (!configured.endsWith(".json")) continue;
    try {
      const manifest = JSON.parse(body) as Record<string, unknown>;
      if (typeof manifest.selectedCandidateId !== "string" || !Array.isArray(manifest.candidates)) continue;
      const selected = manifest.candidates.find((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).id === manifest.selectedCandidateId) as Record<string, unknown> | undefined;
      if (!selected || typeof selected.primaryViewId !== "string" || !Array.isArray(selected.views)) continue;
      const view = selected.views.find((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).id === selected.primaryViewId) as Record<string, unknown> | undefined;
      if (view && typeof view.path === "string") targetPaths.push({ path: view.path, ...(typeof view.sha256 === "string" ? { expectedSha256: view.sha256.toLowerCase() } : {}) });
    } catch { /* non-manifest JSON remains useful contract text */ }
  }
  return { text: sections.join("\n\n"), targetPaths, artifacts };
}

async function collectEvidence(input: Parameters<Evaluator["evaluate"]>[0], config: Settings): Promise<{ media: EvidenceInput[]; trace: string; traceArtifact?: ArtifactReference; contractText: string; contractArtifacts: ArtifactReference[] }> {
  if (!input.candidate) throw new Error("Candidate is required for Gemini visual review");
  const sources: Array<{ path: string; declared?: string; label: string; role: "runtime" | "target"; metadata: Record<string, unknown>; trustedPath: boolean; expectedSha256?: string }> = [];
  let trace = "";
  let traceArtifact: ArtifactReference | undefined;
  for (const evaluation of input.priorEvaluations) {
    if (evaluation.evaluator !== "godot.scenario" && evaluation.evaluator !== "godot.visual") continue;
    for (const artifact of evaluation.artifacts) {
      if ((artifact.kind === "replay" || artifact.kind === "telemetry") && artifact.metadata?.protocol === TRACE_PROTOCOL && artifact.metadata?.evidenceClass === "embodied-gameplay" && artifact.metadata?.verified === true) {
        const bytes = await readFile(await realpath(artifact.path));
        if (bytes.length > config.maximumContractBytes) throw new Error("Verified embodied trace exceeds maximumContractBytes");
        trace = bytes.toString("utf8");
        traceArtifact = artifact;
      }
      if (artifact.kind === "image" || artifact.kind === "video") sources.push({ path: artifact.path, ...(artifact.mediaType ? { declared: artifact.mediaType } : {}), label: artifact.label ?? `${evaluation.evaluator} ${artifact.kind}`, role: "runtime", metadata: artifact.metadata ?? {}, trustedPath: true, ...(artifact.sha256 ? { expectedSha256: artifact.sha256 } : {}) });
    }
  }
  if (config.requireEmbodiedTrace && !traceArtifact) throw new Error("Gemini visual review requires an evaluator-verified embodied gameplay trace from godot.scenario");
  const configuredRuntimePaths = config.checkpoint === "production" ? visualReviewPaths(input.campaign) : [];
  for (const path of [...configuredRuntimePaths, ...config.evidencePaths]) sources.push({ path, label: `Configured runtime evidence: ${path}`, role: "runtime", metadata: {}, trustedPath: false });
  const contracts = await contractEvidence(input.candidate.root, config.contractPaths, config.maximumContractBytes);
  // Reserve image capacity for the approved target before consuming a long
  // runtime sequence; otherwise target fidelity could be scored without the
  // model ever receiving the target image.
  sources.unshift(...contracts.targetPaths.map((target) => ({ path: target.path, label: `Approved scene target: ${target.path}`, role: "target" as const, metadata: { authority: "production-target" }, trustedPath: false, ...(target.expectedSha256 ? { expectedSha256: target.expectedSha256 } : {}) })));

  const media: EvidenceInput[] = [];
  const canonicalSeen = new Set<string>();
  let totalBytes = 0;
  let runtimeImages = 0;
  for (const source of sources) {
    if (media.filter((item) => item.kind === "image").length >= config.maximumImages && media.some((item) => item.kind === "video")) break;
    const path = source.trustedPath ? await realpath(source.path) : await canonicalCandidatePath(input.candidate.root, source.path, source.label);
    if (canonicalSeen.has(path)) continue;
    if (!(await lstat(path)).isFile()) throw new Error(`${source.label} is not a regular file`);
    const type = mediaType(path, source.declared);
    if (!type) continue;
    if (type.startsWith("image/") && media.filter((item) => item.kind === "image").length >= config.maximumImages) continue;
    const bytes = await readFile(path);
    validateMedia(bytes, type, source.label);
    const hash = sha256(bytes);
    if (source.expectedSha256 && source.expectedSha256.toLowerCase() !== hash) throw new Error(`${source.label} hash does not match its declared evidence hash`);
    totalBytes += bytes.length;
    if (totalBytes > config.maximumTotalBytes) throw new Error(`Gemini visual evidence exceeds maximumTotalBytes ${config.maximumTotalBytes}`);
    const kind = type === "video/mp4" ? "video" : "image";
    if (kind === "image" && source.role === "runtime") runtimeImages += 1;
    media.push({ id: `${source.role}-${kind}-${String(media.length + 1).padStart(3, "0")}`, path, kind, mediaType: type, role: source.role, label: source.label, sha256: hash, bytes, metadata: source.metadata });
    canonicalSeen.add(path);
  }
  if (runtimeImages < config.minimumImages) throw new Error(`Gemini visual review found ${runtimeImages} runtime image(s); expected at least ${config.minimumImages}`);
  return { media, trace, ...(traceArtifact ? { traceArtifact } : {}), contractText: contracts.text, contractArtifacts: contracts.artifacts };
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "summary", "scores", "notApplicable", "strengths", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "revise", "blocked"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    scores: { type: "object", additionalProperties: false, required: [...DIMENSIONS], properties: Object.fromEntries(DIMENSIONS.map((id) => [id, { type: "integer", minimum: 0, maximum: 100 }])) },
    notApplicable: { type: "array", maxItems: 3, items: { type: "string", enum: [...DIMENSIONS] } },
    strengths: { type: "array", maxItems: 8, items: { type: "string" } },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "owner", "affectedState", "evidenceIds", "timestampSeconds", "violatedContract", "playerImpact", "repair", "regressionEvidence"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor", "opportunity"] },
          owner: { type: "string", enum: ["implementation", "target", "spec"] },
          affectedState: { type: "string" },
          evidenceIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          timestampSeconds: { type: ["number", "null"], minimum: 0 },
          violatedContract: { type: "string" },
          playerImpact: { type: "string" },
          repair: { type: "string" },
          regressionEvidence: { type: "string" }
        }
      }
    }
  }
};

function reviewPrompt(campaign: Campaign, config: Settings, media: EvidenceInput[], trace: string, contracts: string): string {
  const inventory = media.map((item) => ({ id: item.id, role: item.role, kind: item.kind, label: item.label, sha256: item.sha256, metadata: item.metadata }));
  const checkpoint = config.checkpoint === "embodied"
    ? "Judge whether the proven interaction is visually readable as an embodied world. Do not demand production polish at this checkpoint. Block only when the scene reads as a static plate, the actor/action/consequence is not visually intelligible, motion evidence is non-causal, or evidence is insufficient."
    : "Audit production presentation strictly. Major incoherence, overlap, scaling errors, generic or mixed visual language, weak state-linked motion, target drift, or a scene that still reads as a static composition requires revision.";
  return [
    "You are an independent multimodal game-build critic. Judge only the supplied running-engine evidence and contracts; never infer quality from source code or concept art alone.",
    checkpoint,
    "Inspect complete sequences, connect visible feedback to the verified trace, and distinguish objective blockers from subjective opportunities.",
    "Every finding must cite one or more exact evidence IDs and classify its owner as implementation, target, or spec. Use implementation only when the approved contracts are coherent and the runtime failed to realize them; use target when the approved screen direction itself is infeasible or incoherent; use spec only when runtime evidence falsifies a consumed product claim. Use timestampSeconds for video findings and null for still/frame findings. Repairs must be the smallest coherent correction and must name the regression evidence to recapture.",
    `Campaign objective: ${campaign.objective}`,
    `Checkpoint: ${config.checkpoint}`,
    `Evidence inventory: ${JSON.stringify(inventory)}`,
    `Verified embodied trace: ${trace || "not required at this checkpoint"}`,
    `Approved contracts:\n${contracts || "No additional contract files supplied."}`
  ].join("\n\n");
}

function responseText(value: unknown): string {
  const root = record(value, "Gemini response");
  if (typeof root.output_text === "string") return root.output_text;
  if (!Array.isArray(root.steps)) throw new Error("Gemini response contains no output text");
  for (let index = root.steps.length - 1; index >= 0; index -= 1) {
    const step = root.steps[index];
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string") return (block as Record<string, unknown>).text as string;
  }
  throw new Error("Gemini response contains no output text");
}

function parseReview(value: unknown, evidenceIds: Set<string>, hasTarget: boolean): GeminiReview {
  const root = record(value, "Gemini visual review");
  if (root.verdict !== "pass" && root.verdict !== "revise" && root.verdict !== "blocked") throw new Error("Gemini visual review verdict is invalid");
  if (typeof root.confidence !== "number" || !Number.isFinite(root.confidence) || root.confidence < 0 || root.confidence > 1) throw new Error("Gemini visual review confidence must be from 0 to 1");
  const summary = text(root.summary, "", "Gemini visual review summary", 4000);
  const rawScores = record(root.scores, "Gemini visual review scores");
  const scores = {} as Record<Dimension, number>;
  for (const id of DIMENSIONS) {
    const score = rawScores[id];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) throw new Error(`Gemini visual score ${id} must be an integer from 0 to 100`);
    scores[id] = score;
  }
  if (!Array.isArray(root.notApplicable) || root.notApplicable.length > 3 || root.notApplicable.some((id) => typeof id !== "string" || !(DIMENSIONS as readonly string[]).includes(id))) throw new Error("Gemini visual notApplicable is invalid");
  const notApplicable = [...new Set(root.notApplicable)] as Dimension[];
  if (hasTarget && notApplicable.includes("targetFidelity")) throw new Error("Gemini visual review cannot mark targetFidelity inapplicable when an approved target was supplied");
  if (DIMENSIONS.length - notApplicable.length < 6) throw new Error("Gemini visual review must score at least six dimensions");
  if (!Array.isArray(root.strengths) || root.strengths.length > 8 || !root.strengths.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1000)) throw new Error("Gemini visual review strengths are invalid");
  if (!Array.isArray(root.findings) || root.findings.length > 20) throw new Error("Gemini visual review findings are invalid");
  const findingIds = new Set<string>();
  const findings = root.findings.map((raw, index): Finding => {
    const finding = record(raw, `Gemini finding ${index + 1}`);
    const id = text(finding.id, "", `Gemini finding ${index + 1} id`, 128);
    if (findingIds.has(id)) throw new Error(`Gemini finding id ${id} is duplicated`);
    findingIds.add(id);
    if (finding.severity !== "blocker" && finding.severity !== "major" && finding.severity !== "minor" && finding.severity !== "opportunity") throw new Error(`Gemini finding ${id} severity is invalid`);
    if (finding.owner !== "implementation" && finding.owner !== "target" && finding.owner !== "spec") throw new Error(`Gemini finding ${id} owner is invalid`);
    if (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0 || finding.evidenceIds.length > 8 || finding.evidenceIds.some((evidenceId) => typeof evidenceId !== "string" || !evidenceIds.has(evidenceId))) throw new Error(`Gemini finding ${id} cites missing or unknown evidence`);
    if (finding.timestampSeconds !== null && (typeof finding.timestampSeconds !== "number" || !Number.isFinite(finding.timestampSeconds) || finding.timestampSeconds < 0)) throw new Error(`Gemini finding ${id} timestampSeconds is invalid`);
    return {
      id,
      severity: finding.severity,
      owner: finding.owner,
      affectedState: text(finding.affectedState, "", `Gemini finding ${id} affectedState`, 1000),
      evidenceIds: [...new Set(finding.evidenceIds)] as string[],
      timestampSeconds: finding.timestampSeconds,
      violatedContract: text(finding.violatedContract, "", `Gemini finding ${id} violatedContract`, 2000),
      playerImpact: text(finding.playerImpact, "", `Gemini finding ${id} playerImpact`, 2000),
      repair: text(finding.repair, "", `Gemini finding ${id} repair`, 3000),
      regressionEvidence: text(finding.regressionEvidence, "", `Gemini finding ${id} regressionEvidence`, 2000)
    };
  });
  return { verdict: root.verdict, confidence: root.confidence, summary, scores, notApplicable, strengths: root.strengths as string[], findings };
}

function providerUsage(value: unknown, model: string): InvocationUsage {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const raw = [root.usage, root.usage_metadata, root.usageMetadata].find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
  const count = (...names: string[]): number | undefined => {
    for (const name of names) { const value = raw?.[name]; if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value; }
    return undefined;
  };
  const inputTokens = count("input_tokens", "inputTokens", "prompt_token_count", "promptTokenCount");
  const outputTokens = count("output_tokens", "outputTokens", "candidates_token_count", "candidatesTokenCount");
  const totalTokens = count("total_tokens", "totalTokens", "total_token_count", "totalTokenCount") ?? (inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0));
  const reportedModel = [root.model, root.model_version, root.modelVersion].find((item) => typeof item === "string" && item.length > 0) as string | undefined;
  return { provider: "google", model: reportedModel ?? model, billingMode: "metered", identitySource: reportedModel ? "provider-reported" : "configured", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

function violationsFor(review: GeminiReview, config: Settings, score: number): Violation[] {
  const violations: Violation[] = review.findings.map((finding) => ({
    code: `gemini.visual.${finding.id}`,
    message: `[${finding.severity}] ${finding.playerImpact} Repair: ${finding.repair} Evidence: ${finding.evidenceIds.join(", ")}.`,
    severity: config.failureSeverities.includes(finding.severity) ? "error" : finding.severity === "minor" ? "warning" : "info"
  }));
  if (review.verdict !== "pass" && !violations.some((item) => item.severity === "error")) violations.push({ code: "gemini.visual.verdict", message: review.summary, severity: "error" });
  if (score < config.minimumScore) violations.push({ code: "gemini.visual.score", message: `Applicable visual dimensions averaged ${score.toFixed(1)}; expected at least ${config.minimumScore}.`, severity: "error" });
  return violations;
}

async function providerFailureMessage(response: Response): Promise<string> {
  let detail = "provider returned no structured error detail";
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const root = record(parsed, "Gemini error response");
        const error = root.error && typeof root.error === "object" && !Array.isArray(root.error)
          ? root.error as Record<string, unknown>
          : root;
        const status = typeof error.status === "string" ? error.status.trim() : "";
        const message = typeof error.message === "string" ? error.message.trim() : "";
        detail = [status, message].filter(Boolean).join(": ") || detail;
      } catch {
        detail = body.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() || detail;
      }
    }
  } catch { /* the status code remains actionable even if the body cannot be read */ }
  return detail.slice(0, 1024);
}

export class GeminiVisualEvaluator implements Evaluator {
  readonly id = "gemini.visual";
  readonly version = "1.0.0";
  private readonly reservations = new Map<string, number>();
  constructor(private readonly dependencies: { fetchImpl?: typeof fetch; credentialStore?: LocalCredentialStore } = {}) {}

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    let config: Settings;
    try { config = settings(input.campaign); }
    catch (error) { return this.failed(error instanceof Error ? error.message : String(error)); }
    if (!input.candidate) return { evaluator: this.id, version: this.version, status: "pass", metrics: { gemini_visual_review: 0, gemini_visual_score: 0 }, violations: [], artifacts: [], confidence: 1, summary: "Baseline requires no provider review." };
    const runDirectory = resolve(input.candidate.root, ".factory", "runs", input.experimentId, "gemini-visual-review");
    const requestPath = resolve(runDirectory, "request-manifest.json");
    const reportPath = resolve(runDirectory, "review.json");
    await mkdir(runDirectory, { recursive: true });
    const artifacts: ArtifactReference[] = [
      { kind: "other", path: requestPath, mediaType: "application/json", label: "Sanitized Gemini visual review request" },
      { kind: "test-report", path: reportPath, mediaType: "application/json", label: "Gemini multimodal visual review", metadata: { evidenceClass: "multimodal-visual-review", configuredModel: config.model, checkpoint: config.checkpoint } }
    ];
    try {
      const evidence = await collectEvidence(input, config);
      artifacts.push(...evidence.contractArtifacts);
      const prompt = reviewPrompt(input.campaign, config, evidence.media, evidence.trace, evidence.contractText);
      await writeFile(requestPath, `${JSON.stringify({ apiVersion: REPORT_VERSION, checkpoint: config.checkpoint, configuredModel: config.model, promptSha256: sha256(Buffer.from(prompt)), evidence: evidence.media.map(({ id, role, kind, mediaType, label, sha256, metadata }) => ({ id, role, kind, mediaType, label, sha256, metadata })), contracts: evidence.contractArtifacts.map((artifact) => ({ path: relative(input.candidate!.root, artifact.path).replaceAll("\\", "/"), sha256: artifact.sha256 })), trace: evidence.traceArtifact ? { protocol: TRACE_PROTOCOL, sha256: evidence.traceArtifact.sha256 } : null }, null, 2)}\n`, "utf8");
      const credential = await resolveCredential(config.credentialName, config.apiKeyEnvironment, this.dependencies.credentialStore);
      if (!credential) throw new Error(`Credential ${config.credentialName} is unavailable; run gamefactory credentials set ${config.credentialName} or set ${config.apiKeyEnvironment}`);
      const reserved = (this.reservations.get(input.campaign.id) ?? 0) + 1;
      if (reserved > config.maximumReviews) throw new Error(`Gemini visual review cap exceeded: ${reserved} requested, maximum ${config.maximumReviews}`);
      this.reservations.set(input.campaign.id, reserved);
      const providerInput: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
      for (const item of evidence.media) {
        providerInput.push({ type: "text", text: `Evidence ${item.id}: ${item.role} ${item.kind}; ${item.label}; sha256 ${item.sha256}` });
        providerInput.push({ type: item.kind, data: item.bytes.toString("base64"), mime_type: item.mediaType, resolution: config.mediaResolution });
      }
      const body = { model: config.model, input: providerInput, response_format: { type: "text", mime_type: "application/json", schema: responseSchema } };
      const response = await (this.dependencies.fetchImpl ?? fetch)(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": credential.value, "Api-Revision": API_REVISION }, body: JSON.stringify(body), signal: AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]) });
      if (!response.ok) throw new Error(`Gemini visual review request failed with HTTP ${response.status}: ${await providerFailureMessage(response)}`);
      const rawResponse = await response.json() as unknown;
      const review = parseReview(JSON.parse(responseText(rawResponse)) as unknown, new Set(evidence.media.map((item) => item.id)), evidence.media.some((item) => item.role === "target"));
      const applicable = DIMENSIONS.filter((id) => !review.notApplicable.includes(id));
      const score = applicable.reduce((sum, id) => sum + review.scores[id], 0) / applicable.length;
      const violations = violationsFor(review, config, score);
      const status = violations.some((item) => item.severity === "error") ? "fail" : "pass";
      const usage = providerUsage(rawResponse, config.model);
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: REPORT_VERSION, status, checkpoint: config.checkpoint, configuredModel: config.model, credentialSource: credential.source, score, review, usage, evidence: evidence.media.map(({ id, role, kind, mediaType, label, sha256, metadata }) => ({ id, role, kind, mediaType, label, sha256, metadata })) }, null, 2)}\n`, "utf8");
      return { evaluator: this.id, version: this.version, status, metrics: { gemini_visual_review: 1, gemini_visual_score: score, gemini_visual_findings: review.findings.length, gemini_visual_blockers: review.findings.filter((item) => item.severity === "blocker").length, gemini_visual_majors: review.findings.filter((item) => item.severity === "major").length, ...Object.fromEntries(DIMENSIONS.map((id) => [`gemini_visual_${id}`, review.scores[id]])) }, violations, artifacts, confidence: review.confidence, summary: review.summary, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: REPORT_VERSION, status: "failed", configuredModel: config.model, checkpoint: config.checkpoint, error: message }, null, 2)}\n`, "utf8");
      if (!await fileExists(requestPath)) await writeFile(requestPath, `${JSON.stringify({ apiVersion: REPORT_VERSION, status: "failed-before-request", configuredModel: config.model, checkpoint: config.checkpoint }, null, 2)}\n`, "utf8");
      return this.failed(message, artifacts, config.model);
    }
  }

  private failed(message: string, artifacts: ArtifactReference[] = [], model?: string): Evaluation {
    return { evaluator: this.id, version: this.version, status: "fail", metrics: { gemini_visual_review: 0, gemini_visual_score: 0 }, violations: [{ code: "gemini.visual.unavailable", message, severity: "error" }], artifacts, confidence: 0, summary: `Gemini visual review failed closed: ${message}`, ...(model ? { usage: { provider: "google", model, billingMode: "metered", identitySource: "configured" } } : {}) };
  }
}

export class GeminiVisualReviewAgent implements AgentDriver {
  readonly id: string;
  constructor(
    checkpoint: "embodied" | "production",
    private readonly evaluator: GeminiVisualEvaluator
  ) {
    this.checkpoint = checkpoint;
    this.id = `gemini.visual-${checkpoint}`;
  }
  private readonly checkpoint: "embodied" | "production";

  async run(request: Parameters<AgentDriver["run"]>[0]): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const manifestPath = resolve(request.candidate.root, ".factory", "runs", request.experimentId, "godot-evidence", "result.json");
    let priorEvaluations: Evaluation[] = [];
    try {
      const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")) as unknown, "Godot evidence manifest");
      const status = manifest.status === "pass" ? "pass" : "fail";
      const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts.filter((item): item is ArtifactReference => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).kind === "string")) : [];
      priorEvaluations = [{ evaluator: "godot.scenario", version: "factory-evidence", status, metrics: {}, violations: [], artifacts: manifestArtifacts }];
    } catch { /* evaluator reports the missing trusted trace with a preserved fail-closed report */ }
    const rawVisual = request.campaign.parameters?.geminiVisualReview;
    const visual = rawVisual && typeof rawVisual === "object" && !Array.isArray(rawVisual) ? rawVisual as Record<string, unknown> : {};
    const checkpointContractPaths = visual[`${this.checkpoint}ContractPaths`];
    const campaign: Campaign = { ...request.campaign, parameters: { ...(request.campaign.parameters ?? {}), geminiVisualReview: { ...visual, checkpoint: this.checkpoint, ...(Array.isArray(checkpointContractPaths) ? { contractPaths: checkpointContractPaths } : {}) } } };
    const evaluation = await this.evaluator.evaluate({ campaign, candidate: request.candidate, experimentId: request.experimentId, priorEvaluations, signal: request.signal });
    const reportArtifact = evaluation.artifacts.find((artifact) => artifact.label === "Gemini multimodal visual review");
    let structured: Record<string, unknown> = { findings: [], metrics: evaluation.metrics };
    if (reportArtifact) {
      try {
        const report = record(JSON.parse(await readFile(reportArtifact.path, "utf8")) as unknown, "Gemini visual report");
        const review = report.review && typeof report.review === "object" && !Array.isArray(report.review) ? report.review as Record<string, unknown> : {};
        structured = {
          findings: Array.isArray(review.findings) ? review.findings : [],
          scores: review.scores ?? {},
          strengths: review.strengths ?? [],
          evidence: Array.isArray(report.evidence) ? report.evidence : [],
          verdict: review.verdict,
          metrics: evaluation.metrics,
          reportStatus: report.status
        };
      } catch { /* the evaluation already carries the fail-closed violation */ }
    }
    const unavailable = evaluation.violations.some((violation) => violation.code === "gemini.visual.unavailable");
    if (unavailable) {
      throw new GeminiVisualReviewUnavailableError(
        evaluation.summary ?? `${this.checkpoint} Gemini visual review was unavailable`,
        evaluation.artifacts
      );
    }
    const configuredFailureSeverities = new Set(settings(campaign).failureSeverities);
    const ownedFailures = Array.isArray(structured.findings)
      ? structured.findings.filter((finding): finding is Finding => Boolean(
        finding
        && typeof finding === "object"
        && !Array.isArray(finding)
        && configuredFailureSeverities.has((finding as Finding).severity)
      ))
      : [];
    const outcome = evaluation.status === "pass"
      ? "pass"
      : ownedFailures.some((finding) => finding.owner === "spec")
          ? "spec_amendment"
          : ownedFailures.some((finding) => finding.owner === "target")
            ? "target_revision"
            : "revise";
    const finishedAt = new Date().toISOString();
    const contributor: AgentContribution = {
      agentId: `google:${settings(campaign).model}`,
      role: "critic",
      status: "complete",
      startedAt,
      finishedAt,
      summary: evaluation.summary ?? `${this.checkpoint} visual review ${evaluation.status}`,
      artifacts: evaluation.artifacts,
      ...(evaluation.usage ? { usage: evaluation.usage } : {}),
      metadata: { checkpoint: this.checkpoint, evaluator: this.evaluator.id, outcome }
    };
    return {
      summary: contributor.summary,
      artifacts: evaluation.artifacts,
      contributors: [contributor],
      ...(evaluation.usage ? { usage: evaluation.usage } : {}),
      metadata: { outcome, checkpoint: this.checkpoint, structured, metrics: evaluation.metrics, violations: evaluation.violations }
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

export default defineExtension((api) => {
  const evaluator = new GeminiVisualEvaluator();
  const embodied = api.register("agent", "gemini.visual-embodied", new GeminiVisualReviewAgent("embodied", evaluator));
  const production = api.register("agent", "gemini.visual-production", new GeminiVisualReviewAgent("production", evaluator));
  const registeredEvaluator = api.register("evaluator", "gemini.visual", evaluator);
  return { async dispose() { await registeredEvaluator.dispose(); await production.dispose(); await embodied.dispose(); } };
});
