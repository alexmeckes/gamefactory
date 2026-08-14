import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectJourneyAppend, ProjectJourneyEvent } from "./types.js";

const queues = new Map<string, Promise<void>>();

export interface ProjectJourneyIndex {
  put(event: ProjectJourneyEvent): Promise<void>;
}

function parse(content: string, path: string): ProjectJourneyEvent[] {
  if (!content) return [];
  const terminated = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (terminated) lines.pop();
  const events: ProjectJourneyEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    try { events.push(JSON.parse(lines[index]!) as ProjectJourneyEvent); }
    catch (error) {
      if (!terminated && index === lines.length - 1) break;
      throw new Error(`Malformed project journal at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

export class ProjectJourneyJournal {
  readonly path: string;
  private readonly key: string;

  constructor(path: string, private readonly index?: ProjectJourneyIndex) {
    this.path = resolve(path);
    this.key = process.platform === "win32" ? this.path.toLowerCase() : this.path;
  }

  async read(): Promise<ProjectJourneyEvent[]> {
    await queues.get(this.key);
    try { return parse(await readFile(this.path, "utf8"), this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async append(input: ProjectJourneyAppend): Promise<ProjectJourneyEvent> {
    const previous = queues.get(this.key) ?? Promise.resolve();
    let result: ProjectJourneyEvent | undefined;
    const operation = previous.then(async () => {
      const events = await this.readUnlocked();
      const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing) {
        const { version: _version, sequence: _sequence, timestamp: _timestamp, ...existingInput } = existing;
        if (!isDeepStrictEqual(existingInput, input)) throw new Error(`Project journal idempotency conflict for ${input.idempotencyKey}`);
        await this.index?.put(existing);
        result = existing;
        return;
      }
      const event: ProjectJourneyEvent = { ...input, version: 1, sequence: (events.at(-1)?.sequence ?? 0) + 1, timestamp: new Date().toISOString() };
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await this.index?.put(event);
      result = event;
    });
    const queued = operation.catch(() => undefined);
    queues.set(this.key, queued);
    try { await operation; return result!; }
    finally { if (queues.get(this.key) === queued) queues.delete(this.key); }
  }

  private async readUnlocked(): Promise<ProjectJourneyEvent[]> {
    try { return parse(await readFile(this.path, "utf8"), this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}

export async function acquireProjectLease(path: string, projectRunId: string): Promise<() => Promise<void>> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  let handle;
  try { handle = await open(target, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Project is already being advanced; remove the lease manually only after confirming no runner is active: ${target}`);
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ projectRunId, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  await handle.sync();
  return async () => { await handle.close(); await unlink(target).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); };
}
