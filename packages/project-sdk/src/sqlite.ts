import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectJourneyIndex } from "./journal.js";
import type { ProjectJourneyEvent } from "./types.js";

interface StoredEvent {
  payload_json: string;
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

  close(): void {
    this.database.close();
  }
}
