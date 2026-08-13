import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FactoryRunner,
  LocalCredentialStore,
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
  resolveViewerArtifact,
  type FactoryTrace,
  type FactoryViewerOptions,
  type FactoryViewerSnapshot,
} from "@gamefactory/viewer";
import type { DesktopArtifactText, DesktopSelection, DesktopState } from "./contracts";

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

async function codexLauncher(): Promise<string> {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const root = resolve(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      const candidates = await Promise.all((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => {
        const path = resolve(root, entry.name, "codex.exe");
        try { const info = await lstat(path); return info.isFile() ? { path, modified: info.mtimeMs } : undefined; } catch { return undefined; }
      }));
      const newest = candidates.filter((item): item is { path: string; modified: number } => item !== undefined).sort((left, right) => right.modified - left.modified)[0];
      if (newest) return newest.path;
    } catch { /* Fall through to a standalone CLI on PATH. */ }
  }
  return "codex";
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
  private trace?: FactoryTrace;
  private signature?: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshPromise?: Promise<void>;
  private lastHeartbeatAt = 0;
  private runner?: FactoryRunner;
  private runController?: AbortController;
  private runPromise?: Promise<void>;
  private readonly credentialStore = new LocalCredentialStore();

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
    this.setState({ ...this.state, status: "watching", running: false, message: `Watching ${campaign.id}`, selection: this.selection });
    await this.refresh(true);
    this.startWatching();
    await this.refreshReadiness();
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
      this.trace = trace;
      this.signature = nextSignature;
      this.snapshot = createFactorySnapshot(trace, this.campaign!);
      this.onSnapshot(structuredClone(this.snapshot));
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, message: `Trace refresh delayed: ${message}` });
    }).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async refreshReadiness(): Promise<DesktopState> {
    if (!this.campaign || !this.config || !this.options) throw new Error("Choose a campaign before checking readiness");
    this.setState({ ...this.state, readiness: { status: "checking", checks: this.state.readiness?.checks ?? [] } });
    const checks: Array<{ capability: string; ok: boolean; message: string }> = [];
    const runner = new FactoryRunner({ cwd: this.options.cwd, config: this.config, logger: new SessionLogger(() => undefined) });
    try {
      await runner.initialize();
      checks.push(...await runner.doctor(this.campaign));
    } catch (error) {
      checks.push({ capability: "factory:doctor", ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await runner.dispose().catch(() => undefined);
    }
    try {
      const { stdout } = await execFileAsync(await codexLauncher(), ["--version"], { windowsHide: true, timeout: 15_000 });
      checks.push({ capability: "agent:codex-app-server", ok: true, message: stdout.trim() || "Codex is available" });
    } catch (error) {
      checks.push({ capability: "agent:codex-app-server", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    const credentials = await this.credentialStore.list();
    this.setState({ ...this.state, credentials, readiness: { status: checks.every((item) => item.ok) ? "ready" : "issues", checkedAt: new Date().toISOString(), checks } });
    return this.getState();
  }

  async setCredential(name: string, value: string): Promise<DesktopState> {
    await this.credentialStore.set(name, value);
    const credentials = await this.credentialStore.list();
    this.setState({ ...this.state, credentials, message: `Stored ${name} in the OS-protected credential store` });
    return this.getState();
  }

  async removeCredential(name: string): Promise<DesktopState> {
    await this.credentialStore.remove(name);
    const credentials = await this.credentialStore.list();
    this.setState({ ...this.state, credentials, message: `Removed ${name} from the credential store` });
    return this.getState();
  }

  async resolveArtifact(id: string) {
    if (!this.trace) await this.refresh(true);
    const artifact = this.trace ? await resolveViewerArtifact(this.trace, id) : undefined;
    if (!artifact) throw new Error("Artifact is unavailable or outside the content-addressed evidence store");
    return artifact;
  }

  async getArtifactText(id: string): Promise<DesktopArtifactText> {
    const artifact = await this.resolveArtifact(id);
    const textual = artifact.mediaType.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(artifact.mediaType);
    if (!textual) throw new Error(`Artifact ${artifact.label} is not textual evidence`);
    if (artifact.sizeBytes > 2 * 1024 * 1024) throw new Error("Text artifact exceeds the 2 MiB inspection limit");
    return { id, label: artifact.label, mediaType: artifact.mediaType, text: await readFile(artifact.path, "utf8") };
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
    this.setState({ ...this.state, status: "running", running: true, message: `Starting ${this.campaign.id}`, selection: this.selection, startedAt });
    this.runPromise = (async () => {
      try {
        await this.runner!.initialize();
        const result = await this.runner!.run(this.campaign!);
        this.setState({ ...this.state, status: "complete", running: false, message: `Run ${result.status}`, selection: this.selection, startedAt, finishedAt: new Date().toISOString() });
      } catch (error) {
        if (this.runController?.signal.aborted) {
          this.setState({ ...this.state, status: "watching", running: false, message: "Run stopped", selection: this.selection, startedAt, finishedAt: new Date().toISOString() });
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
    this.setState({ ...this.state, status: "error", running: false, message: `${prefix}: ${message}`, ...(this.selection ? { selection: this.selection } : {}), error: message, finishedAt: new Date().toISOString() });
  }

  private setState(state: DesktopState): void {
    this.state = structuredClone(state);
    this.onState(this.getState());
  }
}
