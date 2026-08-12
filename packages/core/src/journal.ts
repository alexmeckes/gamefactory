import { realpathSync } from "node:fs";
import { open, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const WORKFLOW_JOURNAL_PHASES = [
  "reserved",
  "candidate-created",
  "agent-finished",
  "evaluated",
  "evidence-preserved",
  "acceptance-intent",
  "applied",
  "recorded",
  "blocked",
  "cleaned"
] as const;

export type WorkflowJournalPhase = (typeof WORKFLOW_JOURNAL_PHASES)[number];

export type JournalJsonValue =
  | null
  | boolean
  | number
  | string
  | JournalJsonValue[]
  | { [key: string]: JournalJsonValue };

export interface WorkflowJournalIdentity {
  runId: string;
  campaignId: string;
  experimentId: string;
}

export interface WorkflowJournalAppend extends WorkflowJournalIdentity {
  phase: WorkflowJournalPhase;
  idempotencyKey: string;
  fingerprints: Readonly<Record<string, string>>;
  timestamp?: string;
  data?: JournalJsonValue;
}

export interface WorkflowJournalEntry extends WorkflowJournalIdentity {
  version: 1;
  sequence: number;
  timestamp: string;
  phase: WorkflowJournalPhase;
  idempotencyKey: string;
  fingerprints: Record<string, string>;
  data?: JournalJsonValue;
}

export interface WorkflowExperimentState extends WorkflowJournalIdentity {
  entries: WorkflowJournalEntry[];
  latestEntry: WorkflowJournalEntry;
  latestPhase: WorkflowJournalPhase;
  complete: boolean;
}

export interface WorkflowRecoveryState {
  entries: WorkflowJournalEntry[];
  experiments: WorkflowExperimentState[];
  incomplete: WorkflowExperimentState[];
  lastSequence: number;
}

export class WorkflowJournalFormatError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly line?: number
  ) {
    super(line === undefined ? `${message}: ${path}` : `${message} at ${path}:${line}`);
    this.name = "WorkflowJournalFormatError";
  }
}

const appendQueues = new Map<string, Promise<void>>();
const phases = new Set<string>(WORKFLOW_JOURNAL_PHASES);

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let cursor = absolute;
  const missing: string[] = [];
  let canonical = absolute;
  while (true) {
    try {
      canonical = join(realpathSync.native(cursor), ...missing.reverse());
      break;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function hasOnlyStringValues(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function validateEntry(value: unknown, path: string, line?: number): asserts value is WorkflowJournalEntry {
  const fail = (message: string): never => {
    throw new WorkflowJournalFormatError(message, path, line);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Journal entry must be an object");
  const entry = value as Partial<WorkflowJournalEntry>;
  if (entry.version !== 1) fail("Unsupported journal entry version");
  if (!Number.isSafeInteger(entry.sequence) || (entry.sequence ?? 0) < 1) fail("Journal sequence must be a positive safe integer");
  if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) fail("Journal timestamp must be an ISO-compatible date string");
  if (typeof entry.runId !== "string" || entry.runId.length === 0) fail("Journal runId must be a non-empty string");
  if (typeof entry.campaignId !== "string" || entry.campaignId.length === 0) fail("Journal campaignId must be a non-empty string");
  if (typeof entry.experimentId !== "string" || entry.experimentId.length === 0) fail("Journal experimentId must be a non-empty string");
  if (typeof entry.phase !== "string" || !phases.has(entry.phase)) fail("Journal phase is not recognized");
  if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.length === 0) fail("Journal idempotencyKey must be a non-empty string");
  if (!hasOnlyStringValues(entry.fingerprints)) fail("Journal fingerprints must contain only string values");
}

interface ParsedJournal {
  entries: WorkflowJournalEntry[];
  tail: "none" | "unterminated-valid" | "truncated";
  validByteLength: number;
}

function parseEntries(content: string, path: string): ParsedJournal {
  if (content.length === 0) return { entries: [], tail: "none", validByteLength: 0 };
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  if (terminated) lines.pop();
  const entries: WorkflowJournalEntry[] = [];
  let tail: ParsedJournal["tail"] = terminated ? "none" : "unterminated-valid";
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!terminated && index === lines.length - 1) {
        tail = "truncated";
        break;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorkflowJournalFormatError(`Malformed journal JSON (${reason})`, path, lineNumber);
    }
    validateEntry(parsed, path, lineNumber);
    const previous = entries.at(-1);
    if (parsed.sequence !== (previous?.sequence ?? 0) + 1) {
      throw new WorkflowJournalFormatError("Journal sequence is not contiguous and monotonic", path, lineNumber);
    }
    entries.push(parsed);
  }
  const lastNewline = content.lastIndexOf("\n");
  return {
    entries,
    tail,
    validByteLength: tail === "truncated" ? Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8") : Buffer.byteLength(content, "utf8")
  };
}

