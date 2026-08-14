import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  gameDesignSystemSha256,
  parseGameDesignSystem,
  designIntentSha256,
  parseDesignIntent,
  parseDesignIntentReference,
  parseHumanPlaytestReport,
  parseVisualDirection,
  resolveDesignPath,
  visualDirectionSha256,
  type DesignIntent,
  type DesignReferenceAuthority,
  type DesignSystemMaturity,
  type GameDesignSystem,
  type MetricAggregate,
  type PlaytestMetric
} from "@gamefactory/design-sdk";
import type {
  ArtifactReference,
  Candidate,
  EngineDriver,
  Evaluation,
  Evaluator,
  ScenarioReference,
  ScenarioResult,
  ScenarioRunner,
  Violation
} from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

interface LoadedIntent {
  path: string;
  intent: DesignIntent;
  sha256: string;
}

interface LoadedDesignSystem {
  path: string;
  system: GameDesignSystem;
  sha256: string;
  imagegenReferences: number;
  productionTargets: number;
  visualDirection?: { path: string; sha256: string; references: number };
}

interface PlaytestRun {
  id: string;
  persona: string;
  scenario: string;
  seed: number;
  result: ScenarioResult;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function designReference(campaign: Parameters<Evaluator["evaluate"]>[0]["campaign"]) {
  return parseDesignIntentReference(object(campaign.parameters?.design).intent);
}

function configuredStrings(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${location} must be an array of at most 64 non-empty strings`);
  }
  return value;
}

function designSystemConfig(campaign: Parameters<Evaluator["evaluate"]>[0]["campaign"]): { path: string; visualDirectionPath?: string; requiredTokenGroups: string[]; requiredAdapters: string[]; requiredReferenceAuthorities: DesignReferenceAuthority[]; minimumReferences: number; requireImagegenReference: boolean; minimumMaturity: DesignSystemMaturity } {
  const config = object(campaign.parameters?.designSystem);
  const requiredTokenGroups = configuredStrings(config.requiredTokenGroups, "parameters.designSystem.requiredTokenGroups");
  const requiredAdapters = configuredStrings(config.requiredAdapters, "parameters.designSystem.requiredAdapters");
  const rawAuthorities = configuredStrings(config.requiredReferenceAuthorities, "parameters.designSystem.requiredReferenceAuthorities");
  const requiredReferenceAuthorities = rawAuthorities.map((authority) => {
    if (authority !== "inspiration" && authority !== "production-target" && authority !== "baseline" && authority !== "evidence") throw new Error(`parameters.designSystem.requiredReferenceAuthorities contains unsupported authority ${authority}`);
    return authority;
  }) as DesignReferenceAuthority[];
  const minimumReferences = config.minimumReferences ?? 0;
  if (typeof minimumReferences !== "number" || !Number.isSafeInteger(minimumReferences) || minimumReferences < 0 || minimumReferences > 64) throw new Error("parameters.designSystem.minimumReferences must be an integer from 0 to 64");
  if (config.requireImagegenReference !== undefined && typeof config.requireImagegenReference !== "boolean") throw new Error("parameters.designSystem.requireImagegenReference must be boolean");
  if (config.path !== undefined && (typeof config.path !== "string" || config.path.length === 0)) throw new Error("parameters.designSystem.path must be a non-empty string");
  if (config.visualDirectionPath !== undefined && (typeof config.visualDirectionPath !== "string" || config.visualDirectionPath.length === 0)) throw new Error("parameters.designSystem.visualDirectionPath must be a non-empty string");
  const minimumMaturity = config.minimumMaturity ?? "direction";
  if (minimumMaturity !== "direction" && minimumMaturity !== "production-slice" && minimumMaturity !== "production") throw new Error("parameters.designSystem.minimumMaturity must be direction, production-slice, or production");
  return {
    path: typeof config.path === "string" && config.path.length > 0 ? config.path : "design-system.json",
    ...(typeof config.visualDirectionPath === "string" ? { visualDirectionPath: config.visualDirectionPath } : {}),
    requiredTokenGroups,
    requiredAdapters,
    requiredReferenceAuthorities,
    minimumReferences,
    requireImagegenReference: config.requireImagegenReference === true,
    minimumMaturity
  };
}

async function verifiedDesignSystemFile(root: string, path: string, expectedHash: string, label: string): Promise<string> {
  const candidatePath = resolveDesignPath(root, path);
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(candidatePath)]);
  const traversal = relative(canonicalRoot, canonicalPath);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} resolves outside the candidate root`);
  if (!(await lstat(canonicalPath)).isFile()) throw new Error(`${label} is not a regular file`);
  const actual = createHash("sha256").update(await readFile(canonicalPath)).digest("hex");
  if (actual !== expectedHash) throw new Error(`${label} hash mismatch`);
  return canonicalPath;
}

