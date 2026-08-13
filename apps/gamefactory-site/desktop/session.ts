import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FactoryRunner,
  loadCampaign,
  loadFactoryConfig,
  type Campaign,
  type FactoryConfig,
  type Logger,
} from "@gamefactory/core";
import {
  createFactorySnapshot,
  factoryTraceSignature,
  readFactoryTrace,
  type FactoryViewerOptions,
  type FactoryViewerSnapshot,
} from "@gamefactory/viewer";
import type { DesktopSelection, DesktopState } from "./contracts";

const execFileAsync = promisify(execFile);

async function existing(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitRoot(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"], { windowsHide: true });
    return resolve(stdout.trim());
  } catch {
    return undefined;
  }
}

export async function inferFactoryRoot(campaignPath: string): Promise<string> {
  return await gitRoot(dirname(campaignPath)) ?? dirname(campaignPath);
}

export async function inferConfigPath(campaignPath: string): Promise<string> {
  const candidate = join(dirname(campaignPath), "factory.config.json");
  if (!(await existing(candidate))) throw new Error(`No factory.config.json beside ${campaignPath}`);
  return candidate;
}

class SessionLogger implements Logger {
  constructor(private readonly write: (level: string, message: string, details?: Record<string, unknown>) => void) {}
  debug(message: string, details?: Record<string, unknown>): void { this.write("debug", message, details); }
  info(message: string, details?: Record<string, unknown>): void { this.write("info", message, details); }
  warn(message: string, details?: Record<string, unknown>): void { this.write("warn", message, details); }
  error(message: string, details?: Record<string, unknown>): void { this.write("error", message, details); }
}

export interface OpenDesktopCampaignOptions {
  campaignPath: string;
  configPath?: string;
  factoryRoot?: string;
}

export class DesktopFactorySession {
  private campaign?: Campaign;
  private config?: FactoryConfig;
  private options?: FactoryViewerOptions;
  private selection?: DesktopSelection;
  private state: DesktopState = { status: "idle", running: false, message: "Choose a campaign to begin" };
  private snapshot?: FactoryViewerSnapshot;
  private signature?: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshPromise?: Promise<void>;
  private lastHeartbeatAt = 0;
  private runner?: FactoryRunner;
  private runController?: AbortController;
  private runPromise?: Promise<void>;

  constructor(
    private readonly onState: (state: DesktopState) => void = () => undefined,
    private readonly onSnapshot: (snapshot: FactoryViewerSnapshot) => void = () => undefined,
    private readonly pollIntervalMs = 350,
  ) {}

  getState(): DesktopState { return structuredClone(this.state); }
  getSnapshot(): FactoryViewerSnapshot | undefined { return this.snapshot ? structuredClone(this.snapshot) : undefined; }

  async open(value: OpenDesktopCampaignOptions): Promise<DesktopState> {
    if (this.state.running) throw new Error("Stop the active factory run before changing campaigns");
    const campaignPath = resolve(value.campaignPath);
    const configPath = resolve(value.configPath ?? await inferConfigPath(campaignPath));
    const factoryRoot = resolve(value.factoryRoot ?? await inferFactoryRoot(campaignPath));
    const [campaign, config] = await Promise.all([loadCampaign(campaignPath), loadFactoryConfig(configPath)]);
    this.campaign = campaign;
    this.config = config;
    this.options = { cwd: factoryRoot, campaign, config, pollIntervalMs: this.pollIntervalMs };
    this.selection = {
      campaignPath,
      configPath,
      factoryRoot,
      projectRoot: campaign.projectRoot,
      campaignId: campaign.id,
      objective: campaign.objective,
    };
    this.signature = undefined;
    this.setState({ status: "watching", running: false, message: `Watching ${campaign.id}`, selection: this.selection });
    await this.refresh(true);
    this.startWatching();
    return this.getState();
  }

  async refresh(force = false): Promise<void> {
    if (!this.options || !this.campaign) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const nextSignature = await factoryTraceSignature(this.options!);
      const now = Date.now();
      const heartbeat = this.state.running && now - this.lastHeartbeatAt >= 1_000;
      if (!force && !heartbeat && nextSignature === this.signature) return;
      if (heartbeat) this.lastHeartbeatAt = now;
      const trace = await readFactoryTrace(this.options!);
      this.signature = nextSignature;
      this.snapshot = createFactorySnapshot(trace, this.campaign!);
      this.onSnapshot(structuredClone(this.snapshot));
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, message: `Trace refresh delayed: ${message}` });
    }).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  startWatching(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { void this.refresh(); }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async startRun(): Promise<DesktopState> {
    if (!this.campaign || !this.config || !this.options || !this.selection) throw new Error("Choose a campaign before starting a run");
    if (this.runPromise) return this.getState();
    this.runController = new AbortController();
    const startedAt = new Date().toISOString();
    const logger = new SessionLogger((level, message, details) => {
      const suffix = details && Object.keys(details).length ? ` · ${JSON.stringify(details).slice(0, 500)}` : "";
      this.setState({ ...this.state, message: `[${level}] ${message}${suffix}` });
    });
    this.runner = new FactoryRunner({ cwd: this.options.cwd, config: this.config, logger, signal: this.runController.signal });
    this.setState({ status: "running", running: true, message: `Starting ${this.campaign.id}`, selection: this.selection, startedAt });
    this.runPromise = (async () => {
      try {
        await this.runner!.initialize();
        const result = await this.runner!.run(this.campaign!);
        this.setState({ status: "complete", running: false, message: `Run ${result.status}`, selection: this.selection, startedAt, finishedAt: new Date().toISOString() });
      } catch (error) {
        if (this.runController?.signal.aborted) {
          this.setState({ status: "watching", running: false, message: "Run stopped", selection: this.selection, startedAt, finishedAt: new Date().toISOString() });
        } else {
          this.setError(error, "Factory run failed");
        }
      } finally {
        try { await this.runner?.dispose(); } catch (error) { this.setError(error, "Factory cleanup failed"); }
        this.runner = undefined;
        this.runController = undefined;
        this.runPromise = undefined;
        await this.refresh(true);
      }
    })();
    void this.runPromise;
    return this.getState();
  }

  async stopRun(): Promise<DesktopState> {
    if (!this.runPromise || !this.runController) return this.getState();
    this.setState({ ...this.state, status: "stopping", running: true, message: "Stopping after the current safe boundary" });
    this.runController.abort(new Error("Stopped from Observatory"));
    await this.runPromise;
    return this.getState();
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.runPromise && this.runController) {
      this.runController.abort(new Error("Observatory is closing"));
      await this.runPromise;
    }
  }

  private setError(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setState({ status: "error", running: false, message: `${prefix}: ${message}`, ...(this.selection ? { selection: this.selection } : {}), error: message, finishedAt: new Date().toISOString() });
  }

  private setState(state: DesktopState): void {
    this.state = structuredClone(state);
    this.onState(this.getState());
  }
}
