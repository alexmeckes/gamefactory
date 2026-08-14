import { createHash } from "node:crypto";
import type { DesignReferenceAuthority, DesignReferencePurpose } from "./design-system.js";

export const VISUAL_DIRECTION_API_VERSION = "gamefactory.visual-direction/v1" as const;

export interface VisualDirectionReference {
  path: string;
  label: string;
  purpose: DesignReferencePurpose;
  authority: DesignReferenceAuthority;
  source: "curated" | "imagegen" | "captured" | "other";
  sha256: string;
  prompt?: string;
  provenanceNote?: string;
}

export interface VisualDirection {
  apiVersion: typeof VISUAL_DIRECTION_API_VERSION;
  id: string;
  intent: string;
  renderingStrategy: {
    mode: string;
    feasibility: string;
  };
  references: VisualDirectionReference[];
  nonnegotiables: string[];
  qualityDimensions: Record<string, string>;
  antiPatterns: string[];
  views: Array<{ id: string; purpose: string }>;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string, maximum = 16_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`${location} must be a non-empty string with at most ${maximum} characters`);
  return value.trim();
}

function id(value: unknown, location: string): string {
  const result = text(value, location, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error(`${location} contains unsupported characters`);
  return result;
}

function strings(value: unknown, location: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 4000)) throw new Error(`${location} must be an array of at most ${maximum} non-empty strings`);
  return value.map((item) => (item as string).trim());
}

function hash(value: unknown, location: string): string {
  const result = text(value, location, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${location} must be a SHA-256 hex digest`);
  return result;
}

export function parseVisualDirection(value: unknown): VisualDirection {
  const record = object(value, "visual direction");
  if (record.apiVersion !== VISUAL_DIRECTION_API_VERSION) throw new Error(`visual direction apiVersion must be ${VISUAL_DIRECTION_API_VERSION}`);
  const strategy = object(record.renderingStrategy, "visual direction renderingStrategy");
  if (!Array.isArray(record.references) || record.references.length === 0 || record.references.length > 64) throw new Error("visual direction references must contain from 1 to 64 entries");
  const references = record.references.map((raw, index): VisualDirectionReference => {
    const item = object(raw, `visual direction references[${index}]`);
    const purpose = item.purpose;
    if (purpose !== "mood" && purpose !== "material" && purpose !== "silhouette" && purpose !== "gameplay" && purpose !== "interaction" && purpose !== "motion" && purpose !== "baseline") throw new Error(`visual direction references[${index}].purpose is unsupported`);
    const authority = item.authority;
    if (authority !== "inspiration" && authority !== "production-target" && authority !== "baseline" && authority !== "evidence") throw new Error(`visual direction references[${index}].authority is unsupported`);
    const source = item.source;
    if (source !== "curated" && source !== "imagegen" && source !== "captured" && source !== "other") throw new Error(`visual direction references[${index}].source is unsupported`);
    if (source === "imagegen" && typeof item.prompt !== "string") throw new Error(`visual direction references[${index}].prompt is required for ImageGen references`);
    if (authority === "production-target" && source !== "captured") throw new Error(`visual direction references[${index}] production targets must be captured from an implementation`);
    if (authority === "production-target" && purpose !== "gameplay" && purpose !== "interaction" && purpose !== "motion") throw new Error(`visual direction references[${index}] production targets must demonstrate gameplay, interaction, or motion`);
    return {
      path: text(item.path, `visual direction references[${index}].path`, 4096),
      label: text(item.label, `visual direction references[${index}].label`),
      purpose,
      authority,
      source,
      sha256: hash(item.sha256, `visual direction references[${index}].sha256`),
      ...(typeof item.prompt === "string" ? { prompt: text(item.prompt, `visual direction references[${index}].prompt`, 32_000) } : {}),
      ...(typeof item.provenanceNote === "string" ? { provenanceNote: text(item.provenanceNote, `visual direction references[${index}].provenanceNote`) } : {})
    };
  });
  const rawDimensions = object(record.qualityDimensions, "visual direction qualityDimensions");
  if (Object.keys(rawDimensions).length === 0 || !Object.values(rawDimensions).every((value) => typeof value === "string" && value.trim().length > 0)) throw new Error("visual direction qualityDimensions must contain non-empty string values");
  if (!Array.isArray(record.views) || record.views.length === 0 || record.views.length > 32) throw new Error("visual direction views must contain from 1 to 32 entries");
  return {
    apiVersion: VISUAL_DIRECTION_API_VERSION,
    id: id(record.id, "visual direction id"),
    intent: text(record.intent, "visual direction intent"),
    renderingStrategy: { mode: text(strategy.mode, "visual direction renderingStrategy.mode", 512), feasibility: text(strategy.feasibility, "visual direction renderingStrategy.feasibility") },
    references,
    nonnegotiables: strings(record.nonnegotiables, "visual direction nonnegotiables"),
    qualityDimensions: Object.fromEntries(Object.entries(rawDimensions).map(([key, value]) => [id(key, `visual direction quality dimension ${key}`), (value as string).trim()])),
    antiPatterns: strings(record.antiPatterns ?? [], "visual direction antiPatterns"),
    views: record.views.map((raw, index) => { const view = object(raw, `visual direction views[${index}]`); return { id: id(view.id, `visual direction views[${index}].id`), purpose: text(view.purpose, `visual direction views[${index}].purpose`) }; })
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function visualDirectionSha256(direction: VisualDirection): string {
  return createHash("sha256").update(JSON.stringify(canonical(direction))).digest("hex");
}
