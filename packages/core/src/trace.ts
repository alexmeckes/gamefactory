import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JournalJsonValue } from "./journal.js";

export type FactoryTraceEventType =
  | "node:created"
  | "node:started"
  | "node:progress"
  | "node:completed"
  | "node:failed"
  | "node:skipped"
  | "edge:created"
  | "artifact:produced";

export interface FactoryTraceEventInput {
  type: FactoryTraceEventType;
  nodeId: string;
  experimentId?: string;
  parentNodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  label?: string;
  role?: string;
  status?: string;
  attempt?: number;
  message?: string;
  progress?: { current?: number; total?: number; unit?: string };
  data?: JournalJsonValue;
}

export interface FactoryTraceEvent extends FactoryTraceEventInput {
  version: 1;
  sequence: number;
  timestamp: string;
  runId: string;
  campaignId: string;
}

export interface TraceSink {
  readonly runId: string;
  readonly campaignId: string;
  emit(event: FactoryTraceEventInput): Promise<void>;
}

function parseTrace(content: string, path: string): FactoryTraceEvent[] {
  if (!content) return [];
  const terminated = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (terminated) lines.pop();
  const events: FactoryTraceEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as FactoryTraceEvent);
    } catch (error) {
      if (!terminated && index === lines.length - 1) break;
      throw new Error(`Malformed trace JSON at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export class JsonlTraceStore {
  readonly path: string;
  private queue = Promise.resolve();
  private nextSequence: number | undefined;

  constructor(path: string) {
    this.path = resolve(path);
  }

  append(identity: { runId: string; campaignId: string }, input: FactoryTraceEventInput): Promise<FactoryTraceEvent> {
    const operation = this.queue.then(async () => {
      if (this.nextSequence === undefined) {
        const previous = parseTrace(await readOrEmpty(this.path), this.path);
        this.nextSequence = previous.at(-1)?.sequence ?? 0;
      }
      const event: FactoryTraceEvent = {
        version: 1,
        sequence: ++this.nextSequence,
        timestamp: new Date().toISOString(),
        runId: identity.runId,
        campaignId: identity.campaignId,
        ...input
      };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async read(): Promise<FactoryTraceEvent[]> {
    await this.queue;
    return parseTrace(await readOrEmpty(this.path), this.path);
  }
}