async function loadDesignSystem(candidate: Candidate, campaign: Parameters<Evaluator["evaluate"]>[0]["campaign"]): Promise<LoadedDesignSystem> {
  const config = designSystemConfig(campaign);
  const path = resolveDesignPath(candidate.root, config.path);
  const system = parseGameDesignSystem(JSON.parse(await readFile(path, "utf8")) as unknown);
  for (const group of config.requiredTokenGroups) if (!system.tokens[group]) throw new Error(`Design system is missing required token group ${group}`);
  for (const adapter of config.requiredAdapters) if (!system.implementations.some((item) => item.adapter === adapter)) throw new Error(`Design system is missing required adapter ${adapter}`);
  const maturityRank: Record<DesignSystemMaturity, number> = { direction: 0, "production-slice": 1, production: 2 };
  if (maturityRank[system.maturity] < maturityRank[config.minimumMaturity]) throw new Error(`Design system maturity ${system.maturity} does not satisfy required ${config.minimumMaturity}`);
  if (system.references.length < config.minimumReferences) throw new Error(`Design system requires at least ${config.minimumReferences} references`);
  const imagegenReferences = system.references.filter((item) => item.source === "imagegen").length;
  const productionTargets = system.references.filter((item) => item.authority === "production-target").length;
  for (const authority of config.requiredReferenceAuthorities) if (!system.references.some((item) => item.authority === authority)) throw new Error(`Design system requires at least one ${authority} reference`);
  if (config.requireImagegenReference && imagegenReferences === 0) throw new Error("Design system requires at least one ImageGen-authored reference study");
  await Promise.all([
    ...system.references.map((item, index) => verifiedDesignSystemFile(candidate.root, item.path, item.sha256, `design system reference ${index + 1}`)),
    ...system.implementations.map((item, index) => verifiedDesignSystemFile(candidate.root, item.path, item.sha256, `design system implementation ${index + 1}`))
  ]);
  let visualDirection: LoadedDesignSystem["visualDirection"];
  if (config.visualDirectionPath) {
    const directionPath = resolveDesignPath(candidate.root, config.visualDirectionPath);
    const direction = parseVisualDirection(JSON.parse(await readFile(directionPath, "utf8")) as unknown);
    await Promise.all(direction.references.map((item, index) => verifiedDesignSystemFile(candidate.root, item.path, item.sha256, `visual direction reference ${index + 1}`)));
    visualDirection = { path: directionPath, sha256: visualDirectionSha256(direction), references: direction.references.length };
  }
  return { path, system, sha256: gameDesignSystemSha256(system), imagegenReferences, productionTargets, ...(visualDirection ? { visualDirection } : {}) };
}

