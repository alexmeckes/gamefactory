import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export * from "./design-system.js";

export const DESIGN_API_VERSION = "gamefactory.design/v1" as const;
export const HUMAN_PLAYTEST_API_VERSION = "gamefactory.human-playtest/v1" as const;

export type PlaytesterKind = "scripted" | "search" | "model";
export type MetricAggregate = "mean" | "min" | "max" | "p10" | "p90" | "stddev";

export interface DesignPillar {
  id: string;
  statement: string;
  priority: number;
}

export interface PlayerPersona {
  id: string;
  label: string;
  description: string;
  goals: string[];
  behaviors: string[];
  kind: PlaytesterKind;
  parameters: Record<string, unknown>;
}

export interface ExperienceHypothesis {
  id: string;
  mechanic?: string;
  predictedDynamic: string;
  intendedExperience: string;
  evidence: string[];
  falsifiers: string[];
}

export interface ExplorationQuestion {
  id: string;
  question: string;
  whyItMatters: string;
  signals: string[];
}

export interface CreativeBounds {
  mustPreserve: string[];
  preferences: string[];
  freeToExplore: string[];
}

export interface PlaytestScenario {
  id: string;
  label: string;
  parameters: Record<string, unknown>;
}

export interface PlaytestMetric {
  metric: string;
  aggregate: MetricAggregate;
  weight: number;
  min?: number;
  max?: number;
  hard?: boolean;
}

export interface AgentPlaytestPlan {
  provider: string;
  version: string;
  path: string;
  personas: PlayerPersona[];
  scenarios: PlaytestScenario[];
  seeds: number[];
  concurrency: number;
  metrics: PlaytestMetric[];
}

export interface DesignIntent {
  apiVersion: typeof DESIGN_API_VERSION;
  id: string;
  version: string;
  title: string;
  audience: {
    description: string;
    needs: string[];
    exclusions: string[];
  };
  playerExperience: {
    fantasy: string;
    emotions: string[];
    pillars: DesignPillar[];
    antiPillars: string[];
  };
  coreLoop: {
    verbs: string[];
    description: string;
    sessionLengthMinutes: [number, number];
  };
  creativeBounds: CreativeBounds;
  explorationQuestions: ExplorationQuestion[];
  hypotheses: ExperienceHypothesis[];
  playtests: AgentPlaytestPlan;
  constraints: {
    accessibility: string[];
    performance: string[];
    platforms: string[];
  };
  unknowns: string[];
  metadata?: Record<string, unknown>;
}

export interface DesignIntentReference {
  path: string;
  id: string;
  version: string;
  sha256: string;
}

export interface HumanPlaytestFinding {
  id: string;
  severity: "observation" | "concern" | "blocker";
  observation: string;
  evidence: string[];
  pillarIds: string[];
}

