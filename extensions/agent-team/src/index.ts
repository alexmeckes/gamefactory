import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentContribution, AgentDriver, AgentRequest, AgentResult, ArtifactReference } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

type TeamStage = "scout" | "planner" | "implementer" | "critic";

interface ContributorConfig {
  id: string;
  command: string[];
}

interface AgentTeamConfig {
  scouts: ContributorConfig[];
  planner: ContributorConfig;
  implementer: ContributorConfig;
  critics: ContributorConfig[];
  maxOutputCharacters: number;
  maximumParallel: number;
}

interface PriorOutput {
  contributorId: string;
  stage: TeamStage;
  summary: string;
  output: string;
  stdoutPath: string;
}

export interface ContributorProvenance {
  contributorId: string;
  stage: TeamStage;
  readOnly: boolean;
  command: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  status: "complete" | "failed";
  summary: string;
  requestPath: string;
  stdoutPath: string;
  stderrPath: string;
}

interface ContributorRun {
  provenance: ContributorProvenance;
  stdout: string;
  stderr: string;
  artifacts: ArtifactReference[];
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

const INSTRUCTIONS: Record<TeamStage, string> = {
  scout: "Inspect the candidate and propose a focused hypothesis. Do not modify any project file. Return findings on stdout.",
  planner: "Synthesize the scout findings into one concrete, bounded implementation plan. Do not modify any project file. Return the plan on stdout.",
  implementer: "Implement the supplied plan in the candidate. You are the only contributor allowed to modify project files. Return a concise change summary on stdout.",
  critic: "Review the implemented candidate against the objective and supplied evidence. Do not modify any project file. Return risks and recommendations on stdout."
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string") && value[0]!.length > 0;
}

function contributor(value: unknown, defaultId: string, location: string): ContributorConfig {
  if (isStringArray(value)) return { id: defaultId, command: [...value] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be a command string array or an object with id and command`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id ?? defaultId;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${location}.id must use only letters, numbers, dots, underscores, and hyphens`);
  }
  if (!isStringArray(record.command)) throw new Error(`${location}.command must be a non-empty string array`);
  return { id, command: [...record.command] };
}