export class DesignSystemEvaluator implements Evaluator {
  readonly id = "design.system";
  readonly version = "1.1.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    if (!input.candidate) {
      return { evaluator: this.id, version: this.version, status: "pass", metrics: { design_system_integrity: 0, design_system_references: 0, design_system_imagegen_references: 0 }, violations: [], artifacts: [], confidence: 1, summary: "Baseline has no candidate-authored design system." };
    }
    try {
      const loaded = await loadDesignSystem(input.candidate, input.campaign);
      return {
        evaluator: this.id,
        version: this.version,
        status: "pass",
        metrics: { design_system_integrity: 1, design_system_maturity: loaded.system.maturity === "production" ? 2 : loaded.system.maturity === "production-slice" ? 1 : 0, design_system_principles: loaded.system.principles.length, design_system_token_groups: Object.keys(loaded.system.tokens).length, design_system_patterns: loaded.system.patterns.length, design_system_references: loaded.system.references.length, design_system_imagegen_references: loaded.imagegenReferences, design_system_production_targets: loaded.productionTargets, design_system_implementations: loaded.system.implementations.length, visual_direction_references: loaded.visualDirection?.references ?? 0 },
        violations: [],
        artifacts: [
          artifact(loaded.path, "profile", `Design system ${loaded.system.id}@${loaded.system.version}`, "application/json"),
          ...(loaded.visualDirection ? [artifact(loaded.visualDirection.path, "profile", `Visual direction ${loaded.visualDirection.sha256.slice(0, 12)}`, "application/json")] : []),
          ...loaded.system.references.map((item) => artifact(resolveDesignPath(input.candidate!.root, item.path), item.path.toLowerCase().endsWith(".png") ? "image" : "other", item.role, item.path.toLowerCase().endsWith(".png") ? "image/png" : "application/octet-stream")),
          ...loaded.system.implementations.map((item) => artifact(resolveDesignPath(input.candidate!.root, item.path), "other", `Design system adapter: ${item.adapter}`, item.path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain"))
        ],
        confidence: 1,
        summary: `Verified ${loaded.system.id}@${loaded.system.version} (${loaded.sha256.slice(0, 12)}) with ${loaded.imagegenReferences} ImageGen reference(s).`
      };
    } catch (error) {
      return { evaluator: this.id, version: this.version, status: "fail", metrics: { design_system_integrity: 0 }, violations: [{ code: "design.system.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }], artifacts: [], confidence: 1, summary: "Design system verification failed." };
    }
  }
}

async function loadIntent(candidate: Candidate, campaign: Parameters<Evaluator["evaluate"]>[0]["campaign"]): Promise<LoadedIntent> {
  const reference = designReference(campaign);
  const path = resolveDesignPath(candidate.root, reference.path);
  const intent = parseDesignIntent(JSON.parse(await readFile(path, "utf8")));
  const sha256 = designIntentSha256(intent);
  if (intent.id !== reference.id || intent.version !== reference.version) {
    throw new Error(`Design intent identity mismatch: campaign pins ${reference.id}@${reference.version}, file is ${intent.id}@${intent.version}`);
  }
  if (sha256 !== reference.sha256) throw new Error(`Design intent hash mismatch for ${reference.path}`);
  return { path, intent, sha256 };
}

function artifact(path: string, kind: ArtifactReference["kind"], label: string, mediaType: string): ArtifactReference {
  return { path, kind, label, mediaType };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function aggregate(values: number[], kind: MetricAggregate): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (kind === "mean") return mean;
  if (kind === "min") return Math.min(...values);
  if (kind === "max") return Math.max(...values);
  if (kind === "p10") return percentile(values, 0.1);
  if (kind === "p90") return percentile(values, 0.9);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function criterionScore(value: number, criterion: PlaytestMetric): number {
  if (criterion.min !== undefined && value < criterion.min) {
    const scale = Math.max(Math.abs(criterion.min), 1);
    return Math.max(0, 1 - (criterion.min - value) / scale);
  }
  if (criterion.max !== undefined && value > criterion.max) {
    const scale = Math.max(Math.abs(criterion.max), 1);
    return Math.max(0, 1 - (value - criterion.max) / scale);
  }
  return 1;
}

async function mapBounded<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`Playtest worker ${index} did not return a result`);
    return result;
  });
}

