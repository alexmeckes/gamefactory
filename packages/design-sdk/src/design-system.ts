import { createHash } from "node:crypto";

export const DESIGN_SYSTEM_API_VERSION = "gamefactory.design-system/v1" as const;

export interface DesignSystemPrinciple {
  id: string;
  statement: string;
  rationale: string;
  priority: number;
}

export interface DesignSystemPattern {
  id: string;
  intent: string;
  rules: string[];
  avoid: string[];
  examples: string[];
}

export interface DesignSystemReference {
  path: string;
  role: string;
  source: "curated" | "imagegen" | "captured" | "other";
  sha256: string;
  prompt?: string;
}

export interface DesignSystemImplementation {
  id: string;
  adapter: string;
  path: string;
  sha256: string;
}

export interface GameDesignSystem {
  apiVersion: typeof DESIGN_SYSTEM_API_VERSION;
  id: string;
  version: string;
  title: string;
  identity: {
    intent: string;
    toneWords: string[];
    avoidWords: string[];
  };
  principles: DesignSystemPrinciple[];
  tokens: Record<string, Record<string, unknown>>;
  patterns: DesignSystemPattern[];
  references: DesignSystemReference[];
  implementations: DesignSystemImplementation[];
  metadata?: Record<string, unknown>;
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

function jsonValue(value: unknown, location: string, depth = 0): unknown {
  if (depth > 16) throw new Error(`${location} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error(`${location} has too many entries`);
    return value.map((item, index) => jsonValue(item, `${location}[${index}]`, depth + 1));
  }
  const record = object(value, location);
  if (Object.keys(record).length > 512) throw new Error(`${location} has too many keys`);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, jsonValue(item, `${location}.${key}`, depth + 1)]));
}

export function parseGameDesignSystem(value: unknown): GameDesignSystem {
  const record = object(value, "design system");
  if (record.apiVersion !== DESIGN_SYSTEM_API_VERSION) throw new Error(`design system apiVersion must be ${DESIGN_SYSTEM_API_VERSION}`);
  const identity = object(record.identity, "design system identity");
  if (!Array.isArray(record.principles) || record.principles.length === 0 || record.principles.length > 64) throw new Error("design system principles must contain from 1 to 64 entries");
  const principleIds = new Set<string>();
  const principles = record.principles.map((raw, index) => {
    const item = object(raw, `design system principles[${index}]`);
    const itemId = id(item.id, `design system principles[${index}].id`);
    if (principleIds.has(itemId)) throw new Error(`design system contains duplicate principle ${itemId}`);
    principleIds.add(itemId);
    if (typeof item.priority !== "number" || !Number.isSafeInteger(item.priority) || item.priority < 1 || item.priority > 100) throw new Error(`design system principles[${index}].priority must be an integer from 1 to 100`);
    return { id: itemId, statement: text(item.statement, `design system principles[${index}].statement`), rationale: text(item.rationale, `design system principles[${index}].rationale`), priority: item.priority };
  });
  const rawTokens = object(record.tokens, "design system tokens");
  if (Object.keys(rawTokens).length === 0 || Object.keys(rawTokens).length > 64) throw new Error("design system tokens must contain from 1 to 64 named groups");
  const tokens = Object.fromEntries(Object.entries(rawTokens).map(([name, raw]) => {
    const group = object(raw, `design system tokens.${name}`);
    if (Object.keys(group).length === 0) throw new Error(`design system tokens.${name} must not be empty`);
    return [id(name, `design system token group ${name}`), jsonValue(group, `design system tokens.${name}`) as Record<string, unknown>];
  }));
  if (!Array.isArray(record.patterns) || record.patterns.length > 128) throw new Error("design system patterns must be an array with at most 128 entries");
  const patterns = record.patterns.map((raw, index) => { const item = object(raw, `design system patterns[${index}]`); return { id: id(item.id, `design system patterns[${index}].id`), intent: text(item.intent, `design system patterns[${index}].intent`), rules: strings(item.rules, `design system patterns[${index}].rules`), avoid: strings(item.avoid, `design system patterns[${index}].avoid`), examples: strings(item.examples ?? [], `design system patterns[${index}].examples`) }; });
  if (!Array.isArray(record.references) || record.references.length > 64) throw new Error("design system references must be an array with at most 64 entries");
  const references: DesignSystemReference[] = record.references.map((raw, index) => {
    const item = object(raw, `design system references[${index}]`);
    const rawSource = item.source;
    if (rawSource !== "curated" && rawSource !== "imagegen" && rawSource !== "captured" && rawSource !== "other") throw new Error(`design system references[${index}].source is unsupported`);
    const source: DesignSystemReference["source"] = rawSource;
    if (source === "imagegen" && typeof item.prompt !== "string") throw new Error(`design system references[${index}].prompt is required for ImageGen references`);
    return { path: text(item.path, `design system references[${index}].path`, 4096), role: text(item.role, `design system references[${index}].role`), source, sha256: hash(item.sha256, `design system references[${index}].sha256`), ...(typeof item.prompt === "string" ? { prompt: text(item.prompt, `design system references[${index}].prompt`, 32_000) } : {}) };
  });
  if (!Array.isArray(record.implementations) || record.implementations.length === 0 || record.implementations.length > 64) throw new Error("design system implementations must contain from 1 to 64 entries");
  const implementations = record.implementations.map((raw, index) => { const item = object(raw, `design system implementations[${index}]`); return { id: id(item.id, `design system implementations[${index}].id`), adapter: text(item.adapter, `design system implementations[${index}].adapter`, 256), path: text(item.path, `design system implementations[${index}].path`, 4096), sha256: hash(item.sha256, `design system implementations[${index}].sha256`) }; });
  const metadata = record.metadata === undefined ? undefined : jsonValue(record.metadata, "design system metadata") as Record<string, unknown>;
  return {
    apiVersion: DESIGN_SYSTEM_API_VERSION,
    id: id(record.id, "design system id"),
    version: text(record.version, "design system version", 128),
    title: text(record.title, "design system title", 512),
    identity: { intent: text(identity.intent, "design system identity.intent"), toneWords: strings(identity.toneWords, "design system identity.toneWords", 32), avoidWords: strings(identity.avoidWords, "design system identity.avoidWords", 32) },
    principles,
    tokens,
    patterns,
    references,
    implementations,
    ...(metadata ? { metadata } : {})
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function gameDesignSystemSha256(system: GameDesignSystem): string {
  return createHash("sha256").update(JSON.stringify(canonical(system))).digest("hex");
}
