import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Evaluation, EvaluationRequest, Evaluator, Violation } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";
import { gameSpecFingerprint, loadGameSpec } from "@gamefactory/project-sdk";

interface Config {
  path: string;
  conceptPath: string;
  projectId?: string;
  requireFrozen: boolean;
  requiredClaims: string[];
  requiredSlices: string[];
  maximumConvergencePasses?: number;
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value as string[])];
}

function config(request: EvaluationRequest): Config {
  const value = request.campaign.parameters?.gameSpec;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("parameters.gameSpec must configure the game.spec evaluator");
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) throw new Error("parameters.gameSpec.path must be a non-empty candidate-relative path");
  if (typeof record.conceptPath !== "string" || record.conceptPath.length === 0) throw new Error("parameters.gameSpec.conceptPath must be a non-empty candidate-relative path");
  if (record.projectId !== undefined && (typeof record.projectId !== "string" || record.projectId.length === 0)) throw new Error("parameters.gameSpec.projectId must be a non-empty string");
  if (record.requireFrozen !== undefined && typeof record.requireFrozen !== "boolean") throw new Error("parameters.gameSpec.requireFrozen must be a boolean");
  if (record.maximumRevision !== undefined) throw new Error("parameters.gameSpec.maximumRevision is unsupported; convergence is bounded per episode with maximumConvergencePasses");
  if (record.maximumConvergencePasses !== undefined && (!Number.isSafeInteger(record.maximumConvergencePasses) || (record.maximumConvergencePasses as number) < 1 || (record.maximumConvergencePasses as number) > 100)) throw new Error("parameters.gameSpec.maximumConvergencePasses must be from 1 to 100");
  return { path: record.path, conceptPath: record.conceptPath, ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}), requireFrozen: record.requireFrozen !== false, requiredClaims: strings(record.requiredClaims, "parameters.gameSpec.requiredClaims"), requiredSlices: strings(record.requiredSlices, "parameters.gameSpec.requiredSlices"), ...(typeof record.maximumConvergencePasses === "number" ? { maximumConvergencePasses: record.maximumConvergencePasses } : {}) };
}

function candidatePath(root: string, path: string, label: string): string {
  if (path.includes("\0") || isAbsolute(path)) throw new Error(`${label} must be candidate-relative`);
  const target = resolve(root, path);
  const traversal = relative(root, target);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`${label} must stay inside the candidate`);
  return target;
}

function normalizedText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export class GameSpecEvaluator implements Evaluator {
  readonly id = "game.spec";
  readonly version = "1.0.0";

  async evaluate(request: EvaluationRequest): Promise<Evaluation> {
    if (!request.candidate) return { evaluator: this.id, version: this.version, status: "inconclusive", metrics: {}, violations: [{ code: "game-spec.no-candidate", message: "GameSpec validation requires a candidate workspace.", severity: "warning" }], artifacts: [], summary: "No candidate GameSpec was available." };
    const settings = config(request);
    const specPath = candidatePath(request.candidate.root, settings.path, "parameters.gameSpec.path");
    const conceptPath = candidatePath(request.candidate.root, settings.conceptPath, "parameters.gameSpec.conceptPath");
    const violations: Violation[] = [];
    try {
      const [spec, concept] = await Promise.all([loadGameSpec(specPath, settings.projectId), readFile(conceptPath, "utf8")]);
      if (settings.maximumConvergencePasses !== undefined && (request.campaign.budget?.maximumExperiments === undefined || request.campaign.budget.maximumExperiments > settings.maximumConvergencePasses)) violations.push({ code: "game-spec.unbounded-convergence", message: `Campaign maximumExperiments must be configured at or below maximumConvergencePasses ${settings.maximumConvergencePasses}.`, severity: "error" });
      if (normalizedText(spec.concept) !== normalizedText(concept)) violations.push({ code: "game-spec.concept-changed", message: "GameSpec must preserve the supplied concept verbatim.", severity: "error", location: settings.path });
      if (settings.requireFrozen && spec.status !== "frozen") violations.push({ code: "game-spec.not-frozen", message: `GameSpec revision ${spec.revision} is not frozen.`, severity: "error", location: settings.path });
      const claims = new Map(spec.claims.map((claim) => [claim.id, claim]));
      const sliceIds = new Set(spec.slices.map((slice) => slice.id));
      for (const claim of settings.requiredClaims) {
        const current = claims.get(claim);
        if (!current) violations.push({ code: "game-spec.missing-claim", message: `Required claim ${claim} is missing.`, severity: "error", location: settings.path });
        else if (current.status === "open") violations.push({ code: "game-spec.unresolved-claim", message: `Required claim ${claim} is still open.`, severity: "error", location: settings.path });
      }
      for (const slice of settings.requiredSlices) if (!sliceIds.has(slice)) violations.push({ code: "game-spec.missing-slice", message: `Required slice ${slice} is missing.`, severity: "error", location: settings.path });
      const status = violations.some((violation) => violation.severity === "error") ? "fail" : "pass";
      return { evaluator: this.id, version: this.version, status, metrics: { spec_valid: status === "pass" ? 1 : 0, spec_frozen: spec.status === "frozen" ? 1 : 0, spec_revision: spec.revision, spec_claims: spec.claims.length, spec_slices: spec.slices.length }, violations, artifacts: [{ kind: "other", path: specPath, mediaType: "application/json", label: `GameSpec r${spec.revision}`, sha256: gameSpecFingerprint(spec) }], confidence: 1, summary: status === "pass" ? `Frozen GameSpec r${spec.revision} preserves the concept and covers ${spec.claims.length} claims across ${spec.slices.length} slices.` : `GameSpec validation failed with ${violations.length} violation(s).` };
    } catch (error) {
      return { evaluator: this.id, version: this.version, status: "fail", metrics: { spec_valid: 0 }, violations: [{ code: "game-spec.invalid", message: error instanceof Error ? error.message : String(error), severity: "error", location: settings.path }], artifacts: [], confidence: 1, summary: "GameSpec could not be validated." };
    }
  }
}

export default defineExtension((api) => api.register("evaluator", "game.spec", new GameSpecEvaluator()));
