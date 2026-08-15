import Database from "better-sqlite3";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectJourneyIndex } from "./journal.js";
import type { ProjectJourneyEvent } from "./types.js";

interface StoredEvent {
  payload_json: string;
}

export interface SqliteIndexStats {
  schemaVersion: number;
  projectEvents: number;
  indexedRecords: number;
  indexedMetrics: number;
  indexedSources: number;
}

function recordKind(value: Record<string, unknown>): string {
  if (typeof value.projectId === "string" && typeof value.type === "string") return "project-event";
  if (typeof value.phase === "string" && typeof value.campaignId === "string") return "workflow-journal";
  if (typeof value.experimentId === "string" && typeof value.status === "string") return "experiment-record";
  if (typeof value.type === "string" && typeof value.campaignId === "string") return "trace-event";
  return "jsonl-record";
}

function finiteMetrics(value: unknown): Array<[string, number]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
}

export class SqliteProjectJourneyIndex implements ProjectJourneyIndex {
  readonly path: string;
  private constructor(path: string, private readonly database: Database.Database) {
    this.path = path;
  }

  static async open(path: string): Promise<SqliteProjectJourneyIndex> {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const database = new Database(target);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_events (
        project_id TEXT NOT NULL,
        project_run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        phase_id TEXT,
        phase_attempt_id TEXT,
        campaign_id TEXT,
        run_id TEXT,
        experiment_id TEXT,
        idempotency_key TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (project_id, sequence),
        UNIQUE (project_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS project_events_run_sequence
        ON project_events(project_id, project_run_id, sequence);
      CREATE INDEX IF NOT EXISTS project_events_campaign_run
        ON project_events(campaign_id, run_id);
      CREATE TABLE IF NOT EXISTS factory_records (
        source_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        record_kind TEXT NOT NULL,
        campaign_id TEXT,
        run_id TEXT,
        experiment_id TEXT,
        timestamp TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (source_path, line_number)
      );
      CREATE INDEX IF NOT EXISTS factory_records_campaign_run
        ON factory_records(campaign_id, run_id, line_number);
      CREATE INDEX IF NOT EXISTS factory_records_experiment
        ON factory_records(experiment_id, line_number);
      CREATE TABLE IF NOT EXISTS record_metrics (
        source_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (source_path, line_number, metric),
        FOREIGN KEY (source_path, line_number)
          REFERENCES factory_records(source_path, line_number) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS indexed_sources (
        source_path TEXT PRIMARY KEY,
        byte_size INTEGER NOT NULL,
        modified_ms REAL NOT NULL,
        record_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    return new SqliteProjectJourneyIndex(target, database);
  }

  async put(event: ProjectJourneyEvent): Promise<void> {
    const payload = JSON.stringify(event);
    const existing = this.database.prepare(
      "SELECT payload_json FROM project_events WHERE project_id = ? AND idempotency_key = ?",
    ).get(event.projectId, event.idempotencyKey) as StoredEvent | undefined;
    if (existing) {
      const value = JSON.parse(existing.payload_json) as ProjectJourneyEvent;
      if (!isDeepStrictEqual(value, event)) throw new Error(`SQLite project event conflict for ${event.projectId}/${event.idempotencyKey}`);
      return;
    }
    this.database.prepare(`
      INSERT INTO project_events (
        project_id, project_run_id, sequence, timestamp, event_type,
        phase_id, phase_attempt_id, campaign_id, run_id, experiment_id,
        idempotency_key, manifest_fingerprint, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.projectId,
      event.projectRunId,
      event.sequence,
      event.timestamp,
      event.type,
      event.phaseId ?? null,
      event.phaseAttemptId ?? null,
      event.campaignId ?? null,
      event.runId ?? null,
      event.experimentId ?? null,
      event.idempotencyKey,
      event.manifestFingerprint,
      payload,
    );
  }

  async sync(events: ProjectJourneyEvent[]): Promise<void> {
    const transaction = this.database.transaction((values: ProjectJourneyEvent[]) => {
      for (const event of values) {
        const payload = JSON.stringify(event);
        const existing = this.database.prepare(
          "SELECT payload_json FROM project_events WHERE project_id = ? AND idempotency_key = ?",
        ).get(event.projectId, event.idempotencyKey) as StoredEvent | undefined;
        if (existing) {
          if (!isDeepStrictEqual(JSON.parse(existing.payload_json), event)) throw new Error(`SQLite project event conflict for ${event.projectId}/${event.idempotencyKey}`);
          continue;
        }
        this.database.prepare(`
          INSERT INTO project_events (
            project_id, project_run_id, sequence, timestamp, event_type,
            phase_id, phase_attempt_id, campaign_id, run_id, experiment_id,
            idempotency_key, manifest_fingerprint, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(event.projectId, event.projectRunId, event.sequence, event.timestamp, event.type,
          event.phaseId ?? null, event.phaseAttemptId ?? null, event.campaignId ?? null,
          event.runId ?? null, event.experimentId ?? null, event.idempotencyKey,
          event.manifestFingerprint, payload);
      }
    });
    transaction(events);
  }

  async read(projectId: string, projectRunId?: string): Promise<ProjectJourneyEvent[]> {
    const rows = projectRunId
      ? this.database.prepare("SELECT payload_json FROM project_events WHERE project_id = ? AND project_run_id = ? ORDER BY sequence").all(projectId, projectRunId)
      : this.database.prepare("SELECT payload_json FROM project_events WHERE project_id = ? ORDER BY sequence").all(projectId);
    return (rows as StoredEvent[]).map((row) => JSON.parse(row.payload_json) as ProjectJourneyEvent);
  }

  async indexJsonl(path: string, dataRoot: string): Promise<number> {
    const canonicalRoot = resolve(dataRoot);
    const target = resolve(path);
    const traversal = relative(canonicalRoot, target);
    if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`Indexed JSONL must stay inside the data root: ${target}`);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Indexed JSONL source is not a file: ${target}`);
    const sourcePath = traversal.replaceAll("\\", "/");
    const previous = this.database.prepare("SELECT byte_size, modified_ms, record_count FROM indexed_sources WHERE source_path = ?").get(sourcePath) as { byte_size: number; modified_ms: number; record_count: number } | undefined;
    if (previous?.byte_size === info.size && previous.modified_ms === info.mtimeMs) return previous.record_count;
    const content = await readFile(target, "utf8");
    const terminated = content.endsWith("\n");
    const lines = content.split(/\r?\n/);
    if (terminated) lines.pop();
    const records: Array<{ line: number; value: Record<string, unknown>; payload: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const payload = lines[index]!;
      if (!payload) continue;
      try {
        const value = JSON.parse(payload) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) records.push({ line: index + 1, value: value as Record<string, unknown>, payload });
      } catch (error) {
        if (!terminated && index === lines.length - 1) break;
        throw new Error(`Malformed JSONL at ${target}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const insertRecord = this.database.prepare(`
      INSERT INTO factory_records(source_path, line_number, record_kind, campaign_id, run_id, experiment_id, timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMetric = this.database.prepare("INSERT INTO record_metrics(source_path, line_number, metric, value) VALUES (?, ?, ?, ?)");
    const transaction = this.database.transaction(() => {
      this.database.prepare("DELETE FROM factory_records WHERE source_path = ?").run(sourcePath);
      for (const record of records) {
        insertRecord.run(sourcePath, record.line, recordKind(record.value),
          typeof record.value.campaignId === "string" ? record.value.campaignId : null,
          typeof record.value.runId === "string" ? record.value.runId : null,
          typeof record.value.experimentId === "string" ? record.value.experimentId : null,
          typeof record.value.timestamp === "string" ? record.value.timestamp : typeof record.value.startedAt === "string" ? record.value.startedAt : null,
          record.payload);
        for (const [metric, value] of finiteMetrics(record.value.metrics)) insertMetric.run(sourcePath, record.line, metric, value);
      }
      this.database.prepare(`
        INSERT INTO indexed_sources(source_path, byte_size, modified_ms, record_count, indexed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
          byte_size = excluded.byte_size,
          modified_ms = excluded.modified_ms,
          record_count = excluded.record_count,
          indexed_at = excluded.indexed_at
      `).run(sourcePath, info.size, info.mtimeMs, records.length, new Date().toISOString());
    });
    transaction();
    return records.length;
  }

  pruneJsonlSources(paths: string[], dataRoot: string): number {
    const canonicalRoot = resolve(dataRoot);
    const retained = new Set(paths.map((path) => {
      const target = resolve(path);
      const traversal = relative(canonicalRoot, target);
      if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(`Indexed JSONL must stay inside the data root: ${target}`);
      return traversal.replaceAll("\\", "/");
    }));
    const existing = this.database.prepare("SELECT source_path FROM indexed_sources").all() as Array<{ source_path: string }>;
    const stale = existing.map((row) => row.source_path).filter((path) => !retained.has(path));
    const transaction = this.database.transaction(() => {
      const deleteRecords = this.database.prepare("DELETE FROM factory_records WHERE source_path = ?");
      const deleteSource = this.database.prepare("DELETE FROM indexed_sources WHERE source_path = ?");
      for (const source of stale) {
        deleteRecords.run(source);
        deleteSource.run(source);
      }
    });
    transaction();
    return stale.length;
  }

  stats(): SqliteIndexStats {
    const count = (table: string): number => Number((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    return {
      schemaVersion: Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version),
      projectEvents: count("project_events"),
      indexedRecords: count("factory_records"),
      indexedMetrics: count("record_metrics"),
      indexedSources: count("indexed_sources"),
    };
  }

  checkpointAndVacuum(): void {
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.exec("VACUUM");
  }

  close(): void {
    this.database.close();
  }
}
