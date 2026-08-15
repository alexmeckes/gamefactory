import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { InvocationUsage } from "@gamefactory/core";

type JsonObject = Record<string, unknown>;

export interface CodexAppServerEvent {
  method: string;
  params: JsonObject;
}

export interface CodexAppServerRunRequest {
  launcher: string[];
  cwd: string;
  prompt: string;
  readOnly: boolean;
  model?: string;
  reasoningEffort?: string;
  retention?: CodexThreadRetention;
  signal: AbortSignal;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  onEvent?(event: CodexAppServerEvent): void;
}

export type CodexThreadRetention = "ephemeral" | "archive" | "debug";

export interface CodexThreadLifecycle {
  retention: CodexThreadRetention;
  ephemeral: boolean;
  unsubscribed: boolean;
  archived: boolean;
  processId?: number;
  loadedThreadCount?: number;
  cleanupError?: string;
}

export interface CodexAppServerRunResult {
  output: string;
  eventLog: string;
  usage?: InvocationUsage;
  threadId: string;
  turnId: string;
  instructionSources: string[];
  modelProvider?: string;
  requestedModel?: string;
  actualModel?: string;
  requestedReasoningEffort?: string;
  reasoningEffort?: string;
  lifecycle: CodexThreadLifecycle;
}

interface RootThread {
  threadId: string;
  instructionSources: string[];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface TurnListener {
  threadId: string;
  turnId?: string;
  output: string;
  events: string[];
  usage?: InvocationUsage;
  actualModel?: string;
  actualReasoningEffort?: string;
  onEvent?: CodexAppServerRunRequest["onEvent"];
  resolve(result: { status: string; error?: string }): void;
  reject(error: Error): void;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFrom(params: JsonObject): InvocationUsage | undefined {
  const usage = object(params.tokenUsage) ?? object(params.usage) ?? params;
  const total = object(usage.total) ?? object(usage.totalUsage) ?? usage;
  const inputTokens = number(total.inputTokens ?? total.input_tokens);
  const cachedInputTokens = number(total.cachedInputTokens ?? total.cached_input_tokens);
  const outputTokens = number(total.outputTokens ?? total.output_tokens);
  const reasoningTokens = number(total.reasoningTokens ?? total.reasoning_tokens ?? total.reasoningOutputTokens);
  const totalTokens = number(total.totalTokens ?? total.total_tokens) ?? (
    inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0)
  );
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens].every((value) => value === undefined)) return undefined;
  return {
    provider: "openai-codex-app-server",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    billingMode: "subscription",
    identitySource: "provider-reported"
  };
}

function eventThreadId(params: JsonObject): string | undefined {
  return string(params.threadId) ?? string(object(params.thread)?.id);
}

function eventTurnId(params: JsonObject): string | undefined {
  return string(params.turnId) ?? string(object(params.turn)?.id);
}

function eventError(params: JsonObject): string | undefined {
  const error = object(params.error) ?? object(object(params.turn)?.error);
  return string(error?.message);
}

function safeEventLine(method: string, params: JsonObject): string {
  const item = object(params.item);
  const summary = {
    method,
    ...(eventThreadId(params) ? { threadId: eventThreadId(params) } : {}),
    ...(eventTurnId(params) ? { turnId: eventTurnId(params) } : {}),
    ...(string(item?.type) ? { itemType: string(item?.type) } : {}),
    ...(string(item?.status) ? { status: string(item?.status) } : {}),
    ...(string(object(params.turn)?.status) ? { turnStatus: string(object(params.turn)?.status) } : {})
  };
  return JSON.stringify(summary);
}

function isHighFrequencyDelta(method: string): boolean {
  return /delta$/i.test(method);
}

function expandStructuredEnvelope(output: string): string {
  let envelope: JsonObject;
  try {
    envelope = JSON.parse(output) as JsonObject;
  } catch {
    return output;
  }
  if (typeof envelope.payload !== "string") return output;
  let payload: JsonObject;
  try {
    const parsed = JSON.parse(envelope.payload) as unknown;
    payload = object(parsed) ?? {};
  } catch (error) {
    throw new Error(`Codex App Server returned an invalid structured payload: ${error instanceof Error ? error.message : String(error)}`);
  }
  return JSON.stringify({ ...payload, summary: envelope.summary, outcome: envelope.outcome });
}

class CodexAppServerConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, TurnListener>();
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private stderr = "";
  private readonly ephemeralRoots = new Map<string, Promise<RootThread>>();

  constructor(
    private readonly launcher: string[],
    private readonly environment?: NodeJS.ProcessEnv
  ) {}

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const [executable, ...args] = this.launcher;
    if (!executable) throw new Error("Codex App Server launcher is empty");
    const child = spawn(executable, args, {
      windowsHide: true,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-1_000_000);
    });
    child.once("error", (error) => this.failAll(new Error(`Unable to start Codex App Server: ${error.message}`, { cause: error })));
    child.once("close", (code) => this.failAll(new Error(`Codex App Server exited with code ${String(code)}.${this.stderr.trim() ? ` ${this.stderr.trim().slice(-2000)}` : ""}`)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    await this.request("initialize", {
      clientInfo: { name: "gamefactory", title: "GameFactory", version: "0.1.0" }
    }, 30_000);
    this.notify("initialized", {});
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.stderr = `${this.stderr}\nInvalid App Server JSON: ${line}`.slice(-1_000_000);
      return;
    }
    const id = number(message.id);
    const method = string(message.method);
    if (id !== undefined && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = object(message.error);
      if (error) pending.reject(new Error(string(error.message) ?? `Codex App Server request ${id} failed`));
      else pending.resolve(message.result);
      return;
    }
    if (!method) return;
    const params = object(message.params) ?? {};
    if (id !== undefined) {
      const decision = method.includes("requestApproval") ? { decision: "decline" } : {};
      this.write({ id, result: decision });
      return;
    }
    this.notification(method, params);
  }

  private notification(method: string, params: JsonObject): void {
    const threadId = eventThreadId(params);
    const turnId = eventTurnId(params);
    const listener = threadId ? this.listeners.get(threadId) : [...this.listeners.values()].find((candidate) => candidate.turnId === turnId);
    if (!listener) return;
    // Token, reasoning, and command-output deltas can arrive thousands of
    // times per turn. Lifecycle events retain the live graph without turning
    // the durable trace and evidence log into a transcript-sized firehose.
    if (!isHighFrequencyDelta(method)) {
      listener.events.push(safeEventLine(method, params));
      listener.onEvent?.({ method, params });
    }
    if (method === "turn/started" && turnId) listener.turnId = turnId;
    if (method === "item/completed") {
      const item = object(params.item);
      if (string(item?.type) === "agentMessage" && string(item?.text)) listener.output = string(item?.text)!;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = usageFrom(params);
      if (usage) listener.usage = usage;
    }
    if (method === "model/rerouted") {
      const actualModel = string(params.toModel);
      if (actualModel) listener.actualModel = actualModel;
    }
    if (method === "thread/settings/updated") {
      const settings = object(params.threadSettings);
      const actualModel = string(settings?.model);
      const actualReasoningEffort = string(settings?.effort);
      if (actualModel) listener.actualModel = actualModel;
      if (actualReasoningEffort) listener.actualReasoningEffort = actualReasoningEffort;
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      const error = eventError(params);
      listener.resolve({ status: string(turn?.status) ?? "failed", ...(error ? { error } : {}) });
    }
  }

  private write(message: JsonObject): void {
    if (!this.child || this.child.exitCode !== null) throw new Error("Codex App Server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  private request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async candidateKey(cwd: string): Promise<string> {
    const canonical = await realpath(resolve(cwd)).catch(() => resolve(cwd));
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  }

  private instructionSources(result: JsonObject): string[] {
    return Array.isArray(result.instructionSources)
      ? result.instructionSources.filter((value): value is string => typeof value === "string")
      : [];
  }

  private async ephemeralRoot(cwd: string): Promise<RootThread> {
    const key = await this.candidateKey(cwd);
    let root = this.ephemeralRoots.get(key);
    if (!root) {
      root = (async () => {
        const result = object(await this.request("thread/start", {
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "gamefactory"
        })) ?? {};
        const threadId = string(object(result.thread)?.id);
        if (!threadId) throw new Error("Codex App Server ephemeral root did not return a thread id");
        return { threadId, instructionSources: this.instructionSources(result) };
      })();
      this.ephemeralRoots.set(key, root);
      root.catch(() => this.ephemeralRoots.delete(key));
    }
    return root;
  }

  private async createRunThread(request: CodexAppServerRunRequest, retention: CodexThreadRetention): Promise<{
    result: JsonObject;
    thread: JsonObject;
    threadId: string;
    instructionSources: string[];
    ephemeral: boolean;
  }> {
    if (retention === "ephemeral") {
      const root = await this.ephemeralRoot(request.cwd);
      const result = object(await this.request("thread/fork", { threadId: root.threadId, ephemeral: true })) ?? {};
      const thread = object(result.thread) ?? {};
      const threadId = string(thread.id);
      if (!threadId) throw new Error("Codex App Server ephemeral thread/fork did not return a thread id");
      const sources = this.instructionSources(result);
      return { result, thread, threadId, instructionSources: sources.length ? sources : root.instructionSources, ephemeral: true };
    }
    const result = object(await this.request("thread/start", {
      cwd: request.cwd,
      approvalPolicy: "never",
      sandbox: request.readOnly ? "read-only" : "workspace-write",
      serviceName: "gamefactory",
      ...(request.model ? { model: request.model } : {})
    })) ?? {};
    const thread = object(result.thread) ?? {};
    const threadId = string(thread.id);
    if (!threadId) throw new Error("Codex App Server thread/start did not return a thread id");
    return { result, thread, threadId, instructionSources: this.instructionSources(result), ephemeral: false };
  }

  async run(request: CodexAppServerRunRequest): Promise<CodexAppServerRunResult> {
    await this.start();
    const retention = request.retention ?? "ephemeral";
    const created = await this.createRunThread(request, retention);
    const { result: threadResult, thread, threadId, instructionSources } = created;
    const lifecycle: CodexThreadLifecycle = {
      retention,
      ephemeral: created.ephemeral,
      unsubscribed: false,
      archived: false,
      ...(this.child?.pid ? { processId: this.child.pid } : {})
    };
    // App Server v2 reports the resolved default at the response top level,
    // even when the caller deliberately leaves `model` unset. Keep this value
    // so inherited subscription defaults remain attributable in the trace.
    const resolvedModel = string(threadResult.model) ?? request.model;
    const initialReasoningEffort = string(threadResult.reasoningEffort);
    let resolveTurn!: TurnListener["resolve"];
    let rejectTurn!: TurnListener["reject"];
    const completion = new Promise<{ status: string; error?: string }>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const listener: TurnListener = { threadId, output: "", events: [], onEvent: request.onEvent, resolve: resolveTurn, reject: rejectTurn };
    this.listeners.set(threadId, listener);
    request.onEvent?.({
      method: "gamefactory/thread/started",
      params: {
        threadId,
        retention,
        ephemeral: created.ephemeral,
        activeTurnCount: this.listeners.size,
        ...(this.child?.pid ? { processId: this.child.pid } : {})
      }
    });
    const outputSchema = {
      type: "object",
      properties: {
        summary: { type: "string", description: "A concise human-readable result summary." },
        outcome: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: "A short machine-readable outcome identifier without spaces." },
        payload: { type: "string", description: "A JSON-encoded object containing any free-form findings, context, artifacts, or other structured handoff fields." }
      },
      required: ["summary", "outcome", "payload"],
      additionalProperties: false
    };
    let turnId: string | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const turnResult = object(await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt }],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: request.readOnly
          ? { type: "readOnly", access: { type: "fullAccess" } }
          : { type: "workspaceWrite", writableRoots: [request.cwd], networkAccess: false },
        outputSchema,
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {})
      })) ?? {};
      turnId = string(object(turnResult.turn)?.id);
      if (!turnId) throw new Error("Codex App Server turn/start did not return a turn id");
      listener.turnId = turnId;
      const bounded = new Promise<{ status: string; error?: string }>((resolve, reject) => {
        timeout = setTimeout(() => {
          void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          reject(new Error(`Codex App Server turn timed out after ${request.timeoutMs ?? 15 * 60_000}ms`));
        }, request.timeoutMs ?? 15 * 60_000);
        timeout.unref();
        abort = () => {
          void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          reject(new Error("Codex App Server turn was cancelled"));
        };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        completion.then(resolve, reject);
      });
      const completed = await bounded;
      if (completed.status !== "completed") throw new Error(completed.error ?? `Codex App Server turn ended ${completed.status}`);
      if (!listener.output.trim()) throw new Error("Codex App Server completed without a final agent message");
      const modelProvider = string(threadResult.modelProvider) ?? string(thread.modelProvider);
      const actualModel = listener.actualModel ?? resolvedModel;
      const actualReasoningEffort = listener.actualReasoningEffort ?? request.reasoningEffort ?? initialReasoningEffort;
      return {
        output: expandStructuredEnvelope(listener.output),
        eventLog: `${listener.events.join("\n")}\n`,
        ...(listener.usage ? { usage: { ...listener.usage, ...(actualModel ? { model: actualModel } : {}), ...(actualReasoningEffort ? { reasoningEffort: actualReasoningEffort } : {}) } } : {}),
        threadId,
        turnId,
        instructionSources,
        ...(modelProvider ? { modelProvider } : {}),
        ...(request.model ? { requestedModel: request.model } : {}),
        ...(actualModel ? { actualModel } : {}),
        ...(request.reasoningEffort ? { requestedReasoningEffort: request.reasoningEffort } : {}),
        ...(actualReasoningEffort ? { reasoningEffort: actualReasoningEffort } : {}),
        lifecycle
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) request.signal.removeEventListener("abort", abort);
      this.listeners.delete(threadId);
      try {
        const response = object(await this.request("thread/unsubscribe", { threadId })) ?? {};
        lifecycle.unsubscribed = string(response.status) !== "notLoaded";
        request.onEvent?.({ method: "gamefactory/thread/unsubscribed", params: { threadId, retention, ephemeral: created.ephemeral } });
        if (retention === "archive" && !created.ephemeral) {
          await this.request("thread/archive", { threadId });
          lifecycle.archived = true;
          request.onEvent?.({ method: "gamefactory/thread/archived", params: { threadId, retention } });
        }
        const loaded = object(await this.request("thread/loaded/list", {})) ?? {};
        const loadedThreads = Array.isArray(loaded.data) ? loaded.data.filter((value) => typeof value === "string") : [];
        lifecycle.loadedThreadCount = loadedThreads.length;
        request.onEvent?.({
          method: "gamefactory/thread/status",
          params: {
            threadId,
            retention,
            ephemeral: created.ephemeral,
            activeTurnCount: this.listeners.size,
            loadedThreadCount: loadedThreads.length,
            ...(this.child?.pid ? { processId: this.child.pid } : {})
          }
        });
      } catch (error) {
        lifecycle.cleanupError = error instanceof Error ? error.message : String(error);
        request.onEvent?.({ method: "gamefactory/thread/cleanup-failed", params: { threadId, retention, error: lifecycle.cleanupError } });
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.listeners.values()) listener.reject(error);
    this.listeners.clear();
    this.ephemeralRoots.clear();
    this.startPromise = undefined;
    this.child = undefined;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      this.startPromise = undefined;
      this.ephemeralRoots.clear();
      return;
    }
    const roots = await Promise.allSettled([...this.ephemeralRoots.values()]);
    this.ephemeralRoots.clear();
    for (const root of roots) {
      if (root.status !== "fulfilled") continue;
      await this.request("thread/unsubscribe", { threadId: root.value.threadId }, 5_000).catch(() => undefined);
      await this.request("thread/delete", { threadId: root.value.threadId }, 5_000).catch(async () => {
        await this.request("thread/archive", { threadId: root.value.threadId }, 5_000).catch(() => undefined);
      });
    }
    this.child = undefined;
    this.startPromise = undefined;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref();
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export class CodexAppServerPool {
  private readonly connections = new Map<string, CodexAppServerConnection>();
  private activeSessions = 0;
  private idleDisposal: Promise<void> | undefined;

  async beginSession(): Promise<() => Promise<void>> {
    if (this.idleDisposal) await this.idleDisposal;
    this.activeSessions += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.activeSessions = Math.max(0, this.activeSessions - 1);
      if (this.activeSessions === 0) await this.disposeIdle();
    };
  }

  private async disposeIdle(): Promise<void> {
    if (this.activeSessions !== 0) return;
    if (!this.idleDisposal) {
      this.idleDisposal = this.disposeConnections().finally(() => { this.idleDisposal = undefined; });
    }
    await this.idleDisposal;
  }

  private async disposeConnections(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.dispose()));
  }

  async run(request: CodexAppServerRunRequest): Promise<CodexAppServerRunResult> {
    if (this.idleDisposal) await this.idleDisposal;
    const key = JSON.stringify(request.launcher);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = new CodexAppServerConnection(request.launcher, request.environment);
      this.connections.set(key, connection);
    }
    return connection.run(request);
  }

  async dispose(): Promise<void> {
    this.activeSessions = 0;
    if (this.idleDisposal) await this.idleDisposal;
    await this.disposeConnections();
  }
}
