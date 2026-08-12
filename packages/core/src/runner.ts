import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Campaign, CampaignResult, EngineDriver, FactoryConfig, Logger, Workflow } from "./types.js";
import { BudgetController } from "./budget.js";
import { CapabilityRegistry } from "./registry.js";
import { discoverExtension, ExtensionManager } from "./extension-manager.js";
import { JsonlResultStore } from "./results.js";
import { ContentAddressedArtifactStore } from "./artifacts.js";
import { WorkflowJournal, type JournalJsonValue } from "./journal.js";
import { JsonlTraceStore, type TraceSink } from "./trace.js";

const execFileAsync = promisify(execFile);

export interface RunnerOptions {
  cwd: string;
  config: FactoryConfig;
  logger: Logger;
  signal?: AbortSignal;
}

function outputPath(cwd: string, configured: string | undefined, fallback: string, label: string): string {
  const target = resolve(cwd, configured ?? fallback);
  const traversal = relative(resolve(cwd), target);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error(`${label} must stay inside the runner working directory`);
  }
  return target;
}

function assertRuntimeCampaign(campaign: Campaign): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(campaign.id)) throw new Error("Unsafe campaign id");
  if (!campaign.objective.trim()) throw new Error("Campaign objective must not be empty");
  if (!campaign.workflow.trim()) throw new Error("Campaign workflow must not be empty");
}

