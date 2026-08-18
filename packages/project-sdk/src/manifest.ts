import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { GameFactoryProject, LoadedGameFactoryProject, LoadedProjectPhaseAttempt, ProjectAttemptPolicy, ProjectEvidenceGate, ProjectPhase, ProjectPhaseAttempt, ProjectPhaseGate, ProjectSlice, ProjectSpecStage } from "./types.js";

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} contains unsupported characters`);
}

function stringList(value: unknown, label: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`${label} must be an array of non-empty strings`);
  const output = [...new Set(value as string[])];
  if (required && output.length === 0) throw new Error(`${label} must contain at least one value`);
  return output;
}

function inside(root: string, value: string, label: string): string {
  if (value.includes("\0") || isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const target = resolve(root, value);
  const traversal = relative(root, target);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`${label} must stay inside the project root`);
  return target;
}

function attempt(value: unknown, label: string): ProjectPhaseAttempt {
  object(value, label);
  string(value.id, `${label}.id`);
  safeId(value.id, `${label}.id`);
  string(value.campaign, `${label}.campaign`);
  string(value.config, `${label}.config`);
  if (value.status !== undefined && !["active", "superseded", "archived"].includes(String(value.status))) throw new Error(`${label}.status is invalid`);
  return {
    id: value.id,
    campaign: value.campaign,
    config: value.config,
    ...(value.status !== undefined ? { status: value.status as NonNullable<ProjectPhaseAttempt["status"]> } : {})
  };
}

function attempts(value: unknown, label: string): ProjectPhaseAttempt[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one attempt`);
  const output = value.map((item, index) => attempt(item, `${label}[${index}]`));
  if (new Set(output.map((item) => item.id)).size !== output.length) throw new Error(`${label} contains duplicate attempt ids`);
  if (output.filter((item) => (item.status ?? "active") === "active").length !== 1) throw new Error(`${label} must contain exactly one active attempt`);
  return output;
}

function gate(value: unknown, label: string): ProjectPhaseGate | undefined {
  if (value === undefined) return undefined;
  object(value, label);
  const requireMetrics = value.requireMetrics;
  if (requireMetrics !== undefined) {
    object(requireMetrics, `${label}.requireMetrics`);
    for (const [metric, bounds] of Object.entries(requireMetrics)) {
      object(bounds, `${label}.requireMetrics.${metric}`);
      for (const key of ["minimum", "maximum"] as const) {
        const bound = bounds[key];
        if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) throw new Error(`${label}.requireMetrics.${metric}.${key} must be finite`);
      }
    }
  }
  return {
    ...(typeof value.requireAcceptedRevision === "boolean" ? { requireAcceptedRevision: value.requireAcceptedRevision } : {}),
    ...(typeof value.requireHumanApproval === "boolean" ? { requireHumanApproval: value.requireHumanApproval } : {}),
    ...(requireMetrics ? { requireMetrics: requireMetrics as Record<string, { minimum?: number; maximum?: number }> } : {})
  };
}

function phase(value: unknown, index: number): ProjectPhase {
  const label = `Project phases[${index}]`;
  object(value, label);
  string(value.id, `${label}.id`);
  safeId(value.id, `${label}.id`);
  string(value.title, `${label}.title`);
  if (!Number.isSafeInteger(value.order)) throw new Error(`${label}.order must be a safe integer`);
  if (!Array.isArray(value.attempts) || value.attempts.length === 0) throw new Error(`${label}.attempts must contain at least one attempt`);
  const dependsOn = value.dependsOn;
  if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== "string"))) throw new Error(`${label}.dependsOn must be an array of phase ids`);
  const parsedAttempts = attempts(value.attempts, `${label}.attempts`);
  const parsedGate = gate(value.gate, `${label}.gate`);
  return { id: value.id, title: value.title, order: value.order as number, ...(dependsOn ? { dependsOn: [...dependsOn] as string[] } : {}), ...(parsedGate ? { gate: parsedGate } : {}), attempts: parsedAttempts, workKind: "legacy-phase" };
}

