import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteProjectJourneyIndex } from "@gamefactory/project-sdk/sqlite";
import { migrateStorage, storageDoctor, storageGc, storageStatus } from "./storage.js";

test("storage migration preserves layout, indexes JSONL, and only collects old disposable files", async () => {
  const base = await mkdtemp(join(tmpdir(), "gamefactory-storage-"));
  const cwd = join(base, "source");
  const dataRoot = join(base, "data");
  await mkdir(join(cwd, "game", ".factory", "traces"), { recursive: true });
  await writeFile(join(cwd, "game", ".factory", "traces", "run.jsonl"), `${JSON.stringify({ type: "node:completed", campaignId: "fixture", runId: "run", experimentId: "exp", timestamp: "2026-01-01T00:00:00.000Z", metrics: { score: 3 } })}\n`, "utf8");
  const index = await SqliteProjectJourneyIndex.open(join(dataRoot, "factory.sqlite"));
  try {
    const migration = await migrateStorage(cwd, dataRoot, index);
    assert.equal(migration.copiedRoots, 1);
    assert.equal(migration.indexedFiles, 1);
    assert.equal(migration.indexedRecords, 1);
    const status = await storageStatus(dataRoot, index);
    assert.equal(status.database.indexedRecords, 1);
    assert.equal(status.database.indexedMetrics, 1);
    await unlink(join(dataRoot, "game", ".factory", "traces", "run.jsonl"));
    const pruned = await storageStatus(dataRoot, index);
    assert.equal(pruned.database.indexedRecords, 0);
    assert.equal(pruned.database.indexedSources, 0);

    const disposable = join(dataRoot, "cache", "old.tmp");
    await mkdir(join(dataRoot, "cache"), { recursive: true });
    await writeFile(disposable, "old", "utf8");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await utimes(disposable, old, old);
    assert.equal((await storageGc(dataRoot, false)).candidates.length, 1);
    assert.equal((await storageGc(dataRoot, true)).reclaimedBytes, 3);
    await assert.rejects(() => access(disposable));
  } finally {
    index.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("storage doctor rejects roots that contain the repository", async () => {
  const base = await mkdtemp(join(tmpdir(), "gamefactory-storage-overlap-"));
  const cwd = join(base, "source");
  const safeDataRoot = join(tmpdir(), `gamefactory-storage-index-${process.pid}-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const index = await SqliteProjectJourneyIndex.open(join(safeDataRoot, "factory.sqlite"));
  try {
    const checks = await storageDoctor(cwd, base, base, index);
    assert.equal(checks.find((check) => check.check === "data-root:isolation")?.ok, false);
    assert.equal(checks.find((check) => check.check === "worktree-root:isolation")?.ok, false);
    await assert.rejects(() => migrateStorage(cwd, base, index), /must not contain one another/);
  } finally {
    index.close();
    await rm(base, { recursive: true, force: true });
    await rm(safeDataRoot, { recursive: true, force: true });
  }
});
