import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  ASSET_API_VERSION,
  candidateSlot,
  parseAssetBrief,
  parseGeneratorReport,
  parseStyleProfile,
  resolveProjectAssetPath,
  styleProfileSha256,
  type AssetBrief,
  type AssetGenerationRequest,
  type AssetManifest,
  type StyleCriterion,
  type StyleProfile
} from "@gamefactory/asset-sdk";
import type { AgentContribution, AgentDriver, AgentResult, ArtifactReference, Candidate, Evaluation, Evaluator, Violation } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";
import { inspectPng } from "./png.js";

interface FoundryConfig {
  briefPath: string;
  manifestPath: string;
  generatorCommand: string[];
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
    ? [...value]
    : [];
}

function foundryConfig(campaign: Parameters<AgentDriver["run"]>[0]["campaign"]): FoundryConfig {
  const asset = object(campaign.parameters?.asset);
  const generatorCommand = stringArray(asset.generatorCommand);
  if (generatorCommand.length === 0) throw new Error("parameters.asset.generatorCommand must be a non-empty command string array");
  return {
    briefPath: typeof asset.briefPath === "string" ? asset.briefPath : "asset-brief.json",
    manifestPath: typeof asset.manifestPath === "string" ? asset.manifestPath : "assets.manifest.json",
    generatorCommand
  };
}

