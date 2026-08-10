import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExperimentRecord } from "./types.js";

const appendQueues = new Map<string, Promise<void>>();

export class JsonlResultStore {
  private readonly queueKey: string;

  constructor(readonly path: string) {
    this.queueKey = resolve(path).toLowerCase();
  }

  async append(record: ExperimentRecord): Promise<void> {
    const previous = appendQueues.get(this.queueKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    });
    const queued = operation.catch(() => undefined);
    appendQueues.set(this.queueKey, queued);
    try {
      await operation;
    } finally {
      if (appendQueues.get(this.queueKey) === queued) appendQueues.delete(this.queueKey);
    }
  }

  async read(campaignId?: string): Promise<ExperimentRecord[]> {
    await appendQueues.get(this.queueKey);
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExperimentRecord)
      .filter((record) => !campaignId || record.campaignId === campaignId);
  }
}
