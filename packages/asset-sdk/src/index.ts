import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export const ASSET_API_VERSION = "gamefactory.assets/v1" as const;
export const STYLE_API_VERSION = "gamefactory.style/v1" as const;

export type AssetModality = "image" | "audio" | "model" | "animation" | "font" | "other";

export interface AssetBrief {
  apiVersion: typeof ASSET_API_VERSION;
  id: string;
  modality: AssetModality;
  role: string;
  prompt: string;
  output: {
    path: string;
    mediaType: string;
  };
  technical: Record<string, unknown>;
  constraints: string[];
  style?: {
    profilePath: string;
    profileId: string;
    profileVersion: string;
    profileSha256: string;
  };
  metadata?: Record<string, unknown>;
}

export interface StyleCriterion {
  metric: string;
  weight: number;
  min?: number;
  max?: number;
  target?: number;
  tolerance?: number;
  hard?: boolean;
}

export interface StyleReference {
  path: string;
  role: string;
  sha256?: string;
}

export interface ModalityStyleProfile {
  requiredTraits: string[];
  prohibitedTraits: string[];
  criteria: StyleCriterion[];
  metadata?: Record<string, unknown>;
}

export interface StyleProfile {
  apiVersion: typeof STYLE_API_VERSION;
  id: string;
  version: string;
  description: string;
  references: StyleReference[];
  modalities: Partial<Record<AssetModality, ModalityStyleProfile>>;
  metadata?: Record<string, unknown>;
}

export interface AssetGeneratorIdentity {
  id: string;
  version?: string;
  model?: string;
}

export interface AssetProcessorRecord {
  id: string;
  version?: string;
  parameters?: Record<string, unknown>;
}