function evidence(value: unknown, label: string): ProjectEvidenceGate | undefined {
  if (value === undefined) return undefined;
  object(value, label);
  for (const key of ["requireInteractionTrace", "requireEngineCapture", "requireMotionEvidence"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
  const scenarios = stringList(value.scenarios, `${label}.scenarios`);
  const requireRuntimeAssets = stringList(value.requireRuntimeAssets, `${label}.requireRuntimeAssets`);
  return { ...(scenarios.length ? { scenarios } : {}), ...(typeof value.requireInteractionTrace === "boolean" ? { requireInteractionTrace: value.requireInteractionTrace } : {}), ...(typeof value.requireEngineCapture === "boolean" ? { requireEngineCapture: value.requireEngineCapture } : {}), ...(typeof value.requireMotionEvidence === "boolean" ? { requireMotionEvidence: value.requireMotionEvidence } : {}), ...(requireRuntimeAssets.length ? { requireRuntimeAssets } : {}) };
}

function attemptPolicy(value: unknown, label: string): ProjectAttemptPolicy | undefined {
  if (value === undefined) return undefined;
  object(value, label);
  const output: ProjectAttemptPolicy = {};
  for (const key of ["executionRetries", "creativeRepairs", "specAmendments", "advisorEscalations"] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 100) throw new Error(`${label}.${key} must be a safe integer from 0 to 100`);
    output[key] = value[key] as number;
  }
  return output;
}

function specStage(value: unknown): ProjectSpecStage {
  object(value, "Project preproduction");
  if (value.id !== undefined) { string(value.id, "Project preproduction.id"); safeId(value.id, "Project preproduction.id"); }
  if (value.title !== undefined) string(value.title, "Project preproduction.title");
  string(value.concept, "Project preproduction.concept");
  string(value.spec, "Project preproduction.spec");
  if (value.maximumConvergencePasses !== undefined && (!Number.isSafeInteger(value.maximumConvergencePasses) || (value.maximumConvergencePasses as number) < 1 || (value.maximumConvergencePasses as number) > 20)) throw new Error("Project preproduction.maximumConvergencePasses must be from 1 to 20");
  if (value.maximumRevisions !== undefined && (!Number.isSafeInteger(value.maximumRevisions) || (value.maximumRevisions as number) < 1 || (value.maximumRevisions as number) > 20)) throw new Error("Project preproduction.maximumRevisions must be from 1 to 20");
  if (value.maximumConvergencePasses !== undefined && value.maximumRevisions !== undefined) throw new Error("Project preproduction must use maximumConvergencePasses or legacy maximumRevisions, not both");
  const parsedGate = gate(value.gate, "Project preproduction.gate");
  const maximumConvergencePasses = typeof value.maximumConvergencePasses === "number" ? value.maximumConvergencePasses : typeof value.maximumRevisions === "number" ? value.maximumRevisions : undefined;
  return { ...(typeof value.id === "string" ? { id: value.id } : {}), ...(typeof value.title === "string" ? { title: value.title } : {}), concept: value.concept, spec: value.spec, ...(maximumConvergencePasses !== undefined ? { maximumConvergencePasses } : {}), ...(parsedGate ? { gate: parsedGate } : {}), attempts: attempts(value.attempts, "Project preproduction.attempts") };
}

function slice(value: unknown, index: number): ProjectSlice {
  const label = `Project slices[${index}]`;
  object(value, label);
  string(value.id, `${label}.id`); safeId(value.id, `${label}.id`);
  string(value.title, `${label}.title`);
  if (!Number.isSafeInteger(value.order)) throw new Error(`${label}.order must be a safe integer`);
  string(value.playerOutcome, `${label}.playerOutcome`);
  string(value.primaryRisk, `${label}.primaryRisk`);
  const dependsOn = stringList(value.dependsOn, `${label}.dependsOn`);
  const consumesClaims = stringList(value.consumesClaims, `${label}.consumesClaims`, true);
  for (const claimId of consumesClaims) safeId(claimId, `${label}.consumesClaims`);
  const nonGoals = stringList(value.nonGoals, `${label}.nonGoals`);
  const mutablePaths = stringList(value.mutablePaths, `${label}.mutablePaths`);
  const parsedEvidence = evidence(value.evidence, `${label}.evidence`);
  const parsedPolicy = attemptPolicy(value.attemptPolicy, `${label}.attemptPolicy`);
  const parsedGate = gate(value.gate, `${label}.gate`);
  return { id: value.id, title: value.title, order: value.order as number, ...(dependsOn.length ? { dependsOn } : {}), consumesClaims, playerOutcome: value.playerOutcome, primaryRisk: value.primaryRisk, ...(nonGoals.length ? { nonGoals } : {}), ...(mutablePaths.length ? { mutablePaths } : {}), ...(parsedEvidence ? { evidence: parsedEvidence } : {}), ...(parsedPolicy ? { attemptPolicy: parsedPolicy } : {}), ...(parsedGate ? { gate: parsedGate } : {}), attempts: attempts(value.attempts, `${label}.attempts`) };
}

function validateDag(phases: ProjectPhase[]): void {
  const ids = new Set(phases.map((item) => item.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(phases.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Project phase dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Project phase ${id} depends on unknown phase ${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of phases) visit(phase.id);
}

export function projectManifestFingerprint(project: GameFactoryProject): string {
  const { history: _history, ...behavior } = project;
  return createHash("sha256").update(JSON.stringify(behavior)).digest("hex");
}

export async function loadProject(path: string): Promise<LoadedGameFactoryProject> {
  const manifestPath = resolve(path);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown; }
  catch (error) { throw new Error(`Unable to read project manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
  object(parsed, "Project");
  if (parsed.apiVersion !== "gamefactory.dev/v1" && parsed.apiVersion !== "gamefactory.dev/v2") throw new Error("Unsupported project apiVersion");
  if (parsed.kind !== "Project") throw new Error("Project kind must be Project");
  string(parsed.id, "Project id");
  safeId(parsed.id, "Project id");
  string(parsed.title, "Project title");
  string(parsed.projectRoot, "Project projectRoot");
  if (isAbsolute(parsed.projectRoot) || parsed.projectRoot.includes("\0")) throw new Error("Project projectRoot must be relative to the manifest");
  const isV2 = parsed.apiVersion === "gamefactory.dev/v2";
  let preproduction: ProjectSpecStage | undefined;
  let slices: ProjectSlice[] | undefined;
  let phases: ProjectPhase[];
  if (isV2) {
    preproduction = specStage(parsed.preproduction);
    if (!Array.isArray(parsed.slices) || parsed.slices.length === 0) throw new Error("Project slices must contain at least one slice");
    slices = parsed.slices.map(slice);
    const specId = preproduction.id ?? "spec-convergence";
    const specTitle = preproduction.title ?? "Game specification convergence";
    phases = [
      { id: specId, title: specTitle, order: 0, gate: preproduction.gate ?? { requireAcceptedRevision: true }, attempts: preproduction.attempts, workKind: "spec-convergence" },
      ...slices.map((item): ProjectPhase => ({ ...item, dependsOn: [...new Set([specId, ...(item.dependsOn ?? [])])], workKind: "vertical-slice" }))
    ];
  } else {
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) throw new Error("Project phases must contain at least one phase");
    phases = parsed.phases.map(phase);
  }
  if (new Set(phases.map((item) => item.id)).size !== phases.length) throw new Error("Project contains duplicate phase ids");
  if (new Set(phases.map((item) => item.order)).size !== phases.length) throw new Error("Project contains duplicate phase order values");
  validateDag(phases);
  const root = resolve(dirname(manifestPath), parsed.projectRoot);
  if (parsed.history !== undefined) string(parsed.history, "Project history");
  const loadAttempts = (item: ProjectPhase): LoadedProjectPhaseAttempt[] => item.attempts.map((entry) => ({ ...entry, campaignPath: inside(root, entry.campaign, `Campaign path for ${item.id}/${entry.id}`), configPath: inside(root, entry.config, `Config path for ${item.id}/${entry.id}`) }));
  const loadedPhases = phases.map((item) => ({ ...item, attempts: loadAttempts(item) }));
  const base: LoadedGameFactoryProject = {
    apiVersion: parsed.apiVersion,
    kind: "Project",
    id: parsed.id,
    title: parsed.title,
    projectRoot: parsed.projectRoot,
    ...(typeof parsed.history === "string" ? { history: parsed.history, historyPath: inside(root, parsed.history, "Project history") } : {}),
    manifestPath,
    root,
    phases: loadedPhases
  };
  if (isV2 && preproduction && slices) {
    base.preproduction = { ...preproduction, conceptPath: inside(root, preproduction.concept, "Project preproduction concept"), specPath: inside(root, preproduction.spec, "Project preproduction spec"), attempts: loadedPhases[0]!.attempts };
    base.slices = slices.map((item) => ({ ...item, attempts: loadedPhases.find((phase) => phase.id === item.id)!.attempts }));
  }
  return base;
}