export class DesignIntentEvaluator implements Evaluator {
  readonly id = "design.intent";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    try {
      const loaded = await loadIntent(candidate, input.campaign);
      return {
        evaluator: this.id,
        version: this.version,
        status: "pass",
        metrics: {
          design_integrity: 1,
          design_pillars: loaded.intent.playerExperience.pillars.length,
          design_hypotheses: loaded.intent.hypotheses.length,
          playtester_personas: loaded.intent.playtests.personas.length,
          playtest_scenarios: loaded.intent.playtests.scenarios.length,
          playtest_seeds: loaded.intent.playtests.seeds.length
        },
        violations: [],
        artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
        confidence: 1,
        summary: `Verified ${loaded.intent.id}@${loaded.intent.version} (${loaded.sha256.slice(0, 12)}).`
      };
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { design_integrity: 0 },
        violations: [{ code: "design.intent.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [],
        confidence: 1,
        summary: "Design intent verification failed."
      };
    }
  }
}

export class AgentPlaytestEvaluator implements Evaluator {
  readonly id = "playtest.agents";
  readonly version = "1.0.0";

  constructor(
    private readonly getScenario: (id: string) => ScenarioRunner,
    private readonly getEngine: (id: string) => EngineDriver
  ) {}

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    let loaded: LoadedIntent;
    try {
      loaded = await loadIntent(candidate, input.campaign);
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { playtest_score: 0, design_integrity: 0 },
        violations: [{ code: "playtest.intent.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [],
        confidence: 0,
        summary: "Synthetic playtesting requires a valid design intent."
      };
    }
    const settings = object(input.campaign.parameters?.playtest);
    const scenarioRunnerId = typeof settings.scenarioRunner === "string" ? settings.scenarioRunner : "godot.scenario";
    const engineId = typeof settings.engine === "string" ? settings.engine : "godot.engine";
    const importCheck = settings.importCheck !== false;
    const maximumRuns = typeof settings.maximumRuns === "number" && Number.isSafeInteger(settings.maximumRuns)
      ? Math.max(1, Math.min(512, settings.maximumRuns))
      : 128;
    const artifacts: ArtifactReference[] = [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")];
    if (importCheck) {
      try {
        const engine = this.getEngine(engineId);
        if (engine.build) {
          const built = await engine.build({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: `${input.experimentId}-playtest-import`, signal: input.signal });
          artifacts.push(...built.artifacts);
          if (!built.ok) {
            return {
              evaluator: this.id,
              version: this.version,
              status: "fail",
              metrics: { playtest_score: 0, import_ok: 0, design_integrity: 1 },
              violations: [{ code: "playtest.import", message: "The candidate failed its engine import/build gate.", severity: "error" }],
              artifacts,
              confidence: 1,
              summary: "Synthetic playtesting stopped at the import gate."
            };
          }
        }
      } catch (error) {
        return {
          evaluator: this.id,
          version: this.version,
          status: "fail",
          metrics: { playtest_score: 0, import_ok: 0, design_integrity: 1 },
          violations: [{ code: "playtest.engine", message: error instanceof Error ? error.message : String(error), severity: "error" }],
          artifacts,
          confidence: 0,
          summary: "Synthetic playtest engine is unavailable."
        };
      }
    }
    const specifications = loaded.intent.playtests.scenarios.flatMap((scenario) =>
      loaded.intent.playtests.personas.flatMap((persona) =>
        loaded.intent.playtests.seeds.map((seed) => ({ scenario, persona, seed }))));
    if (specifications.length > maximumRuns) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { playtest_score: 0, planned_runs: specifications.length, maximum_runs: maximumRuns, design_integrity: 1 },
        violations: [{ code: "playtest.run-limit", message: `Design requests ${specifications.length} runs, exceeding maximumRuns=${maximumRuns}.`, severity: "error" }],
        artifacts,
        confidence: 1,
        summary: "Synthetic playtest matrix exceeds its explicit safety limit."
      };
    }
    let scenarioRunner: ScenarioRunner;
    try {
      scenarioRunner = this.getScenario(scenarioRunnerId);
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { playtest_score: 0, design_integrity: 1 },
        violations: [{ code: "playtest.runner", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts,
        confidence: 0,
        summary: "Configured scenario runner is unavailable."
      };
    }
    const runs = await mapBounded(specifications, loaded.intent.playtests.concurrency, async (specification, index): Promise<PlaytestRun> => {
      const id = `${input.experimentId}-pt-${String(index + 1).padStart(3, "0")}-${sanitize(specification.persona.id)}-${sanitize(specification.scenario.id)}-s${specification.seed}`;
      const scenario: ScenarioReference = {
        provider: loaded.intent.playtests.provider,
        version: loaded.intent.playtests.version,
        path: loaded.intent.playtests.path,
        parameters: {
          ...specification.scenario.parameters,
          ...specification.persona.parameters,
          seed: specification.seed,
          playtester_id: specification.persona.id,
          playtester_kind: specification.persona.kind
        }
      };
      try {
        const result = await scenarioRunner.run({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: id, scenario, signal: input.signal });
        return { id, persona: specification.persona.id, scenario: specification.scenario.id, seed: specification.seed, result };
      } catch (error) {
        return {
          id,
          persona: specification.persona.id,
          scenario: specification.scenario.id,
          seed: specification.seed,
          result: {
            status: "crash",
            metrics: {},
            artifacts: [],
            violations: [{ code: "playtest.run-crash", message: error instanceof Error ? error.message : String(error), severity: "error" }]
          }
        };
      }
    });
    for (const run of runs) artifacts.push(...run.result.artifacts);
    const violations: Violation[] = [];
    const failedRuns = runs.filter((run) => run.result.status !== "pass");
    for (const run of failedRuns) {
      violations.push({
        code: run.result.status === "crash" ? "playtest.agent.crash" : "playtest.agent.failed",
        message: `${run.persona}/${run.scenario}/seed-${run.seed} ${run.result.status}.`,
        severity: "error"
      });
    }
    const metrics: Record<string, number> = {
      design_integrity: 1,
      import_ok: 1,
      planned_runs: runs.length,
      completed_runs: runs.length - failedRuns.length,
      playtest_pass_rate: runs.length > 0 ? (runs.length - failedRuns.length) / runs.length : 0,
      persona_coverage: loaded.intent.playtests.personas.length,
      scenario_coverage: loaded.intent.playtests.scenarios.length,
      seed_coverage: loaded.intent.playtests.seeds.length
    };
    let weightedScore = 0;
    let totalWeight = 0;
    for (const criterion of loaded.intent.playtests.metrics) {
      const values = runs
        .filter((run) => run.result.status === "pass")
        .map((run) => run.result.metrics[criterion.metric])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (values.length === 0) {
        violations.push({ code: "playtest.metric.missing", message: `No successful run produced ${criterion.metric}.`, severity: "error" });
        continue;
      }
      const value = aggregate(values, criterion.aggregate);
      metrics[`${criterion.metric}.${criterion.aggregate}`] = Number(value.toFixed(6));
      weightedScore += criterionScore(value, criterion) * criterion.weight;
      totalWeight += criterion.weight;
      const outside = (criterion.min !== undefined && value < criterion.min) || (criterion.max !== undefined && value > criterion.max);
      if (outside && criterion.hard) {
        violations.push({ code: `playtest.quality.${criterion.metric}.${criterion.aggregate}`, message: `${criterion.metric}.${criterion.aggregate}=${value.toFixed(6)} violates its hard quality bar.`, severity: "error" });
      } else if (outside) {
        violations.push({ code: `playtest.signal.${criterion.metric}.${criterion.aggregate}`, message: `${criterion.metric}.${criterion.aggregate}=${value.toFixed(6)} is outside its desired range.`, severity: "warning" });
      }
    }
    for (const persona of loaded.intent.playtests.personas) {
      const personaRuns = runs.filter((run) => run.persona === persona.id && run.result.status === "pass");
      for (const criterion of loaded.intent.playtests.metrics) {
        const values = personaRuns.map((run) => run.result.metrics[criterion.metric]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        if (values.length > 0) metrics[`persona.${persona.id}.${criterion.metric}.mean`] = Number(aggregate(values, "mean").toFixed(6));
      }
    }
    metrics.playtest_score = Number((totalWeight > 0 ? weightedScore / totalWeight : 0).toFixed(6));
    const reportDirectory = resolve(candidate.root, ".factory", "runs", input.experimentId, "agent-playtest");
    const reportPath = resolve(reportDirectory, "report.json");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
      apiVersion: "gamefactory.synthetic-playtest/v1",
      designIntent: { id: loaded.intent.id, version: loaded.intent.version, sha256: loaded.sha256 },
      synthetic: true,
      runs: runs.map((run) => ({ id: run.id, persona: run.persona, scenario: run.scenario, seed: run.seed, status: run.result.status, metrics: run.result.metrics, violations: run.result.violations })),
      metrics,
      violations
    }, null, 2)}\n`, "utf8");
    artifacts.push(artifact(reportPath, "test-report", "Synthetic agent playtest cohort", "application/json"));
    const confidence = runs.length > 0 ? Number(((runs.length - failedRuns.length) / runs.length).toFixed(6)) : 0;
    return {
      evaluator: this.id,
      version: this.version,
      status: violations.some((violation) => violation.severity === "error") ? "fail" : "pass",
      metrics,
      violations,
      artifacts,
      confidence,
      summary: `${runs.length} synthetic engine playtests across ${loaded.intent.playtests.personas.length} personas, ${loaded.intent.playtests.scenarios.length} scenarios, and ${loaded.intent.playtests.seeds.length} seeds; this is not human-experience evidence.`
    };
  }
}

export class HumanPlaytestEvaluator implements Evaluator {
  readonly id = "playtest.human";
  readonly version = "1.0.0";

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    let loaded: LoadedIntent;
    try {
      loaded = await loadIntent(candidate, input.campaign);
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { human_approval: 0, design_integrity: 0 },
        violations: [{ code: "playtest.human.intent", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [],
        confidence: 1,
        summary: "Human evidence does not have a valid design-intent target."
      };
    }
    const settings = object(input.campaign.parameters?.playtest);
    if (typeof settings.humanReportPath !== "string" || settings.humanReportPath.length === 0) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "inconclusive",
        metrics: { human_approval: 0, design_integrity: 1 },
        violations: [{ code: "playtest.human.missing", message: "No humanReportPath is configured; synthetic evidence cannot satisfy this gate.", severity: "info" }],
        artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
        confidence: 0,
        summary: "Awaiting an explicit human playtest report."
      };
    }
    const reportPath = resolveDesignPath(candidate.root, settings.humanReportPath.replaceAll("{experiment}", input.experimentId));
    let reportSource: string;
    try {
      reportSource = await readFile(reportPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          evaluator: this.id,
          version: this.version,
          status: "inconclusive",
          metrics: { human_approval: 0, design_integrity: 1 },
          violations: [{ code: "playtest.human.missing", message: `Human playtest report does not exist at ${settings.humanReportPath}.`, severity: "info" }],
          artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
          confidence: 0,
          summary: "Awaiting an explicit human playtest report."
        };
      }
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { human_approval: 0, design_integrity: 1 },
        violations: [{ code: "playtest.human.read", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
        confidence: 1,
        summary: "Human playtest report could not be read."
      };
    }
    try {
      const report = parseHumanPlaytestReport(JSON.parse(reportSource));
      if (report.designIntent.id !== loaded.intent.id || report.designIntent.version !== loaded.intent.version || report.designIntent.sha256 !== loaded.sha256) {
        throw new Error("Human report targets a different design intent or version");
      }
      if (typeof settings.humanSubjectId === "string" && report.subject.id !== settings.humanSubjectId) {
        throw new Error(`Human report subject ${report.subject.id} does not match configured subject ${settings.humanSubjectId}`);
      }
      const pillarIds = new Set(loaded.intent.playerExperience.pillars.map((pillar) => pillar.id));
      for (const finding of report.findings) {
        for (const pillarId of finding.pillarIds) {
          if (!pillarIds.has(pillarId)) throw new Error(`Human finding ${finding.id} references unknown design pillar ${pillarId}`);
        }
      }
      if (!report.study.consentConfirmed) throw new Error("Human report does not confirm participant consent");
      if (report.study.containsPersonalData) {
        return {
          evaluator: this.id,
          version: this.version,
          status: "fail",
          metrics: { human_approval: 0, design_integrity: 1, participant_count: report.study.participantCount },
          violations: [{ code: "playtest.human.personal-data", message: "Refusing to ingest or preserve a report marked as containing personal data.", severity: "error" }],
          artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
          confidence: 1,
          summary: "Human report was rejected by the privacy gate."
        };
      }
      const blockers = report.findings.filter((finding) => finding.severity === "blocker");
      const concerns = report.findings.filter((finding) => finding.severity === "concern");
      const approved = report.decision.status === "approve" && blockers.length === 0;
      const violations: Violation[] = [
        ...blockers.map((finding): Violation => ({ code: `playtest.human.${finding.id}`, message: finding.observation, severity: "error" })),
        ...concerns.map((finding): Violation => ({ code: `playtest.human.${finding.id}`, message: finding.observation, severity: "warning" }))
      ];
      if (!approved && blockers.length === 0) violations.push({ code: "playtest.human.decision", message: report.decision.rationale, severity: "error" });
      return {
        evaluator: this.id,
        version: this.version,
        status: approved ? "pass" : "fail",
        metrics: {
          human_approval: approved ? 1 : 0,
          design_integrity: 1,
          participant_count: report.study.participantCount,
          audience_match: report.study.audienceMatch,
          blocker_findings: blockers.length,
          concern_findings: concerns.length
        },
        violations,
        artifacts: [
          artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json"),
          artifact(reportPath, "test-report", `Human playtest ${report.id}`, "application/json")
        ],
        confidence: Math.min(1, report.study.audienceMatch * Math.min(1, report.study.participantCount / 5)),
        summary: `Human study ${report.id}: ${report.decision.status} by ${report.decision.decidedBy}; ${report.study.participantCount} participants.`
      };
    } catch (error) {
      return {
        evaluator: this.id,
        version: this.version,
        status: "fail",
        metrics: { human_approval: 0, design_integrity: 1 },
        violations: [{ code: "playtest.human.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }],
        artifacts: [artifact(loaded.path, "profile", `Design intent ${loaded.intent.id}@${loaded.intent.version}`, "application/json")],
        confidence: 1,
        summary: "Human playtest report validation failed."
      };
    }
  }
}

export default defineExtension((api) => combineDisposables(
  api.register("evaluator", "design.system", new DesignSystemEvaluator()),
  api.register("evaluator", "design.intent", new DesignIntentEvaluator()),
  api.register("evaluator", "playtest.agents", new AgentPlaytestEvaluator(
    (id) => api.get<ScenarioRunner>("scenario", id),
    (id) => api.get<EngineDriver>("engine", id)
  )),
  api.register("evaluator", "playtest.human", new HumanPlaytestEvaluator())
));