export interface AssetRecipe {
  generator: AssetGeneratorIdentity;
  prompt: string;
  processors: AssetProcessorRecord[];
  seed?: string | number;
  source?: string;
  license?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetFileRecord {
  path: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

export interface AssetManifest {
  apiVersion: typeof ASSET_API_VERSION;
  briefId: string;
  candidateId: string;
  experimentId: string;
  generatedAt: string;
  files: AssetFileRecord[];
  recipe: AssetRecipe;
  style?: {
    profileId: string;
    profileVersion: string;
    profilePath: string;
    profileSha256: string;
    references: Array<{ path: string; role: string; sha256: string }>;
  };
  metadata?: Record<string, unknown>;
}

export interface AssetGenerationRequest {
  apiVersion: typeof ASSET_API_VERSION;
  experimentId: string;
  candidateId: string;
  candidateSlot: number;
  candidateRoot: string;
  briefPath: string;
  outputPath: string;
  resultPath: string;
  brief: AssetBrief;
}

export interface AssetGeneratorReport {
  generator: AssetGeneratorIdentity;
  prompt: string;
  processors?: AssetProcessorRecord[];
  seed?: string | number;
  source?: string;
  license?: string;
  metadata?: Record<string, unknown>;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function modality(value: unknown): AssetModality {
  const supported: AssetModality[] = ["image", "audio", "model", "animation", "font", "other"];
  if (typeof value !== "string" || !supported.includes(value as AssetModality)) {
    throw new Error(`modality must be one of ${supported.join(", ")}`);
  }
  return value as AssetModality;
}

export function parseAssetBrief(value: unknown): AssetBrief {
  const record = object(value, "asset brief");
  if (record.apiVersion !== ASSET_API_VERSION) throw new Error(`asset brief apiVersion must be ${ASSET_API_VERSION}`);
  const output = object(record.output, "asset brief output");
  const technical = record.technical === undefined ? {} : object(record.technical, "asset brief technical");
  const constraints = record.constraints === undefined
    ? []
    : Array.isArray(record.constraints) && record.constraints.every((item) => typeof item === "string")
      ? [...record.constraints]
      : (() => { throw new Error("asset brief constraints must be an array of strings"); })();
  const metadata = record.metadata === undefined ? undefined : object(record.metadata, "asset brief metadata");
  const styleRecord = record.style === undefined ? undefined : object(record.style, "asset brief style");
  if (styleRecord?.profileSha256 !== undefined && (typeof styleRecord.profileSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(styleRecord.profileSha256))) {
    throw new Error("asset brief style.profileSha256 must be a SHA-256 hex digest");
  }
  return {
    apiVersion: ASSET_API_VERSION,
    id: requiredString(record.id, "asset brief id"),
    modality: modality(record.modality),
    role: requiredString(record.role, "asset brief role"),
    prompt: requiredString(record.prompt, "asset brief prompt"),
    output: {
      path: requiredString(output.path, "asset brief output.path"),
      mediaType: requiredString(output.mediaType, "asset brief output.mediaType")
    },
    technical,
    constraints,
    ...(styleRecord ? {
      style: {
        profilePath: requiredString(styleRecord.profilePath, "asset brief style.profilePath"),
        profileId: requiredString(styleRecord.profileId, "asset brief style.profileId"),
        profileVersion: requiredString(styleRecord.profileVersion, "asset brief style.profileVersion"),
        profileSha256: requiredString(styleRecord.profileSha256, "asset brief style.profileSha256").toLowerCase()
      }
    } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function finiteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${location} must be a finite number`);
  return value;
}

function stringList(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${location} must be an array of strings`);
  return [...value];
}

export function parseStyleProfile(value: unknown): StyleProfile {
  const record = object(value, "style profile");
  if (record.apiVersion !== STYLE_API_VERSION) throw new Error(`style profile apiVersion must be ${STYLE_API_VERSION}`);
  if (!Array.isArray(record.references)) throw new Error("style profile references must be an array");
  const references = record.references.map((item, index) => {
    const reference = object(item, `style profile references[${index}]`);
    if (reference.sha256 !== undefined && (typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(reference.sha256))) {
      throw new Error(`style profile references[${index}].sha256 must be a SHA-256 hex digest`);
    }
    return {
      path: requiredString(reference.path, `style profile references[${index}].path`),
      role: requiredString(reference.role, `style profile references[${index}].role`),
      ...(typeof reference.sha256 === "string" ? { sha256: reference.sha256.toLowerCase() } : {})
    };
  });
  const modalityRecords = object(record.modalities, "style profile modalities");
  const modalities: StyleProfile["modalities"] = {};
  for (const [key, rawProfile] of Object.entries(modalityRecords)) {
    const assetModality = modality(key);
    const profile = object(rawProfile, `style profile modalities.${key}`);
    if (!Array.isArray(profile.criteria)) throw new Error(`style profile modalities.${key}.criteria must be an array`);
    const criteria = profile.criteria.map((item, index) => {
      const criterion = object(item, `style profile modalities.${key}.criteria[${index}]`);
      const parsed: StyleCriterion = {
        metric: requiredString(criterion.metric, `style profile modalities.${key}.criteria[${index}].metric`),
        weight: finiteNumber(criterion.weight ?? 1, `style profile modalities.${key}.criteria[${index}].weight`),
        ...(criterion.min !== undefined ? { min: finiteNumber(criterion.min, `style profile modalities.${key}.criteria[${index}].min`) } : {}),
        ...(criterion.max !== undefined ? { max: finiteNumber(criterion.max, `style profile modalities.${key}.criteria[${index}].max`) } : {}),
        ...(criterion.target !== undefined ? { target: finiteNumber(criterion.target, `style profile modalities.${key}.criteria[${index}].target`) } : {}),
        ...(criterion.tolerance !== undefined ? { tolerance: finiteNumber(criterion.tolerance, `style profile modalities.${key}.criteria[${index}].tolerance`) } : {}),
        ...(typeof criterion.hard === "boolean" ? { hard: criterion.hard } : {})
      };
      if (parsed.weight <= 0) throw new Error(`style profile modalities.${key}.criteria[${index}].weight must be positive`);
      if (parsed.min !== undefined && parsed.max !== undefined && parsed.min > parsed.max) {
        throw new Error(`style profile modalities.${key}.criteria[${index}] min cannot exceed max`);
      }
      if (parsed.tolerance !== undefined && parsed.tolerance <= 0) throw new Error(`style profile modalities.${key}.criteria[${index}].tolerance must be positive`);
      return parsed;
    });
    const metadata = profile.metadata === undefined ? undefined : object(profile.metadata, `style profile modalities.${key}.metadata`);
    modalities[assetModality] = {
      requiredTraits: stringList(profile.requiredTraits, `style profile modalities.${key}.requiredTraits`),
      prohibitedTraits: stringList(profile.prohibitedTraits, `style profile modalities.${key}.prohibitedTraits`),
      criteria,
      ...(metadata ? { metadata } : {})
    };
  }
  const metadata = record.metadata === undefined ? undefined : object(record.metadata, "style profile metadata");
  return {
    apiVersion: STYLE_API_VERSION,
    id: requiredString(record.id, "style profile id"),
    version: requiredString(record.version, "style profile version"),
    description: requiredString(record.description, "style profile description"),
    references,
    modalities,
    ...(metadata ? { metadata } : {})
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
  }
  return value;
}

export function styleProfileSha256(profile: StyleProfile): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(profile))).digest("hex");
}

export function parseGeneratorReport(value: unknown): AssetGeneratorReport {
  const record = object(value, "asset generator report");
  const generator = object(record.generator, "asset generator report generator");
  const processors = record.processors === undefined
    ? undefined
    : Array.isArray(record.processors)
      ? record.processors.map((item, index) => {
          const processor = object(item, `asset generator report processors[${index}]`);
          const parameters = processor.parameters === undefined
            ? undefined
            : object(processor.parameters, `asset generator report processors[${index}].parameters`);
          return {
            id: requiredString(processor.id, `asset generator report processors[${index}].id`),
            ...(typeof processor.version === "string" ? { version: processor.version } : {}),
            ...(parameters ? { parameters } : {})
          };
        })
      : (() => { throw new Error("asset generator report processors must be an array"); })();
  const metadata = record.metadata === undefined ? undefined : object(record.metadata, "asset generator report metadata");
  const seed = typeof record.seed === "string" || typeof record.seed === "number" ? record.seed : undefined;
  return {
    generator: {
      id: requiredString(generator.id, "asset generator id"),
      ...(typeof generator.version === "string" ? { version: generator.version } : {}),
      ...(typeof generator.model === "string" ? { model: generator.model } : {})
    },
    prompt: requiredString(record.prompt, "asset generator prompt"),
    ...(processors ? { processors } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.license === "string" ? { license: record.license } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export function resolveProjectAssetPath(projectRoot: string, projectPath: string): string {
  if (projectPath.includes("\0")) throw new Error("asset path contains a null byte");
  const root = resolve(projectRoot);
  const target = resolve(root, projectPath);
  const traversal = relative(root, target);
  if (!traversal || traversal.startsWith("..") || resolve(traversal) === traversal) {
    throw new Error(`asset path must resolve to a file below the candidate root: ${projectPath}`);
  }
  return target;
}

export function candidateSlot(experimentId: string): number {
  const match = experimentId.match(/(?:c|exp-)(\d+)$/i);
  const value = Number(match?.[1] ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