function contributorList(value: unknown, stage: "scout" | "critic"): ContributorConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`parameters.agentTeam.${stage}s must be a non-empty array`);
  if (value.length > 64) throw new Error(`parameters.agentTeam.${stage}s cannot contain more than 64 contributors`);
  const contributors = value.map((item, index) => contributor(item, `${stage}-${index + 1}`, `parameters.agentTeam.${stage}s[${index}]`));
  const ids = new Set<string>();
  for (const item of contributors) {
    if (ids.has(item.id)) throw new Error(`parameters.agentTeam.${stage}s contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
  return contributors;
}

function readConfig(request: AgentRequest): AgentTeamConfig {
  const value = request.campaign.parameters?.agentTeam;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("parameters.agentTeam must configure scouts, planner, implementer, and critics");
  }
  const record = value as Record<string, unknown>;
  const maxOutputCharacters = record.maxOutputCharacters ?? 20_000;
  if (!Number.isInteger(maxOutputCharacters) || Number(maxOutputCharacters) < 1 || Number(maxOutputCharacters) > 1_000_000) {
    throw new Error("parameters.agentTeam.maxOutputCharacters must be an integer from 1 to 1000000");
  }
  const maximumParallel = record.maximumParallel ?? 4;
  if (!Number.isInteger(maximumParallel) || Number(maximumParallel) < 1 || Number(maximumParallel) > 32) {
    throw new Error("parameters.agentTeam.maximumParallel must be an integer from 1 to 32");
  }
  return {
    scouts: contributorList(record.scouts, "scout"),
    planner: contributor(record.planner, "planner", "parameters.agentTeam.planner"),
    implementer: contributor(record.implementer, "implementer", "parameters.agentTeam.implementer"),
    critics: contributorList(record.critics, "critic"),
    maxOutputCharacters: Number(maxOutputCharacters),
    maximumParallel: Number(maximumParallel)
  };
}

function renderCommand(command: string[], request: AgentRequest, stage: TeamStage, contributorId: string): string[] {
  const replacements: Record<string, string> = {
    "{candidate}": request.candidate.root,
    "{experiment}": request.experimentId,
    "{objective}": request.campaign.objective,
    "{stage}": stage,
    "{contributor}": contributorId
  };
  return command.map((part) => Object.entries(replacements).reduce(
    (rendered, [token, replacement]) => rendered.replaceAll(token, replacement),
    part
  ));
}

function processCommand(executable: string, args: string[], requestPath: string, request: AgentRequest, stage: TeamStage, contributorId: string): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const child = spawn(executable, args, {
      cwd: request.candidate.root,
      signal: request.signal,
      windowsHide: true,
      env: {
        ...process.env,
        GAMEFACTORY_REQUEST: requestPath,
        GAMEFACTORY_CANDIDATE: request.candidate.root,
        GAMEFACTORY_STAGE: stage,
        GAMEFACTORY_CONTRIBUTOR: contributorId
      }
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => finish(spawnError ? { code, stdout, stderr, spawnError } : { code, stdout, stderr }));
  });
}

function lastLine(output: string, fallback: string): string {
  return output.trim().split(/\r?\n/).at(-1) || fallback;
}

function boundedOutput(output: string, maximum: number): string {
  if (output.length <= maximum) return output;
  return `[truncated ${output.length - maximum} characters]\n${output.slice(-maximum)}`;
}

function priorOutput(run: ContributorRun, maximum: number): PriorOutput {
  return {
    contributorId: run.provenance.contributorId,
    stage: run.provenance.stage,
    summary: run.provenance.summary,
    output: boundedOutput(run.stdout, maximum),
    stdoutPath: run.provenance.stdoutPath
  };
}

async function invokeContributor(
  config: ContributorConfig,
  stage: TeamStage,
  readOnly: boolean,
  request: AgentRequest,
  inputs: PriorOutput[]
): Promise<ContributorRun> {
  const command = renderCommand(config.command, request, stage, config.id);
  const [executable, ...args] = command;
  if (!executable) throw new Error(`${stage} ${config.id} has no executable`);
  const outputDirectory = resolve(request.candidate.root, ".factory", "agent-team", request.experimentId, stage, config.id);
  await mkdir(outputDirectory, { recursive: true });
  const requestPath = resolve(outputDirectory, "request.json");
  const stdoutPath = resolve(outputDirectory, "stdout.log");
  const stderrPath = resolve(outputDirectory, "stderr.log");
  const payload = {
    objective: request.campaign.objective,
    experimentId: request.experimentId,
    candidateRoot: request.candidate.root,
    mutablePaths: request.campaign.mutablePaths ?? [],
    immutablePaths: request.campaign.immutablePaths ?? [],
    stage,
    contributorId: config.id,
    readOnly,
    instructions: INSTRUCTIONS[stage],
    inputs,
    history: request.history.map((item) => ({
      id: item.experimentId,
      status: item.status,
      summary: item.summary,
      metrics: item.metrics
    }))
  };
  await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await processCommand(executable, args, requestPath, request, stage, config.id);
  const finished = Date.now();
  await Promise.all([
    writeFile(stdoutPath, result.stdout, "utf8"),
    writeFile(stderrPath, result.stderr, "utf8")
  ]);
  const status = result.code === 0 && !result.spawnError ? "complete" : "failed";
  const summary = lastLine(result.stdout, `${stage} ${config.id} ${status}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    provenance: {
      contributorId: config.id,
      stage,
      readOnly,
      command,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      exitCode: result.code,
      status,
      summary,
      requestPath,
      stdoutPath,
      stderrPath
    },
    artifacts: [
      { kind: "log", path: stdoutPath, mediaType: "text/plain", label: `${stage} ${config.id} stdout`, metadata: { stage, contributorId: config.id } },
      { kind: "log", path: stderrPath, mediaType: "text/plain", label: `${stage} ${config.id} stderr`, metadata: { stage, contributorId: config.id } },
      { kind: "other", path: requestPath, mediaType: "application/json", label: `${stage} ${config.id} request`, metadata: { stage, contributorId: config.id } }
    ]
  };
}

function isFactoryPath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes(".factory");
}

function meaningfulStatus(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).split(" -> ").at(-1)?.replaceAll("\\", "/") ?? "";
      return !isFactoryPath(path);
    })
    .sort()
    .join("\n");
}

async function gitOutput(request: AgentRequest, args: string[], operation: string): Promise<string> {
  const result = await processCommand(
    "git",
    args,
    "",
    request,
    "scout",
    "read-only-guard"
  );
  if (result.code !== 0 || result.spawnError) {
    const detail = result.spawnError?.message ?? result.stderr.trim();
    throw new Error(`agent.team requires a Git candidate for read-only enforcement (${operation}): ${detail}`);
  }
  return result.stdout;
}

