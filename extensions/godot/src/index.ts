import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactReference, Campaign, Candidate, DoctorResult, EngineDriver, Evaluation, Evaluator, ExecutionResult, ScenarioReference, ScenarioResult, ScenarioRunner } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";

interface GodotConfig {
  binary: string;
  importCheck: boolean;
  timeoutSeconds: number;
  rendered: boolean;
  scenario: ScenarioReference;
}

interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }

function config(campaign: Campaign): GodotConfig {
  const raw = campaign.parameters?.godot;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const scenarioRaw = value.scenario && typeof value.scenario === "object" && !Array.isArray(value.scenario)
    ? value.scenario as Record<string, unknown>
    : {};
  return {
    binary: typeof value.binary === "string" ? value.binary : process.env.GODOT_BINARY ?? "godot",
    importCheck: value.importCheck !== false,
    timeoutSeconds: typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : 90,
    rendered: value.rendered === true,
    scenario: {
      provider: typeof scenarioRaw.provider === "string" ? scenarioRaw.provider : "godot.factory/v1",
      version: typeof scenarioRaw.version === "string" ? scenarioRaw.version : "1",
      path: typeof scenarioRaw.path === "string" ? scenarioRaw.path : "res://main.tscn",
      ...(scenarioRaw.parameters && typeof scenarioRaw.parameters === "object" && !Array.isArray(scenarioRaw.parameters)
        ? { parameters: scenarioRaw.parameters as Record<string, unknown> }
        : {})
    }
  };
}