function sameOperation(existing: WorkflowJournalEntry, input: WorkflowJournalAppend): boolean {
  return existing.runId === input.runId
    && existing.campaignId === input.campaignId
    && existing.experimentId === input.experimentId
    && existing.phase === input.phase
    && isDeepStrictEqual(existing.fingerprints, input.fingerprints)
    && isDeepStrictEqual(existing.data, input.data);
}

function normalizeData(data: JournalJsonValue | undefined): JournalJsonValue | undefined {
  if (data === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Workflow journal data must be JSON-serializable (${reason})`);
  }
  if (serialized === undefined) throw new TypeError("Workflow journal data must be a JSON value");
  const normalized = JSON.parse(serialized) as JournalJsonValue;
  if (!isDeepStrictEqual(data, normalized)) {
    throw new TypeError("Workflow journal data must not contain values that change during JSON serialization");
  }
  return normalized;
}

function experimentKey(identity: WorkflowJournalIdentity): string {
  return JSON.stringify([identity.runId, identity.campaignId, identity.experimentId]);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function reconstructWorkflowState(entries: readonly WorkflowJournalEntry[]): WorkflowRecoveryState {
  const grouped = new Map<string, WorkflowJournalEntry[]>();
  let expectedSequence = 1;
  for (const entry of entries) {
    validateEntry(entry, "<memory>");
    if (entry.sequence !== expectedSequence) {
      throw new WorkflowJournalFormatError("Journal sequence is not contiguous and monotonic", "<memory>");
    }
    expectedSequence += 1;
    const key = experimentKey(entry);
    const current = grouped.get(key) ?? [];
    current.push(entry);
    grouped.set(key, current);
  }
  const experiments = [...grouped.values()].map((experimentEntries): WorkflowExperimentState => {
    const latestEntry = experimentEntries.at(-1)!;
    return {
      runId: latestEntry.runId,
      campaignId: latestEntry.campaignId,
      experimentId: latestEntry.experimentId,
      entries: [...experimentEntries],
      latestEntry,
      latestPhase: latestEntry.phase,
      complete: latestEntry.phase === "cleaned"
    };
  });
  return {
    entries: [...entries],
    experiments,
    incomplete: experiments.filter((experiment) => !experiment.complete),
    lastSequence: entries.at(-1)?.sequence ?? 0
  };
}

export class WorkflowJournal {
  readonly path: string;
  private readonly queueKey: string;

  constructor(path: string) {
    this.path = resolve(path);
    this.queueKey = canonicalPath(path);
  }

  append(input: WorkflowJournalAppend): Promise<WorkflowJournalEntry> {
    const previous = appendQueues.get(this.queueKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (input.timestamp !== undefined && !Number.isFinite(Date.parse(input.timestamp))) {
        throw new TypeError("Workflow journal timestamp must be an ISO-compatible date string");
      }
      if (input.idempotencyKey.length === 0) throw new TypeError("Workflow journal idempotencyKey must not be empty");
      if (!hasOnlyStringValues(input.fingerprints)) throw new TypeError("Workflow journal fingerprints must contain only string values");
      const data = normalizeData(input.data);
      await mkdir(dirname(this.path), { recursive: true });
      const parsed = parseEntries(await readFileOrEmpty(this.path), this.path);
      const entries = parsed.entries;
      if (parsed.tail === "truncated") {
        const repairHandle = await open(this.path, "r+");
        try {
          await repairHandle.truncate(parsed.validByteLength);
          await repairHandle.sync();
        } finally {
          await repairHandle.close();
        }
      }
      const duplicate = entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (!sameOperation(duplicate, input)) {
          throw new Error(`Workflow journal idempotency key already belongs to another operation: ${input.idempotencyKey}`);
        }
        return duplicate;
      }
      const entry: WorkflowJournalEntry = {
        version: 1,
        sequence: (entries.at(-1)?.sequence ?? 0) + 1,
        timestamp: input.timestamp ?? new Date().toISOString(),
        runId: input.runId,
        campaignId: input.campaignId,
        experimentId: input.experimentId,
        phase: input.phase,
        idempotencyKey: input.idempotencyKey,
        fingerprints: { ...input.fingerprints },
        ...(data === undefined ? {} : { data })
      };
      validateEntry(entry, this.path);
      const handle = await open(this.path, "a");
      try {
        const separator = parsed.tail === "unterminated-valid" ? "\n" : "";
        await handle.writeFile(`${separator}${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return entry;
    });
    const queued = operation.then(() => undefined, () => undefined);
    appendQueues.set(this.queueKey, queued);
    return operation.finally(() => {
      if (appendQueues.get(this.queueKey) === queued) appendQueues.delete(this.queueKey);
    });
  }

  async read(): Promise<WorkflowJournalEntry[]> {
    await appendQueues.get(this.queueKey);
    return parseEntries(await readFileOrEmpty(this.path), this.path).entries;
  }

  async recover(): Promise<WorkflowRecoveryState> {
    return reconstructWorkflowState(await this.read());
  }
}