function execute(command: string[], cwd: string, requestPath: string, resultPath: string, signal: AbortSignal): Promise<ProcessResult> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Asset generator command has no executable");
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      signal,
      windowsHide: true,
      env: {
        ...process.env,
        GAMEFACTORY_ASSET_REQUEST: requestPath,
        GAMEFACTORY_ASSET_RESULT: resultPath,
        GAMEFACTORY_CANDIDATE: cwd
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function artifact(path: string, kind: ArtifactReference["kind"], label: string, mediaType: string): ArtifactReference {
  return { path, kind, label, mediaType };
}

async function readBrief(candidate: Candidate, briefPath: string) {
  const path = resolveProjectAssetPath(candidate.root, briefPath);
  return { path, brief: parseAssetBrief(JSON.parse(await readFile(path, "utf8"))) };
}

interface ResolvedStyleProfile {
  path: string;
  sha256: string;
  profile: StyleProfile;
  references: Array<{ path: string; role: string; sha256: string; content: Buffer }>;
}

async function readStyleProfile(candidate: Candidate, brief: AssetBrief): Promise<ResolvedStyleProfile | undefined> {
  if (!brief.style) return undefined;
  const path = resolveProjectAssetPath(candidate.root, brief.style.profilePath);
  const content = await readFile(path);
  const profile = parseStyleProfile(JSON.parse(content.toString("utf8")));
  const sha256 = styleProfileSha256(profile);
  if (brief.style.profileSha256 !== sha256) throw new Error(`Style profile hash mismatch for ${brief.style.profilePath}`);
  if (profile.id !== brief.style.profileId || profile.version !== brief.style.profileVersion) {
    throw new Error(`Style profile identity mismatch: brief pins ${brief.style.profileId}@${brief.style.profileVersion}, profile is ${profile.id}@${profile.version}`);
  }
  const references = await Promise.all(profile.references.map(async (reference) => {
    const referencePath = resolveProjectAssetPath(candidate.root, reference.path);
    const referenceContent = await readFile(referencePath);
    const sha256 = createHash("sha256").update(referenceContent).digest("hex");
    if (reference.sha256 && reference.sha256.toLowerCase() !== sha256) {
      throw new Error(`Style reference hash mismatch for ${reference.path}`);
    }
    return { path: referencePath, role: reference.role, sha256, content: referenceContent };
  }));
  return {
    path,
    sha256,
    profile,
    references
  };
}

export class CommandAssetFoundryAgent implements AgentDriver {
  readonly id = "asset.command";

  async run(request: Parameters<AgentDriver["run"]>[0]): Promise<AgentResult> {
    const config = foundryConfig(request.campaign);
    const { path: briefPath, brief } = await readBrief(request.candidate, config.briefPath);
    const style = await readStyleProfile(request.candidate, brief);
    const outputPath = resolveProjectAssetPath(request.candidate.root, brief.output.path);
    const manifestPath = resolveProjectAssetPath(request.candidate.root, config.manifestPath);
    const runDirectory = resolve(request.candidate.root, ".factory", "asset-foundry", request.experimentId);
    const requestPath = resolve(runDirectory, "request.json");
    const resultPath = resolve(runDirectory, "generator-result.json");
    const stdoutPath = resolve(runDirectory, "generator.stdout.log");
    const stderrPath = resolve(runDirectory, "generator.stderr.log");
    await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(dirname(outputPath), { recursive: true }), mkdir(dirname(manifestPath), { recursive: true })]);
    const payload: AssetGenerationRequest = {
      apiVersion: ASSET_API_VERSION,
      experimentId: request.experimentId,
      candidateId: request.candidate.id,
      candidateSlot: candidateSlot(request.experimentId),
      candidateRoot: request.candidate.root,
      briefPath,
      outputPath,
      resultPath,
      brief
    };
    await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const startedAt = new Date().toISOString();
    const run = await execute(config.generatorCommand, request.candidate.root, requestPath, resultPath, request.signal);
    const finishedAt = new Date().toISOString();
    await Promise.all([writeFile(stdoutPath, run.stdout, "utf8"), writeFile(stderrPath, run.stderr, "utf8")]);
    if (run.code !== 0) throw new Error(`Asset generator exited ${run.code}: ${run.stderr.trim()}`);
    const report = parseGeneratorReport(JSON.parse(await readFile(resultPath, "utf8")));
    const content = await readFile(outputPath);
    const details = await stat(outputPath);
    if (!details.isFile()) throw new Error(`Asset generator output is not a file: ${outputPath}`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const manifest: AssetManifest = {
      apiVersion: ASSET_API_VERSION,
      briefId: brief.id,
      candidateId: request.candidate.id,
      experimentId: request.experimentId,
      generatedAt: finishedAt,
      files: [{ path: brief.output.path.replaceAll("\\", "/"), mediaType: brief.output.mediaType, sha256, bytes: details.size }],
      recipe: {
        generator: report.generator,
        prompt: report.prompt,
        processors: report.processors ?? [],
        ...(report.seed !== undefined ? { seed: report.seed } : {}),
        ...(report.source ? { source: report.source } : {}),
        ...(report.license ? { license: report.license } : {}),
        ...(report.metadata ? { metadata: report.metadata } : {})
      },
      ...(style && brief.style ? {
        style: {
          profileId: style.profile.id,
          profileVersion: style.profile.version,
          profilePath: brief.style.profilePath.replaceAll("\\", "/"),
          profileSha256: style.sha256,
          references: style.profile.references.map((reference, index) => ({
            path: reference.path.replaceAll("\\", "/"),
            role: reference.role,
            sha256: style.references[index]?.sha256 ?? ""
          }))
        }
      } : {}),
      metadata: { modality: brief.modality, role: brief.role }
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const artifacts: ArtifactReference[] = [
      artifact(requestPath, "other", "Asset generation request", "application/json"),
      artifact(resultPath, "other", "Asset generator report", "application/json"),
      artifact(stdoutPath, "log", "Asset generator stdout", "text/plain"),
      artifact(stderrPath, "log", "Asset generator stderr", "text/plain"),
      artifact(outputPath, brief.modality === "image" ? "image" : brief.modality === "audio" ? "audio" : "other", `Generated ${brief.role}`, brief.output.mediaType),
      artifact(manifestPath, "other", "Production asset manifest", "application/json"),
      ...(style ? [
        artifact(style.path, "other", `Style profile ${style.profile.id}@${style.profile.version}`, "application/json"),
        ...style.references.map((reference) => artifact(reference.path, brief.modality === "image" ? "image" : "other", `Style reference: ${reference.role}`, brief.output.mediaType))
      ] : [])
    ];
    const contributor: AgentContribution = {
      agentId: report.generator.id,
      role: "worker",
      status: "complete",
      startedAt,
      finishedAt,
      summary: `Generated ${brief.id} with ${report.generator.id}`,
      artifacts,
      metadata: {
        modality: brief.modality,
        output: brief.output.path,
        sha256,
        command: config.generatorCommand,
        ...(style ? { styleProfile: `${style.profile.id}@${style.profile.version}`, styleProfileSha256: style.sha256 } : {})
      }
    };
    return {
      summary: `${report.generator.id} generated ${brief.role} at ${brief.output.path}`,
      artifacts,
      contributors: [contributor],
      metadata: {
        assetManifest: config.manifestPath,
        assetId: brief.id,
        modality: brief.modality,
        sha256,
        ...(style ? { styleProfile: `${style.profile.id}@${style.profile.version}`, styleProfileSha256: style.sha256 } : {})
      }
    };
  }
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class AssetTechnicalEvaluator implements Evaluator {
  readonly id = "asset.technical";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const config = foundryConfig(input.campaign);
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    const { brief } = await readBrief(candidate, config.briefPath);
    const outputPath = resolveProjectAssetPath(candidate.root, brief.output.path);
    const manifestPath = resolveProjectAssetPath(candidate.root, config.manifestPath);
    let content: Buffer;
    try {
      content = await readFile(outputPath);
    } catch {
      const baseline = input.candidate === null;
      return {
        evaluator: this.id,
        version: this.version,
        status: baseline ? "pass" : "fail",
        metrics: { asset_present: 0, asset_quality: 0 },
        violations: [{
          code: "asset.output.missing",
          message: baseline ? "No production asset exists yet; candidates may establish the first baseline." : `Generator did not create ${brief.output.path}`,
          severity: baseline ? "info" : "error"
        }],
        artifacts: [],
        confidence: 1,
        summary: baseline ? "Measured an empty asset baseline." : "Generated asset is missing."
      };
    }
    if (brief.modality !== "image" || brief.output.mediaType !== "image/png") {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { asset_present: 1, asset_quality: 0 },
        violations: [{ code: "asset.modality.unsupported", message: "This evaluator currently implements the image/png technical profile.", severity: "error" }],
        artifacts: [artifact(outputPath, "other", `Generated ${brief.role}`, brief.output.mediaType)],
        confidence: 1,
        summary: "A modality-specific evaluator extension is required."
      };
    }
    try {
      const technical = brief.technical;
      const inspection = inspectPng(content, number(technical.marginPixels, 0) || undefined);
      const targetWidth = number(technical.width, inspection.width);
      const targetHeight = number(technical.height, inspection.height);
      const coverageTarget = number(technical.coverageTarget, 0.45);
      const coverageTolerance = Math.max(0.01, number(technical.coverageTolerance, 0.35));
      const dimensionScore = inspection.width === targetWidth && inspection.height === targetHeight ? 1 : 0;
      const alphaScore = inspection.hasAlpha ? inspection.transparentCorners : 0;
      const coverageScore = Math.max(0, 1 - Math.abs(inspection.opaqueCoverage - coverageTarget) / coverageTolerance);
      const quality = Number((dimensionScore * 0.2 + alphaScore * 0.2 + inspection.safeMargin * 0.2 + coverageScore * 0.2 + inspection.contrast * 0.2).toFixed(6));
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<AssetManifest>;
      const sha256 = createHash("sha256").update(content).digest("hex");
      const manifestHash = manifest.files?.find((file) => file.path.replaceAll("\\", "/") === brief.output.path.replaceAll("\\", "/"))?.sha256;
      const violations = [];
      if (dimensionScore === 0) violations.push({ code: "asset.image.dimensions", message: `Expected ${targetWidth}x${targetHeight}, received ${inspection.width}x${inspection.height}.`, severity: "error" as const });
      if (!inspection.hasAlpha) violations.push({ code: "asset.image.alpha", message: "Image must contain an alpha channel.", severity: "error" as const });
      if (manifestHash !== sha256) violations.push({ code: "asset.manifest.hash", message: "Asset manifest hash does not match the production file.", severity: "error" as const });
      return {
        evaluator: this.id,
        version: this.version,
        status: violations.length === 0 ? "pass" : "fail",
        metrics: {
          asset_present: 1,
          asset_quality: quality,
          width: inspection.width,
          height: inspection.height,
          has_alpha: inspection.hasAlpha ? 1 : 0,
          transparent_corners: Number(inspection.transparentCorners.toFixed(6)),
          safe_margin: Number(inspection.safeMargin.toFixed(6)),
          opaque_coverage: Number(inspection.opaqueCoverage.toFixed(6)),
          contrast: Number(inspection.contrast.toFixed(6)),
          manifest_integrity: manifestHash === sha256 ? 1 : 0
        },
        violations,
        artifacts: [
          artifact(outputPath, "image", `Generated ${brief.role}`, "image/png"),
          artifact(manifestPath, "other", "Production asset manifest", "application/json")
        ],
        confidence: 1,
        summary: `PNG ${inspection.width}x${inspection.height}; technical quality ${quality}.`
      };
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { asset_present: 1, asset_quality: 0 },
        violations: [{ code: "asset.image.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [artifact(outputPath, "image", `Invalid ${brief.role}`, brief.output.mediaType)],
        confidence: 1,
        summary: "PNG inspection failed."
      };
    }
  }
}

const STYLE_METRICS = [
  "opaque_coverage",
  "contrast",
  "red_dominance",
  "horizontal_symmetry",
  "vertical_symmetry",
  "mean_red",
  "mean_green",
  "mean_blue",
  "transparent_corners",
  "safe_margin"
] as const;

type StyleMetric = typeof STYLE_METRICS[number];

function criterionScore(value: number, criterion: StyleCriterion): number {
  if (criterion.target !== undefined) {
    const tolerance = criterion.tolerance ?? 0.1;
    return Math.max(0, 1 - Math.abs(value - criterion.target) / tolerance);
  }
  const tolerance = criterion.tolerance ?? Math.max(0.1, (criterion.max ?? 1) - (criterion.min ?? 0));
  if (criterion.min !== undefined && value < criterion.min) return Math.max(0, 1 - (criterion.min - value) / tolerance);
  if (criterion.max !== undefined && value > criterion.max) return Math.max(0, 1 - (value - criterion.max) / tolerance);
  return 1;
}

function hardCriterionFailed(value: number, criterion: StyleCriterion): boolean {
  if (!criterion.hard) return false;
  if (criterion.min !== undefined && value < criterion.min) return true;
  if (criterion.max !== undefined && value > criterion.max) return true;
  return criterion.target !== undefined && criterion.tolerance !== undefined && Math.abs(value - criterion.target) > criterion.tolerance;
}

function styleMetrics(content: Buffer): Record<StyleMetric, number> {
  const inspection = inspectPng(content);
  return {
    opaque_coverage: inspection.opaqueCoverage,
    contrast: inspection.contrast,
    red_dominance: inspection.redDominance,
    horizontal_symmetry: inspection.horizontalSymmetry,
    vertical_symmetry: inspection.verticalSymmetry,
    mean_red: inspection.meanRed,
    mean_green: inspection.meanGreen,
    mean_blue: inspection.meanBlue,
    transparent_corners: inspection.transparentCorners,
    safe_margin: inspection.safeMargin
  };
}

function compareStyleMetrics(left: Record<StyleMetric, number>, right: Record<StyleMetric, number>): number {
  const distance = STYLE_METRICS.reduce((sum, metric) => sum + Math.abs(left[metric] - right[metric]), 0) / STYLE_METRICS.length;
  return Math.max(0, 1 - distance);
}

export class AssetStyleEvaluator implements Evaluator {
  readonly id = "asset.style";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const config = foundryConfig(input.campaign);
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    let brief: AssetBrief;
    let style: ResolvedStyleProfile | undefined;
    try {
      ({ brief } = await readBrief(candidate, config.briefPath));
      style = await readStyleProfile(candidate, brief);
      if (!style) throw new Error("Asset brief does not pin a style profile");
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { style_alignment: 0, profile_integrity: 0 },
        violations: [{ code: "asset.style.profile", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [],
        confidence: 1,
        summary: "Style profile verification failed."
      };
    }
    const modality = style.profile.modalities[brief.modality];
    if (!modality) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { style_alignment: 0, profile_integrity: 1 },
        violations: [{ code: "asset.style.modality", message: `Style profile has no ${brief.modality} criteria.`, severity: "error" }],
        artifacts: [artifact(style.path, "other", `Style profile ${style.profile.id}`, "application/json")],
        confidence: 1,
        summary: "The pinned style profile does not support this modality."
      };
    }
    const outputPath = resolveProjectAssetPath(candidate.root, brief.output.path);
    let content: Buffer;
    try {
      content = await readFile(outputPath);
    } catch {
      const baseline = input.candidate === null;
      return {
        evaluator: this.id,
        version: this.version,
        status: baseline ? "pass" : "fail",
        metrics: { style_alignment: 0, reference_similarity: 0, profile_integrity: 1 },
        violations: [{
          code: "asset.style.output.missing",
          message: baseline ? "No production asset exists yet; candidates may establish the first styled baseline." : `Generator did not create ${brief.output.path}`,
          severity: baseline ? "info" : "error"
        }],
        artifacts: [artifact(style.path, "other", `Style profile ${style.profile.id}`, "application/json")],
        confidence: 1,
        summary: baseline ? "Measured an empty style baseline." : "Generated asset is missing."
      };
    }
    if (brief.modality !== "image" || brief.output.mediaType !== "image/png") {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { style_alignment: 0, profile_integrity: 1 },
        violations: [{ code: "asset.style.unsupported", message: "This evaluator currently implements deterministic image/png style metrics.", severity: "error" }],
        artifacts: [artifact(outputPath, "other", `Generated ${brief.role}`, brief.output.mediaType)],
        confidence: 1,
        summary: "A modality-specific style evaluator extension is required."
      };
    }
    try {
      const metrics = styleMetrics(content);
      const violations: Violation[] = [];
      let weightedScore = 0;
      let totalWeight = 0;
      for (const criterion of modality.criteria) {
        if (!STYLE_METRICS.includes(criterion.metric as StyleMetric)) {
          violations.push({ code: "asset.style.metric.unsupported", message: `Unsupported image style metric: ${criterion.metric}`, severity: "error" });
          continue;
        }
        const value = metrics[criterion.metric as StyleMetric];
        weightedScore += criterionScore(value, criterion) * criterion.weight;
        totalWeight += criterion.weight;
        if (hardCriterionFailed(value, criterion)) {
          violations.push({ code: `asset.style.${criterion.metric}`, message: `${criterion.metric}=${value.toFixed(6)} violates its hard style criterion.`, severity: "error" });
        }
      }
      const criteriaScore = totalWeight > 0 ? weightedScore / totalWeight : 1;
      const referenceScores = style.references.map((reference) => compareStyleMetrics(metrics, styleMetrics(reference.content)));
      const referenceSimilarity = referenceScores.length > 0
        ? referenceScores.reduce((sum, value) => sum + value, 0) / referenceScores.length
        : criteriaScore;
      const styleAlignment = Number((referenceScores.length > 0
        ? criteriaScore * 0.6 + referenceSimilarity * 0.4
        : criteriaScore).toFixed(6));
      return {
        evaluator: this.id,
        version: this.version,
        status: violations.some((violation) => violation.severity === "error") ? "fail" : "pass",
        metrics: {
          ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number(value.toFixed(6))])),
          criteria_score: Number(criteriaScore.toFixed(6)),
          reference_similarity: Number(referenceSimilarity.toFixed(6)),
          style_alignment: styleAlignment,
          profile_integrity: 1
        },
        violations,
        artifacts: [
          artifact(outputPath, "image", `Style-scored ${brief.role}`, "image/png"),
          artifact(style.path, "other", `Style profile ${style.profile.id}@${style.profile.version}`, "application/json"),
          ...style.references.map((reference) => artifact(reference.path, "image", `Style reference: ${reference.role}`, "image/png"))
        ],
        confidence: 1,
        summary: `${style.profile.id}@${style.profile.version} alignment ${styleAlignment}; ${modality.criteria.length} deterministic criteria.`
      };
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { style_alignment: 0, profile_integrity: 1 },
        violations: [{ code: "asset.style.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [artifact(outputPath, "image", `Invalid ${brief.role}`, brief.output.mediaType)],
        confidence: 1,
        summary: "Style inspection failed."
      };
    }
  }
}

export { inspectPng } from "./png.js";

export default defineExtension((api) => combineDisposables(
  api.register("agent", "asset.command", new CommandAssetFoundryAgent()),
  api.register("evaluator", "asset.technical", new AssetTechnicalEvaluator()),
  api.register("evaluator", "asset.style", new AssetStyleEvaluator())
));