export interface HumanPlaytestReport {
  apiVersion: typeof HUMAN_PLAYTEST_API_VERSION;
  id: string;
  conductedAt: string;
  designIntent: { id: string; version: string; sha256: string };
  subject: { id: string; buildSha256?: string };
  study: {
    method: "moderated" | "unmoderated" | "survey" | "mixed";
    participantCount: number;
    audienceMatch: number;
    consentConfirmed: boolean;
    containsPersonalData: boolean;
  };
  findings: HumanPlaytestFinding[];
  decision: {
    status: "approve" | "reject" | "needs-changes";
    rationale: string;
    decidedBy: string;
  };
  metadata?: Record<string, unknown>;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${location} must be an array of non-empty strings`);
  }
  return [...value];
}

function finite(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${location} must be a finite number`);
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  const parsed = finite(value, location);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${location} must be a positive integer`);
  return parsed;
}

function parameters(value: unknown, location: string): Record<string, unknown> {
  return value === undefined ? {} : object(value, location);
}

function parsePersonas(value: unknown): PlayerPersona[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("design intent playtests.personas must be a non-empty array");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = object(item, `design intent playtests.personas[${index}]`);
    const id = string(record.id, `design intent playtests.personas[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate playtester persona id: ${id}`);
    seen.add(id);
    const kind = record.kind;
    if (kind !== "scripted" && kind !== "search" && kind !== "model") throw new Error(`design intent playtests.personas[${index}].kind is unsupported`);
    return {
      id,
      label: string(record.label, `design intent playtests.personas[${index}].label`),
      description: string(record.description, `design intent playtests.personas[${index}].description`),
      goals: strings(record.goals, `design intent playtests.personas[${index}].goals`),
      behaviors: strings(record.behaviors, `design intent playtests.personas[${index}].behaviors`),
      kind,
      parameters: parameters(record.parameters, `design intent playtests.personas[${index}].parameters`)
    };
  });
}

function parseMetrics(value: unknown): PlaytestMetric[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("design intent playtests.metrics must be a non-empty array");
  const supported: MetricAggregate[] = ["mean", "min", "max", "p10", "p90", "stddev"];
  return value.map((item, index) => {
    const record = object(item, `design intent playtests.metrics[${index}]`);
    if (!supported.includes(record.aggregate as MetricAggregate)) throw new Error(`design intent playtests.metrics[${index}].aggregate is unsupported`);
    const result: PlaytestMetric = {
      metric: string(record.metric, `design intent playtests.metrics[${index}].metric`),
      aggregate: record.aggregate as MetricAggregate,
      weight: finite(record.weight ?? 1, `design intent playtests.metrics[${index}].weight`),
      ...(record.min !== undefined ? { min: finite(record.min, `design intent playtests.metrics[${index}].min`) } : {}),
      ...(record.max !== undefined ? { max: finite(record.max, `design intent playtests.metrics[${index}].max`) } : {}),
      ...(typeof record.hard === "boolean" ? { hard: record.hard } : {})
    };
    if (result.weight <= 0) throw new Error(`design intent playtests.metrics[${index}].weight must be positive`);
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) throw new Error(`design intent playtests.metrics[${index}] min cannot exceed max`);
    return result;
  });
}

export function parseDesignIntent(value: unknown): DesignIntent {
  const record = object(value, "design intent");
  if (record.apiVersion !== DESIGN_API_VERSION) throw new Error(`design intent apiVersion must be ${DESIGN_API_VERSION}`);
  const audience = object(record.audience, "design intent audience");
  const experience = object(record.playerExperience, "design intent playerExperience");
  const loop = object(record.coreLoop, "design intent coreLoop");
  const creativeBounds = record.creativeBounds === undefined ? {} : object(record.creativeBounds, "design intent creativeBounds");
  const playtests = object(record.playtests, "design intent playtests");
  const constraints = object(record.constraints, "design intent constraints");
  if (!Array.isArray(experience.pillars) || experience.pillars.length === 0) throw new Error("design intent playerExperience.pillars must be a non-empty array");
  const pillarIds = new Set<string>();
  const pillars = experience.pillars.map((item, index) => {
    const pillar = object(item, `design intent playerExperience.pillars[${index}]`);
    const id = string(pillar.id, `design intent playerExperience.pillars[${index}].id`);
    if (pillarIds.has(id)) throw new Error(`duplicate design pillar id: ${id}`);
    pillarIds.add(id);
    return { id, statement: string(pillar.statement, `design intent playerExperience.pillars[${index}].statement`), priority: finite(pillar.priority ?? 1, `design intent playerExperience.pillars[${index}].priority`) };
  });
  if (!Array.isArray(record.hypotheses)) throw new Error("design intent hypotheses must be an array");
  const hypotheses = record.hypotheses.map((item, index) => {
    const hypothesis = object(item, `design intent hypotheses[${index}]`);
    return {
      id: string(hypothesis.id, `design intent hypotheses[${index}].id`),
      ...(hypothesis.mechanic !== undefined ? { mechanic: string(hypothesis.mechanic, `design intent hypotheses[${index}].mechanic`) } : {}),
      predictedDynamic: string(hypothesis.predictedDynamic, `design intent hypotheses[${index}].predictedDynamic`),
      intendedExperience: string(hypothesis.intendedExperience, `design intent hypotheses[${index}].intendedExperience`),
      evidence: strings(hypothesis.evidence ?? [], `design intent hypotheses[${index}].evidence`),
      falsifiers: strings(hypothesis.falsifiers ?? [], `design intent hypotheses[${index}].falsifiers`)
    };
  });
  const rawExplorationQuestions = record.explorationQuestions ?? [];
  if (!Array.isArray(rawExplorationQuestions)) throw new Error("design intent explorationQuestions must be an array");
  const questionIds = new Set<string>();
  const explorationQuestions = rawExplorationQuestions.map((item, index) => {
    const question = object(item, `design intent explorationQuestions[${index}]`);
    const id = string(question.id, `design intent explorationQuestions[${index}].id`);
    if (questionIds.has(id)) throw new Error(`duplicate exploration question id: ${id}`);
    questionIds.add(id);
    return {
      id,
      question: string(question.question, `design intent explorationQuestions[${index}].question`),
      whyItMatters: string(question.whyItMatters, `design intent explorationQuestions[${index}].whyItMatters`),
      signals: strings(question.signals ?? [], `design intent explorationQuestions[${index}].signals`)
    };
  });
  if (!Array.isArray(playtests.scenarios) || playtests.scenarios.length === 0) throw new Error("design intent playtests.scenarios must be a non-empty array");
  const scenarios = playtests.scenarios.map((item, index) => {
    const scenario = object(item, `design intent playtests.scenarios[${index}]`);
    return {
      id: string(scenario.id, `design intent playtests.scenarios[${index}].id`),
      label: string(scenario.label, `design intent playtests.scenarios[${index}].label`),
      parameters: parameters(scenario.parameters, `design intent playtests.scenarios[${index}].parameters`)
    };
  });
  if (!Array.isArray(playtests.seeds) || playtests.seeds.length === 0 || !playtests.seeds.every((seed) => typeof seed === "number" && Number.isSafeInteger(seed))) {
    throw new Error("design intent playtests.seeds must be a non-empty integer array");
  }
  if (!Array.isArray(loop.sessionLengthMinutes) || loop.sessionLengthMinutes.length !== 2) throw new Error("design intent coreLoop.sessionLengthMinutes must contain [minimum, maximum]");
  const minimumSession = finite(loop.sessionLengthMinutes[0], "design intent coreLoop.sessionLengthMinutes[0]");
  const maximumSession = finite(loop.sessionLengthMinutes[1], "design intent coreLoop.sessionLengthMinutes[1]");
  if (minimumSession <= 0 || maximumSession < minimumSession) throw new Error("design intent coreLoop.sessionLengthMinutes range is invalid");
  const metadata = record.metadata === undefined ? undefined : object(record.metadata, "design intent metadata");
  return {
    apiVersion: DESIGN_API_VERSION,
    id: string(record.id, "design intent id"),
    version: string(record.version, "design intent version"),
    title: string(record.title, "design intent title"),
    audience: {
      description: string(audience.description, "design intent audience.description"),
      needs: strings(audience.needs, "design intent audience.needs"),
      exclusions: strings(audience.exclusions ?? [], "design intent audience.exclusions")
    },
    playerExperience: {
      fantasy: string(experience.fantasy, "design intent playerExperience.fantasy"),
      emotions: strings(experience.emotions, "design intent playerExperience.emotions"),
      pillars,
      antiPillars: strings(experience.antiPillars ?? [], "design intent playerExperience.antiPillars")
    },
    coreLoop: {
      verbs: strings(loop.verbs, "design intent coreLoop.verbs"),
      description: string(loop.description, "design intent coreLoop.description"),
      sessionLengthMinutes: [minimumSession, maximumSession]
    },
    creativeBounds: {
      mustPreserve: strings(creativeBounds.mustPreserve ?? [], "design intent creativeBounds.mustPreserve"),
      preferences: strings(creativeBounds.preferences ?? [], "design intent creativeBounds.preferences"),
      freeToExplore: strings(creativeBounds.freeToExplore ?? [], "design intent creativeBounds.freeToExplore")
    },
    explorationQuestions,
    hypotheses,
    playtests: {
      provider: string(playtests.provider, "design intent playtests.provider"),
      version: string(playtests.version, "design intent playtests.version"),
      path: string(playtests.path, "design intent playtests.path"),
      personas: parsePersonas(playtests.personas),
      scenarios,
      seeds: [...playtests.seeds] as number[],
      concurrency: positiveInteger(playtests.concurrency ?? 2, "design intent playtests.concurrency"),
      metrics: parseMetrics(playtests.metrics)
    },
    constraints: {
      accessibility: strings(constraints.accessibility ?? [], "design intent constraints.accessibility"),
      performance: strings(constraints.performance ?? [], "design intent constraints.performance"),
      platforms: strings(constraints.platforms ?? [], "design intent constraints.platforms")
    },
    unknowns: strings(record.unknowns ?? [], "design intent unknowns"),
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

export function designIntentSha256(intent: DesignIntent): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(intent))).digest("hex");
}

export function parseDesignIntentReference(value: unknown): DesignIntentReference {
  const record = object(value, "design intent reference");
  const sha256 = string(record.sha256, "design intent reference.sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("design intent reference.sha256 must be a SHA-256 hex digest");
  return {
    path: string(record.path, "design intent reference.path"),
    id: string(record.id, "design intent reference.id"),
    version: string(record.version, "design intent reference.version"),
    sha256
  };
}

export function parseHumanPlaytestReport(value: unknown): HumanPlaytestReport {
  const record = object(value, "human playtest report");
  if (record.apiVersion !== HUMAN_PLAYTEST_API_VERSION) throw new Error(`human playtest report apiVersion must be ${HUMAN_PLAYTEST_API_VERSION}`);
  const intent = object(record.designIntent, "human playtest report designIntent");
  const subject = object(record.subject, "human playtest report subject");
  const study = object(record.study, "human playtest report study");
  const decision = object(record.decision, "human playtest report decision");
  const intentSha256 = string(intent.sha256, "human playtest report designIntent.sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(intentSha256)) throw new Error("human playtest report designIntent.sha256 must be a SHA-256 hex digest");
  const buildSha256 = subject.buildSha256 === undefined ? undefined : string(subject.buildSha256, "human playtest report subject.buildSha256").toLowerCase();
  if (buildSha256 !== undefined && !/^[a-f0-9]{64}$/.test(buildSha256)) throw new Error("human playtest report subject.buildSha256 must be a SHA-256 hex digest");
  const method = study.method;
  if (method !== "moderated" && method !== "unmoderated" && method !== "survey" && method !== "mixed") throw new Error("human playtest report study.method is unsupported");
  const participantCount = positiveInteger(study.participantCount, "human playtest report study.participantCount");
  const audienceMatch = finite(study.audienceMatch, "human playtest report study.audienceMatch");
  if (audienceMatch < 0 || audienceMatch > 1) throw new Error("human playtest report study.audienceMatch must be between 0 and 1");
  if (typeof study.consentConfirmed !== "boolean" || typeof study.containsPersonalData !== "boolean") throw new Error("human playtest report study privacy flags must be booleans");
  if (!Array.isArray(record.findings)) throw new Error("human playtest report findings must be an array");
  const findings = record.findings.map((item, index) => {
    const finding = object(item, `human playtest report findings[${index}]`);
    const severity = finding.severity as HumanPlaytestFinding["severity"];
    if (severity !== "observation" && severity !== "concern" && severity !== "blocker") throw new Error(`human playtest report findings[${index}].severity is unsupported`);
    return {
      id: string(finding.id, `human playtest report findings[${index}].id`),
      severity,
      observation: string(finding.observation, `human playtest report findings[${index}].observation`),
      evidence: strings(finding.evidence ?? [], `human playtest report findings[${index}].evidence`),
      pillarIds: strings(finding.pillarIds ?? [], `human playtest report findings[${index}].pillarIds`)
    };
  });
  const status = decision.status;
  if (status !== "approve" && status !== "reject" && status !== "needs-changes") throw new Error("human playtest report decision.status is unsupported");
  const metadata = record.metadata === undefined ? undefined : object(record.metadata, "human playtest report metadata");
  return {
    apiVersion: HUMAN_PLAYTEST_API_VERSION,
    id: string(record.id, "human playtest report id"),
    conductedAt: string(record.conductedAt, "human playtest report conductedAt"),
    designIntent: {
      id: string(intent.id, "human playtest report designIntent.id"),
      version: string(intent.version, "human playtest report designIntent.version"),
      sha256: intentSha256
    },
    subject: {
      id: string(subject.id, "human playtest report subject.id"),
      ...(buildSha256 ? { buildSha256 } : {})
    },
    study: {
      method,
      participantCount,
      audienceMatch,
      consentConfirmed: study.consentConfirmed,
      containsPersonalData: study.containsPersonalData
    },
    findings,
    decision: {
      status,
      rationale: string(decision.rationale, "human playtest report decision.rationale"),
      decidedBy: string(decision.decidedBy, "human playtest report decision.decidedBy")
    },
    ...(metadata ? { metadata } : {})
  };
}

export function resolveDesignPath(projectRoot: string, projectPath: string): string {
  if (projectPath.includes("\0")) throw new Error("design path contains a null byte");
  const root = resolve(projectRoot);
  const target = resolve(root, projectPath);
  const traversal = relative(root, target);
  if (!traversal || traversal.startsWith("..") || resolve(traversal) === traversal) throw new Error(`design path must resolve below the project root: ${projectPath}`);
  return target;
}
