import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryLogger, type CampaignResult } from "@gamefactory/core";
import { ProjectJourneyJournal } from "./journal.js";
import { loadProject } from "./manifest.js";
import { ProjectRunner } from "./runner.js";
import { SqliteProjectJourneyIndex } from "./sqlite.js";

async function fixture(): Promise<{ root: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-"));
  await writeFile(join(root, "campaign.json"), JSON.stringify({ apiVersion: "gamefactory.dev/v1", id: "project-campaign", objective: "test", projectRoot: ".", workflow: "fixture", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } }), "utf8");
  await writeFile(join(root, "factory.json"), JSON.stringify({ apiVersion: "gamefactory.dev/v1", extensions: [] }), "utf8");
  const manifestPath = join(root, "gamefactory.project.json");
  await writeFile(manifestPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", kind: "Project", id: "fixture-project", title: "Fixture", projectRoot: ".", phases: [{ id: "proof", title: "Proof", order: 10, gate: { requireAcceptedRevision: true, requireMetrics: { score: { minimum: 2 } } }, attempts: [{ id: "proof-v1", campaign: "campaign.json", config: "factory.json" }] }] }), "utf8");
  return { root, manifestPath };
}

test("loads a safe project manifest and rejects dependency cycles", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const project = await loadProject(manifestPath);
    assert.equal(project.id, "fixture-project");
    assert.equal(project.phases[0]?.attempts[0]?.campaignPath, join(root, "campaign.json"));
    await writeFile(manifestPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", kind: "Project", id: "bad", title: "Bad", projectRoot: ".", phases: [
      { id: "a", title: "A", order: 1, dependsOn: ["b"], attempts: [{ id: "a1", campaign: "campaign.json", config: "factory.json" }] },
      { id: "b", title: "B", order: 2, dependsOn: ["a"], attempts: [{ id: "b1", campaign: "campaign.json", config: "factory.json" }] }
    ] }), "utf8");
    await assert.rejects(() => loadProject(manifestPath), /dependency cycle/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project journal is idempotent and rejects conflicting retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-journal-"));
  try {
    const journal = new ProjectJourneyJournal(join(root, "journey.jsonl"));
    const event = { projectId: "fixture", projectRunId: "run", type: "project-started" as const, idempotencyKey: "start", manifestFingerprint: "a".repeat(64), actor: { kind: "factory" as const } };
    assert.equal((await journal.append(event)).sequence, 1);
    assert.equal((await journal.append(event)).sequence, 1);
    await assert.rejects(() => journal.append({ ...event, actor: { kind: "user" } }), /idempotency conflict/);
    assert.equal((await journal.read()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite index mirrors idempotent project events for local querying", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-sqlite-"));
  const index = await SqliteProjectJourneyIndex.open(join(root, "factory.sqlite"));
  try {
    const journal = new ProjectJourneyJournal(join(root, "journey.jsonl"), index);
    const event = { projectId: "fixture", projectRunId: "run", type: "project-started" as const, idempotencyKey: "start", manifestFingerprint: "a".repeat(64), actor: { kind: "factory" as const } };
    await journal.append(event);
    await journal.append(event);
    const indexed = await index.read("fixture");
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0]?.idempotencyKey, "start");
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project runner records a gated campaign and advances durably", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const project = await loadProject(manifestPath);
    const result: CampaignResult = { campaignId: "project-campaign", status: "complete", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 3 }, summary: "accepted", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "a".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => result });
    const run = await runner.run();
    assert.equal(run.status, "complete");
    assert.equal(run.phases[0]?.acceptedRevision, "a".repeat(40));
    assert.deepEqual((await runner.journal.read()).map((event) => event.type), ["project-started", "phase-started", "campaign-linked", "phase-completed", "project-finished"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project runner resumes a blocked phase as a new durable execution", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const project = await loadProject(manifestPath);
    const blocked: CampaignResult = { campaignId: "project-campaign", status: "blocked", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: {}, summary: "blocked", experiments: [] };
    const accepted: CampaignResult = { campaignId: "project-campaign", status: "complete", startedAt: "2026-01-01T00:00:02.000Z", finishedAt: "2026-01-01T00:00:03.000Z", bestMetrics: { score: 3 }, summary: "accepted", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:02.000Z", finishedAt: "2026-01-01T00:00:03.000Z", status: "keep", revision: "b".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    let calls = 0;
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => calls++ === 0 ? blocked : accepted });
    assert.equal((await runner.run()).status, "blocked");
    assert.equal((await runner.run()).status, "complete");
    const events = await runner.journal.read();
    assert.equal(events.filter((event) => event.type === "project-started").length, 1);
    assert.equal(events.filter((event) => event.type === "phase-started").length, 2);
    assert.equal(events.filter((event) => event.type === "project-finished").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
