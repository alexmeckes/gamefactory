import { resolve } from "node:path";
import type { Campaign, CampaignResult, EngineDriver, FactoryConfig, Logger, Workflow } from "./types.js";
import { BudgetController } from "./budget.js";
import { CapabilityRegistry } from "./registry.js";
import { discoverExtension, ExtensionManager } from "./extension-manager.js";
import { JsonlResultStore } from "./results.js";
import { ContentAddressedArtifactStore } from "./artifacts.js";

export interface RunnerOptions {
  cwd: string;
  config: FactoryConfig;
  logger: Logger;
  signal?: AbortSignal;
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
    const capabilities = [...campaign.requires, `workflow:${campaign.workflow}`];
    const checks = this.extensions.explain(capabilities).map((item) => ({
      capability: item.capability,
      ok: Boolean(item.extension),
      message: item.extension ? `provided by ${item.extension}` : "no provider installed"
    }));
    for (const check of checks.filter((item) => item.ok)) {
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
    const resultPath = resolve(
      this.options.cwd,
      this.options.config.resultLog ?? `.factory/results/${campaign.id}.jsonl`
    );
    const store = new JsonlResultStore(resultPath);
    const artifactStore = new ContentAddressedArtifactStore(
      resolve(this.options.cwd, this.options.config.artifactDirectory ?? ".factory/artifacts"),
      this.options.logger
    );

    try {
      for (const capability of campaign.requires) await this.extensions.activateFor(capability);
      await this.extensions.activateFor(`workflow:${campaign.workflow}`);
      const workflow = this.registry.get<Workflow>("workflow", campaign.workflow);
      await this.extensions.emit({ type: "campaign:start", campaign, at: startedAt });

      const result = await workflow.run({
        campaign,
        signal: controller.signal,
        startedAt,
        get: <T>(kind: Parameters<CapabilityRegistry["get"]>[0], id: string) => this.registry.get<T>(kind, id),
        getAll: <T>(kind: Parameters<CapabilityRegistry["getAll"]>[0]) => this.registry.getAll<T>(kind),
        appendRecord: (record) => store.append(record),
        readRecords: () => store.read(campaign.id),
        preserveArtifacts: (artifacts, namespace) => artifactStore.preserve(artifacts, `${campaign.id}/${namespace}`),
        emit: (event) => this.extensions.emit(event),
        budget: new BudgetController(campaign.budget),
        logger: this.options.logger
      });
      await this.extensions.emit({ type: "campaign:finish", result, at: new Date().toISOString() });
      return result;
    } finally {
      if (deadline) clearTimeout(deadline);
      external?.removeEventListener("abort", abort);
    }
  }

  async dispose(): Promise<void> {
    await this.extensions.dispose();
  }
}
