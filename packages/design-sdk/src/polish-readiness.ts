import { createHash } from "node:crypto";

export const POLISH_READINESS_API_VERSION = "gamefactory.polish-readiness/v1" as const;

export type PolishStage = "visual-prototype" | "production-slice" | "production";
export type PolishSurfaceStatus = "prototype" | "production" | "placeholder" | "omitted";
export type AssetMaturity = "reference" | "source" | "extracted" | "engine-ready" | "production";
export type PolishGateStatus = "pass" | "fail" | "inconclusive";

export interface PolishReadinessManifest {
  apiVersion: typeof POLISH_READINESS_API_VERSION;
  stage: PolishStage;
  representativeBuild: {
    engine: string;
    captureEvidence: string[];
  };
  surfaces: Array<{
    id: string;
    label: string;
    required: boolean;
    status: PolishSurfaceStatus;
    evidence: string[];
  }>;
  assets: Array<{
    id: string;
    label: string;
    kind: string;
    runtime: boolean;
    maturity: AssetMaturity;
    evidence: string[];
  }>;
  gates: Array<{
    id: string;
    label: string;
    status: PolishGateStatus;
    evidence: string[];
    findings: string[];
  }>;
  unresolved: Array<{
    id: string;
    severity: "blocker" | "deferred";
    description: string;
    owner?: string;
  }>;
  metadata?: Record<string, unknown>;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string, maximum = 4096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`${location} must be a non-empty string with at most ${maximum} characters`);
  return value.trim();
}

function id(value: unknown, location: string): string {
  const result = text(value, location, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error(`${location} contains unsupported characters`);
  return result;
}

function strings(value: unknown, location: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 4096)) {
    throw new Error(`${location} must be an array of at most ${maximum} non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function unique<T extends { id: string }>(items: T[], location: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${location} contains duplicate id ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

function jsonValue(value: unknown, location: string, depth = 0): unknown {
  if (depth > 16) throw new Error(`${location} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${location}[${index}]`, depth + 1));
  const record = object(value, location);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, jsonValue(item, `${location}.${key}`, depth + 1)]));
}

export function parsePolishReadiness(value: unknown): PolishReadinessManifest {
  const record = object(value, "polish readiness");
  if (record.apiVersion !== POLISH_READINESS_API_VERSION) throw new Error(`polish readiness apiVersion must be ${POLISH_READINESS_API_VERSION}`);
  const stage = record.stage;
  if (stage !== "visual-prototype" && stage !== "production-slice" && stage !== "production") throw new Error("polish readiness stage must be visual-prototype, production-slice, or production");
  const build = object(record.representativeBuild, "polish readiness representativeBuild");
  const captureEvidence = strings(build.captureEvidence, "polish readiness representativeBuild.captureEvidence");
  if (captureEvidence.length === 0) throw new Error("polish readiness representativeBuild.captureEvidence must contain at least one engine capture");

  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0 || record.surfaces.length > 128) throw new Error("polish readiness surfaces must contain from 1 to 128 entries");
  const surfaces = unique(record.surfaces.map((raw, index) => {
    const item = object(raw, `polish readiness surfaces[${index}]`);
    const status = item.status;
    if (status !== "prototype" && status !== "production" && status !== "placeholder" && status !== "omitted") throw new Error(`polish readiness surfaces[${index}].status is unsupported`);
    if (typeof item.required !== "boolean") throw new Error(`polish readiness surfaces[${index}].required must be boolean`);
    const evidence = strings(item.evidence ?? [], `polish readiness surfaces[${index}].evidence`);
    if (status === "production" && evidence.length === 0) throw new Error(`polish readiness surfaces[${index}] production status requires evidence`);
    return { id: id(item.id, `polish readiness surfaces[${index}].id`), label: text(item.label, `polish readiness surfaces[${index}].label`), required: item.required, status: status as PolishSurfaceStatus, evidence };
  }), "polish readiness surfaces");

  if (!Array.isArray(record.assets) || record.assets.length > 512) throw new Error("polish readiness assets must be an array with at most 512 entries");
  const assets = unique(record.assets.map((raw, index) => {
    const item = object(raw, `polish readiness assets[${index}]`);
    const maturity = item.maturity;
    if (maturity !== "reference" && maturity !== "source" && maturity !== "extracted" && maturity !== "engine-ready" && maturity !== "production") throw new Error(`polish readiness assets[${index}].maturity is unsupported`);
    if (typeof item.runtime !== "boolean") throw new Error(`polish readiness assets[${index}].runtime must be boolean`);
    const evidence = strings(item.evidence ?? [], `polish readiness assets[${index}].evidence`);
    if (maturity === "production" && evidence.length === 0) throw new Error(`polish readiness assets[${index}] production maturity requires evidence`);
    return { id: id(item.id, `polish readiness assets[${index}].id`), label: text(item.label, `polish readiness assets[${index}].label`), kind: text(item.kind, `polish readiness assets[${index}].kind`, 128), runtime: item.runtime, maturity: maturity as AssetMaturity, evidence };
  }), "polish readiness assets");

  if (!Array.isArray(record.gates) || record.gates.length === 0 || record.gates.length > 64) throw new Error("polish readiness gates must contain from 1 to 64 entries");
  const gates = unique(record.gates.map((raw, index) => {
    const item = object(raw, `polish readiness gates[${index}]`);
    const status = item.status;
    if (status !== "pass" && status !== "fail" && status !== "inconclusive") throw new Error(`polish readiness gates[${index}].status is unsupported`);
    const evidence = strings(item.evidence ?? [], `polish readiness gates[${index}].evidence`);
    if (status === "pass" && evidence.length === 0) throw new Error(`polish readiness gates[${index}] pass status requires evidence`);
    return { id: id(item.id, `polish readiness gates[${index}].id`), label: text(item.label, `polish readiness gates[${index}].label`), status: status as PolishGateStatus, evidence, findings: strings(item.findings ?? [], `polish readiness gates[${index}].findings`) };
  }), "polish readiness gates");

  if (!Array.isArray(record.unresolved) || record.unresolved.length > 128) throw new Error("polish readiness unresolved must be an array with at most 128 entries");
  const unresolved = unique(record.unresolved.map((raw, index) => {
    const item = object(raw, `polish readiness unresolved[${index}]`);
    if (item.severity !== "blocker" && item.severity !== "deferred") throw new Error(`polish readiness unresolved[${index}].severity is unsupported`);
    return { id: id(item.id, `polish readiness unresolved[${index}].id`), severity: item.severity as "blocker" | "deferred", description: text(item.description, `polish readiness unresolved[${index}].description`), ...(item.owner !== undefined ? { owner: text(item.owner, `polish readiness unresolved[${index}].owner`, 256) } : {}) };
  }), "polish readiness unresolved");

  const metadata = record.metadata === undefined ? undefined : jsonValue(record.metadata, "polish readiness metadata") as Record<string, unknown>;
  return {
    apiVersion: POLISH_READINESS_API_VERSION,
    stage,
    representativeBuild: { engine: text(build.engine, "polish readiness representativeBuild.engine", 256), captureEvidence },
    surfaces,
    assets,
    gates,
    unresolved,
    ...(metadata ? { metadata } : {})
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function polishReadinessSha256(manifest: PolishReadinessManifest): string {
  return createHash("sha256").update(JSON.stringify(canonical(manifest))).digest("hex");
}