async function fingerprint(path: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (stats.isFile()) return `file:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  return `other:${stats.mode}:${stats.size}`;
}

async function gitSnapshot(request: AgentRequest): Promise<string> {
  const [rawStatus, trackedDiff, rawUntracked] = await Promise.all([
    gitOutput(request, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"], "status"),
    gitOutput(request, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)**/.factory/**"], "diff"),
    gitOutput(request, ["ls-files", "--others", "--exclude-standard", "-z"], "untracked files")
  ]);
  const untrackedPaths = rawUntracked.split("\0").filter((path) => path && !isFactoryPath(path)).sort();
  const untracked = await Promise.all(untrackedPaths.map(async (path) => `${path}:${await fingerprint(resolve(request.candidate.root, path))}`));
  return JSON.stringify({ status: meaningfulStatus(rawStatus), trackedDiff, untracked });
}

function assertRunsSucceeded(stage: TeamStage, runs: ContributorRun[]): void {
  const failures = runs.filter((run) => run.provenance.status === "failed");
  if (failures.length === 0) return;
  const details = failures.map((run) => {
    const reason = run.stderr.trim().slice(-1000) || `exit ${String(run.provenance.exitCode)}`;
    return `${run.provenance.contributorId}: ${reason}`;
  }).join("; ");
  throw new Error(`agent.team ${stage} stage failed: ${details}`);
}

async function runReadOnlyBatch(
  stage: "scout" | "critic",
  contributors: ContributorConfig[],
  request: AgentRequest,
  inputs: PriorOutput[],
  maximumParallel: number
): Promise<ContributorRun[]> {
  const before = await gitSnapshot(request);
  const runs = await mapParallel(contributors, maximumParallel, (item) => invokeContributor(item, stage, true, request, inputs));
  const after = await gitSnapshot(request);
  if (before !== after) throw new Error(`agent.team read-only ${stage} stage modified meaningful candidate files`);
  assertRunsSucceeded(stage, runs);
  return runs;
}

async function runReadOnlySingle(
  stage: "planner",
  config: ContributorConfig,
  request: AgentRequest,
  inputs: PriorOutput[]
): Promise<ContributorRun> {
  const before = await gitSnapshot(request);
  const run = await invokeContributor(config, stage, true, request, inputs);
  const after = await gitSnapshot(request);
  if (before !== after) throw new Error(`agent.team read-only ${stage} stage modified meaningful candidate files`);
  assertRunsSucceeded(stage, [run]);
  return run;
}

async function mapParallel<T, R>(items: T[], maximumParallel: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maximumParallel, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

export class AgentTeam implements AgentDriver {
  readonly id = "agent.team";

  async run(request: AgentRequest): Promise<AgentResult> {
    const config = readConfig(request);
    const scouts = await runReadOnlyBatch("scout", config.scouts, request, [], config.maximumParallel);
    const scoutOutputs = scouts.map((run) => priorOutput(run, config.maxOutputCharacters));
    const planner = await runReadOnlySingle("planner", config.planner, request, scoutOutputs);
    const implementationInputs = [...scoutOutputs, priorOutput(planner, config.maxOutputCharacters)];
    const implementer = await invokeContributor(config.implementer, "implementer", false, request, implementationInputs);
    assertRunsSucceeded("implementer", [implementer]);
    const criticInputs = [...implementationInputs, priorOutput(implementer, config.maxOutputCharacters)];
    const critics = await runReadOnlyBatch("critic", config.critics, request, criticInputs, config.maximumParallel);
    const runs = [...scouts, planner, implementer, ...critics];
    const contributors: AgentContribution[] = runs.map((run) => ({
      agentId: run.provenance.contributorId,
      role: run.provenance.stage,
      status: run.provenance.status,
      startedAt: run.provenance.startedAt,
      finishedAt: run.provenance.finishedAt,
      summary: run.provenance.summary,
      artifacts: run.artifacts,
      metadata: {
        readOnly: run.provenance.readOnly,
        command: run.provenance.command,
        durationMs: run.provenance.durationMs,
        exitCode: run.provenance.exitCode,
        requestPath: run.provenance.requestPath,
        stdoutPath: run.provenance.stdoutPath,
        stderrPath: run.provenance.stderrPath
      }
    }));
    const criticSummary = critics.map((run) => `${run.provenance.contributorId}: ${run.provenance.summary}`).join("; ");
    const result: AgentResult = {
      summary: `${implementer.provenance.summary}${criticSummary ? ` | Critics: ${criticSummary}` : ""}`,
      artifacts: runs.flatMap((run) => run.artifacts),
      metadata: {
        pipeline: this.id,
        stages: {
          scouts: scouts.map((run) => run.provenance.contributorId),
          planner: planner.provenance.contributorId,
          implementer: implementer.provenance.contributorId,
          critics: critics.map((run) => run.provenance.contributorId)
        }
      },
      contributors
    };
    return result;
  }
}

export default defineExtension((api) => api.register("agent", "agent.team", new AgentTeam()));