function execute(binary: string, args: string[], cwd: string, signal: AbortSignal, timeoutSeconds: number): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Godot timed out")); }, timeoutSeconds * 1000);
    const child = spawn(binary, args, { cwd, signal: controller.signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      if (timedOut) resolveResult({ exitCode: null, stdout, stderr: `${stderr}\nGodot timed out.`, timedOut });
      else reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      resolveResult({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function logArtifact(path: string, label: string): ArtifactReference {
  return { kind: "log", path, mediaType: "text/plain", label };
}

async function writeProcessLogs(directory: string, prefix: string, processResult: ProcessResult): Promise<ArtifactReference[]> {
  const stdoutPath = resolve(directory, `${prefix}.stdout.log`);
  const stderrPath = resolve(directory, `${prefix}.stderr.log`);
  await Promise.all([writeFile(stdoutPath, processResult.stdout, "utf8"), writeFile(stderrPath, processResult.stderr, "utf8")]);
  return [logArtifact(stdoutPath, `${prefix} stdout`), logArtifact(stderrPath, `${prefix} stderr`)];
}

export class GodotEngine implements EngineDriver {
  readonly id = "godot.engine";

  async doctor({ campaign, projectRoot, signal }: Parameters<EngineDriver["doctor"]>[0]): Promise<DoctorResult> {
    const settings = config(campaign);
    try {
      const version = await execute(settings.binary, ["--version"], projectRoot, signal, 15);
      return { ok: version.exitCode === 0, checks: [{ name: "godot-binary", ok: version.exitCode === 0, message: version.stdout.trim() || version.stderr.trim() }] };
    } catch (error) {
      return { ok: false, checks: [{ name: "godot-binary", ok: false, message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async build(context: Parameters<NonNullable<EngineDriver["build"]>>[0]): Promise<ExecutionResult> {
    const settings = config(context.campaign);
    const run = await execute(settings.binary, ["--headless", "--editor", "--quit", "--path", context.candidate.root], context.candidate.root, context.signal, settings.timeoutSeconds);
    const output = resolve(context.candidate.root, ".factory", "runs", context.experimentId, "import");
    await mkdir(output, { recursive: true });
    const artifacts = await writeProcessLogs(output, "godot-import", run);
    return { ok: run.exitCode === 0, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, artifacts, metrics: { import_ok: run.exitCode === 0 ? 1 : 0 } };
  }
}

export class GodotScenarioRunner implements ScenarioRunner {
  readonly id = "godot.scenario";

  async run(input: Parameters<ScenarioRunner["run"]>[0]): Promise<ScenarioResult> {
    const settings = config(input.campaign);
    const output = resolve(input.candidate.root, ".factory", "runs", input.experimentId, "scenario");
    await mkdir(output, { recursive: true });
    const requestPath = resolve(output, "request.json");
    await writeFile(requestPath, `${JSON.stringify(input.scenario, null, 2)}\n`, "utf8");
    const args = [
      ...(settings.rendered ? [] : ["--headless"]),
      "--path", input.candidate.root,
      "--script", "res://addons/gamefactory/scenario_runner.gd",
      "--", "--request", requestPath, "--output", output
    ];
    let processResult: ProcessResult;
    try {
      processResult = await execute(settings.binary, args, input.candidate.root, input.signal, settings.timeoutSeconds);
    } catch (error) {
      return { status: "crash", metrics: {}, artifacts: [], violations: [{ code: "godot.launch", message: error instanceof Error ? error.message : String(error), severity: "error" }] };
    }
    const artifacts = await writeProcessLogs(output, "godot-scenario", processResult);
    const resultPath = resolve(output, "result.json");
    try {
      const raw = JSON.parse(await readFile(resultPath, "utf8")) as Partial<ScenarioResult>;
      artifacts.push({ kind: "test-report", path: resultPath, mediaType: "application/json", label: "Godot scenario result" });
      for (const artifact of raw.artifacts ?? []) artifacts.push(artifact);
      return {
        status: raw.status ?? (processResult.exitCode === 0 ? "pass" : "crash"),
        metrics: raw.metrics ?? {},
        artifacts,
        violations: raw.violations ?? [],
        ...(raw.metadata ? { metadata: raw.metadata } : {})
      };
    } catch {
      return {
        status: "crash",
        metrics: {},
        artifacts,
        violations: [{ code: "godot.result.missing", message: `Godot exited ${processResult.exitCode} without a valid result.json`, severity: "error" }],
        metadata: { timedOut: processResult.timedOut }
      };
    }
  }
}

export class GodotScenarioEvaluator implements Evaluator {
  readonly id = "godot.scenario";
  readonly version = "1.0.0";
  constructor(private readonly engine: GodotEngine, private readonly scenarios: GodotScenarioRunner) {}

  async evaluate(input: Parameters<Evaluator["evaluate"]>[0]): Promise<Evaluation> {
    const candidate: Candidate = input.candidate ?? { id: "baseline", root: input.campaign.projectRoot, metadata: { baseline: true } };
    const settings = config(input.campaign);
    const artifacts: ArtifactReference[] = [];
    if (settings.importCheck) {
      const imported = await this.engine.build!({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: input.experimentId, signal: input.signal });
      artifacts.push(...imported.artifacts);
      if (!imported.ok) return { evaluator: this.id, version: this.version, status: "fail", metrics: imported.metrics ?? { import_ok: 0 }, violations: [{ code: "godot.import", message: "Godot import or script validation failed.", severity: "error" }], artifacts, summary: "Stopped at the import gate." };
    }
    const run = await this.scenarios.run({ campaign: input.campaign, projectRoot: candidate.root, candidate, experimentId: input.experimentId, scenario: settings.scenario, signal: input.signal });
    artifacts.push(...run.artifacts);
    return {
      evaluator: this.id,
      version: this.version,
      status: run.status === "pass" ? "pass" : "fail",
      metrics: { import_ok: 1, ...run.metrics },
      violations: run.violations,
      artifacts,
      confidence: run.status === "crash" ? 0 : 1,
      summary: run.status === "pass" ? "Godot scenario passed." : `Godot scenario ${run.status}.`
    };
  }
}

export default defineExtension((api) => {
  const engine = new GodotEngine();
  const scenarios = new GodotScenarioRunner();
  return combineDisposables(
    api.register("engine", "godot.engine", engine),
    api.register("scenario", "godot.scenario", scenarios),
    api.register("evaluator", "godot.scenario", new GodotScenarioEvaluator(engine, scenarios))
  );
});