async function acquireRunLease(path: string, runId: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const owner = { token: randomUUID(), runId, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  const create = async () => {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another GameFactory run owns ${path}; inspect the lease before retrying, and remove it manually only if that run is no longer active.`);
  }
  return async () => {
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
      if (existing.token === owner.token) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

async function gitProjectRevision(projectRoot: string): Promise<string | undefined> {
  try {
    const { stdout: revision } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { windowsHide: true });
    const { stdout: status } = await execFileAsync("git", ["-C", projectRoot, "status", "--porcelain", "--untracked-files=all"], { windowsHide: true });
    if (status.trim()) throw new Error("Project repository is dirty; commit or stash changes before a resumable factory run.");
    return revision.trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Project repository is dirty")) throw error;
    return undefined;
  }
}

export class FactoryRunner {
  readonly registry = new CapabilityRegistry();
  readonly extensions: ExtensionManager;

  constructor(private readonly options: RunnerOptions) {
    this.extensions = new ExtensionManager(this.registry, options.logger);
  }

  async initialize(): Promise<void> {
    for (const path of this.options.config.extensions) {
      this.extensions.addDescriptor(await discoverExtension(path));
    }
  }

  async doctor(campaign: Campaign): Promise<Array<{ capability: string; ok: boolean; message: string }>> {
    assertRuntimeCampaign(campaign);
    const capabilities = [...campaign.requires, `workflow:${campaign.workflow}`];
    const checks = this.extensions.explain(capabilities).map((item) => ({
      capability: item.capability,
      ok: Boolean(item.extension),
      message: item.extension ? `provided by ${item.extension}` : "no provider installed"
    }));
    try {
      const project = await stat(campaign.projectRoot);
      checks.unshift({ capability: "project:root", ok: project.isDirectory(), message: project.isDirectory() ? campaign.projectRoot : "projectRoot is not a directory" });
    } catch (error) {
      checks.unshift({ capability: "project:root", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    for (const check of checks.filter((item) => item.ok)) {
      if (check.capability === "project:root") continue;
      try {
        await this.extensions.activateFor(check.capability);
      } catch (error) {
        check.ok = false;
        check.message = error instanceof Error ? error.message : String(error);
      }
    }
    for (const engine of this.registry.getAll<EngineDriver>("engine")) {
      const result = await engine.doctor({ campaign, projectRoot: campaign.projectRoot, signal: this.options.signal ?? new AbortController().signal });
      for (const item of result.checks) checks.push({ capability: `engine:${engine.id}/${item.name}`, ok: item.ok, message: item.message });
    }
    return checks;
  }

  async run(campaign: Campaign): Promise<CampaignResult> {
    assertRuntimeCampaign(campaign);
    const controller = new AbortController();
    const external = this.options.signal;
    const abort = () => controller.abort(external?.reason);
    if (external?.aborted) abort();
    external?.addEventListener("abort", abort, { once: true });
    const wallTimeMs = campaign.budget?.wallTimeMinutes !== undefined ? campaign.budget.wallTimeMinutes * 60_000 : undefined;
    const deadline = wallTimeMs !== undefined
      ? setTimeout(() => controller.abort(new Error("wall-time budget reached")), wallTimeMs)
      : undefined;

    const startedAt = new Date().toISOString();
    const resultPath = outputPath(this.options.cwd, this.options.config.resultLog, `.factory/results/${campaign.id}.jsonl`, "resultLog");
    const store = new JsonlResultStore(resultPath);
    const configFingerprint = createHash("sha256").update(JSON.stringify(this.options.config)).digest("hex");
    const { budget: _operationalBudget, ...campaignBehavior } = campaign;
    const campaignFingerprint = createHash("sha256").update(JSON.stringify(campaignBehavior)).digest("hex");
    const runFingerprint = createHash("sha256").update(`${campaignFingerprint}:${configFingerprint}`).digest("hex");
    const runId = `${campaign.id}-${runFingerprint.slice(0, 16)}`;
    const journal = new WorkflowJournal(outputPath(this.options.cwd, this.options.config.journalLog, `.factory/journal/${campaign.id}.jsonl`, "journalLog"));
    const traceStore = new JsonlTraceStore(outputPath(this.options.cwd, this.options.config.traceLog, `.factory/traces/${campaign.id}.jsonl`, "traceLog"));
    let traceWarningReported = false;
    const trace: TraceSink = {
      runId,
      campaignId: campaign.id,
      emit: async (event) => {
        try {
          await traceStore.append({ runId, campaignId: campaign.id }, event);
        } catch (error) {
          if (!traceWarningReported) {
            traceWarningReported = true;
            this.options.logger.warn("Execution trace is unavailable; the factory run will continue", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    };
    const rootNodeId = `campaign:${runId}`;
    const tracedExtensions = new Map<string, string>();
    const emitExtensionProvenance = async (triggerCapability: string): Promise<void> => {
      for (const extension of this.extensions.listActiveExtensions()) {
        const signature = JSON.stringify(extension.capabilities);
        const nodeId = `extension:${extension.name}`;
        const data = {
          provenanceType: "extension",
          version: extension.version,
          capabilities: extension.capabilities,
          activation: extension.activation,
          activationReason: triggerCapability,
          permissions: extension.permissions,
          manifestSha256: extension.manifestSha256,
          configSha256: configFingerprint
        };
        if (!tracedExtensions.has(extension.name)) {
          await trace.emit({ type: "node:created", nodeId, parentNodeId: rootNodeId, label: extension.name, role: "extension", message: extension.description ?? `Provides ${extension.capabilities.join(", ")}`, data });
          await trace.emit({ type: "edge:created", nodeId: `edge:${rootNodeId}->${nodeId}`, sourceNodeId: rootNodeId, targetNodeId: nodeId, role: "dependency", message: `activated for ${triggerCapability}` });
          await trace.emit({ type: "node:completed", nodeId, label: extension.name, role: "extension", status: "complete", message: extension.description ?? `Activated for ${extension.capabilities.join(", ")}`, data });
        } else if (tracedExtensions.get(extension.name) !== signature) {
          await trace.emit({ type: "node:progress", nodeId, label: extension.name, role: "extension", status: "complete", message: `Also used for ${triggerCapability}`, data });
        }
        tracedExtensions.set(extension.name, signature);
      }
    };
    const artifactStore = new ContentAddressedArtifactStore(
      outputPath(this.options.cwd, this.options.config.artifactDirectory, ".factory/artifacts", "artifactDirectory"),
      this.options.logger
    );

    let releaseLease: (() => Promise<void>) | undefined;
    try {
      releaseLease = await acquireRunLease(`${journal.path}.lock`, runId);
      const projectRevision = await gitProjectRevision(campaign.projectRoot);
      const recovery = await journal.recover();
      const previousEntries = recovery.entries.filter((entry) => entry.runId === runId && entry.campaignId === campaign.id);
      const previousProjectRevision = previousEntries[0]?.fingerprints.project;
      const latestAppliedRevision = previousEntries.reduce<string | undefined>((latest, entry) => {
        if (entry.phase !== "applied" || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return latest;
        const record = entry.data.record;
        if (!record || typeof record !== "object" || Array.isArray(record)) return latest;
        return record.status === "keep" && typeof record.revision === "string" ? record.revision : latest;
      }, undefined);
      if (previousEntries.length > 0 && !previousProjectRevision) {
        throw new Error("Existing journal lacks a project revision fingerprint; migrate or archive it before safe resume.");
      }
      const currentProjectFingerprint = projectRevision ?? `unversioned:${resolve(campaign.projectRoot)}`;
      const gitScopedResume = Boolean(previousProjectRevision && /^[0-9a-f]{40}$/i.test(previousProjectRevision));
      const expectedProjectRevision = gitScopedResume ? latestAppliedRevision ?? previousProjectRevision : previousProjectRevision;
      if (expectedProjectRevision && currentProjectFingerprint !== expectedProjectRevision) {
        throw new Error(`Project revision changed outside the recorded campaign: expected ${expectedProjectRevision}, found ${currentProjectFingerprint}.`);
      }
      const fingerprints = {
        campaign: campaignFingerprint,
        config: configFingerprint,
        project: previousProjectRevision ?? currentProjectFingerprint
      };
      const legacyRecords = (await store.read(campaign.id)).filter((record) => record.runId === undefined);
      if (legacyRecords.length > 0) {
        throw new Error(`Result log contains ${legacyRecords.length} legacy unscoped record(s) for ${campaign.id}; migrate or archive that log before this safe resume.`);
      }
      await trace.emit({ type: "node:created", nodeId: rootNodeId, label: campaign.id, role: "campaign", message: campaign.objective, data: { configSha256: configFingerprint, campaignSha256: campaignFingerprint, projectRevision: currentProjectFingerprint } });
      await trace.emit({ type: "node:started", nodeId: rootNodeId, label: campaign.id, role: "campaign" });
      for (const capability of campaign.requires) {
        await this.extensions.activateFor(capability);
        await emitExtensionProvenance(capability);
      }
      for (const capability of campaign.optional ?? []) {
        if (this.extensions.explain([capability])[0]?.extension) {
          await this.extensions.activateFor(capability);
          await emitExtensionProvenance(capability);
        }
      }
      const workflowCapability = `workflow:${campaign.workflow}`;
      await this.extensions.activateFor(workflowCapability);
      await emitExtensionProvenance(workflowCapability);
      const workflow = this.registry.get<Workflow>("workflow", campaign.workflow);
      await this.extensions.emit({ type: "campaign:start", campaign, at: startedAt });

      let result: CampaignResult;
      try {
        result = await workflow.run({
        campaign,
        signal: controller.signal,
        startedAt,
        get: <T>(kind: Parameters<CapabilityRegistry["get"]>[0], id: string) => this.registry.get<T>(kind, id),
        getAll: <T>(kind: Parameters<CapabilityRegistry["getAll"]>[0]) => this.registry.getAll<T>(kind),
        appendRecord: (record) => store.append({ ...record, runId }),
        readRecords: async () => (await store.read(campaign.id)).filter((record) => record.runId === runId),
        preserveArtifacts: (artifacts, namespace) => artifactStore.preserve(artifacts, `${campaign.id}/${namespace}`),
        journal: {
          runId,
          fingerprints,
          append: (input) => journal.append({
            ...input,
            runId,
            campaignId: campaign.id,
            fingerprints,
            ...(input.data === undefined ? {} : { data: input.data as JournalJsonValue })
          }),
          appendRecovered: (input) => journal.append(input),
          recover: () => journal.recover()
        },
        trace,
        emit: (event) => this.extensions.emit(event),
        budget: new BudgetController(campaign.budget),
        logger: this.options.logger
        });
      } catch (error) {
        await trace.emit({ type: "node:failed", nodeId: rootNodeId, label: campaign.id, role: "campaign", status: "failed", message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      await trace.emit({ type: "node:completed", nodeId: rootNodeId, label: campaign.id, role: "campaign", status: result.status, message: result.summary });
      await this.extensions.emit({ type: "campaign:finish", result, at: new Date().toISOString() });
      return result;
    } finally {
      await releaseLease?.();
      if (deadline) clearTimeout(deadline);
      external?.removeEventListener("abort", abort);
    }
  }

  async dispose(): Promise<void> {
    await this.extensions.dispose();
  }
}
