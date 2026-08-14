import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { GameFactoryProject, LoadedGameFactoryProject, ProjectPhase, ProjectPhaseAttempt } from "./types.js";

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} contains unsupported characters`);
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
  const attempts = value.attempts.map((item, attemptIndex) => attempt(item, `${label}.attempts[${attemptIndex}]`));
  if (new Set(attempts.map((item) => item.id)).size !== attempts.length) throw new Error(`${label} contains duplicate attempt ids`);
  const active = attempts.filter((item) => (item.status ?? "active") === "active");
  if (active.length !== 1) throw new Error(`${label} must contain exactly one active attempt`);
  let gate: ProjectPhase["gate"];
  if (value.gate !== undefined) {
    object(value.gate, `${label}.gate`);
    const requireMetrics = value.gate.requireMetrics;
    if (requireMetrics !== undefined) {
      object(requireMetrics, `${label}.gate.requireMetrics`);
      for (const [metric, bounds] of Object.entries(requireMetrics)) {
        object(bounds, `${label}.gate.requireMetrics.${metric}`);
        for (const key of ["minimum", "maximum"] as const) {
          const bound = bounds[key];
          if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) throw new Error(`${label}.gate.requireMetrics.${metric}.${key} must be finite`);
        }
      }
    }
    gate = {
      ...(typeof value.gate.requireAcceptedRevision === "boolean" ? { requireAcceptedRevision: value.gate.requireAcceptedRevision } : {}),
      ...(typeof value.gate.requireHumanApproval === "boolean" ? { requireHumanApproval: value.gate.requireHumanApproval } : {}),
      ...(requireMetrics ? { requireMetrics: requireMetrics as Record<string, { minimum?: number; maximum?: number }> } : {})
    };
  }
  return { id: value.id, title: value.title, order: value.order as number, ...(dependsOn ? { dependsOn: [...dependsOn] as string[] } : {}), ...(gate ? { gate } : {}), attempts };
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
  return createHash("sha256").update(JSON.stringify(project)).digest("hex");
}

export async function loadProject(path: string): Promise<LoadedGameFactoryProject> {
  const manifestPath = resolve(path);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown; }
  catch (error) { throw new Error(`Unable to read project manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
  object(parsed, "Project");
  if (parsed.apiVersion !== "gamefactory.dev/v1") throw new Error("Unsupported project apiVersion");
  if (parsed.kind !== "Project") throw new Error("Project kind must be Project");
  string(parsed.id, "Project id");
  safeId(parsed.id, "Project id");
  string(parsed.title, "Project title");
  string(parsed.projectRoot, "Project projectRoot");
  if (isAbsolute(parsed.projectRoot) || parsed.projectRoot.includes("\0")) throw new Error("Project projectRoot must be relative to the manifest");
  if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) throw new Error("Project phases must contain at least one phase");
  const phases = parsed.phases.map(phase);
  if (new Set(phases.map((item) => item.id)).size !== phases.length) throw new Error("Project contains duplicate phase ids");
  if (new Set(phases.map((item) => item.order)).size !== phases.length) throw new Error("Project contains duplicate phase order values");
  validateDag(phases);
  const root = resolve(dirname(manifestPath), parsed.projectRoot);
  return {
    apiVersion: "gamefactory.dev/v1",
    kind: "Project",
    id: parsed.id,
    title: parsed.title,
    projectRoot: parsed.projectRoot,
    manifestPath,
    root,
    phases: phases.map((item) => ({
      ...item,
      attempts: item.attempts.map((entry) => ({
        ...entry,
        campaignPath: inside(root, entry.campaign, `Campaign path for ${item.id}/${entry.id}`),
        configPath: inside(root, entry.config, `Config path for ${item.id}/${entry.id}`)
      }))
    }))
  };
}
