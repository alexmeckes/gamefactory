import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProject, ProjectJourneyJournal } from "@gamefactory/project-sdk";
import { createFactoryProjectSnapshot, readFactoryProjectTrace } from "./project.js";

test("projects multiple campaigns into phases without merging source sequences", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-viewer-"));
  try {
    await mkdir(join(root, ".factory", "journal"), { recursive: true });
    await mkdir(join(root, ".factory", "results"), { recursive: true });
    await mkdir(join(root, ".factory", "traces"), { recursive: true });
    for (const id of ["gameplay", "art"]) {
      await writeFile(join(root, `${id}.campaign.json`), JSON.stringify({ apiVersion: "gamefactory.dev/v1", id, objective: id, projectRoot: ".", workflow: "fixture", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } }), "utf8");
      await writeFile(join(root, `${id}.config.json`), JSON.stringify({ apiVersion: "gamefactory.dev/v1", extensions: [], journalLog: `.factory/journal/${id}.jsonl`, resultLog: `.factory/results/${id}.jsonl`, traceLog: `.factory/traces/${id}.jsonl` }), "utf8");
      await writeFile(join(root, ".factory", "traces", `${id}.jsonl`), `${JSON.stringify({ version: 1, sequence: 1, timestamp: `2026-01-01T00:00:0${id === "gameplay" ? 1 : 2}.000Z`, runId: `${id}-run`, campaignId: id, type: "node:created", nodeId: `campaign:${id}-run`, label: id, role: "campaign" })}\n`, "utf8");
    }
    const manifestPath = join(root, "gamefactory.project.json");
    await writeFile(manifestPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", kind: "Project", id: "viewer-project", title: "Viewer project", projectRoot: ".", phases: [
      { id: "gameplay", title: "Gameplay", order: 10, attempts: [{ id: "v1", campaign: "gameplay.campaign.json", config: "gameplay.config.json" }] },
      { id: "art", title: "Art", order: 20, dependsOn: ["gameplay"], attempts: [{ id: "v1", campaign: "art.campaign.json", config: "art.config.json" }] }
    ] }), "utf8");
    const project = await loadProject(manifestPath);
    const journal = new ProjectJourneyJournal(join(root, ".factory", "projects", project.id, "journey.jsonl"));
    const common = { projectId: project.id, projectRunId: "project-run", manifestFingerprint: "a".repeat(64), actor: { kind: "factory" as const } };
    await journal.append({ ...common, type: "project-started", idempotencyKey: "start" });
    await journal.append({ ...common, type: "phase-started", idempotencyKey: "gameplay-start", phaseId: "gameplay", phaseAttemptId: "v1", campaignId: "gameplay", runId: "gameplay-run" });
    await journal.append({ ...common, type: "phase-completed", idempotencyKey: "gameplay-complete", phaseId: "gameplay", phaseAttemptId: "v1", campaignId: "gameplay", runId: "gameplay-run", resultingRevision: "b".repeat(40) });
    await journal.append({ ...common, type: "phase-started", idempotencyKey: "art-start", phaseId: "art", phaseAttemptId: "v1", campaignId: "art", runId: "art-run" });
    const trace = await readFactoryProjectTrace(project, root);
    const snapshot = createFactoryProjectSnapshot(trace, { phaseId: "art", attemptId: "v1", runId: "art-run" });
    assert.equal(snapshot.project.status, "live");
    assert.equal(snapshot.phases[0]?.status, "complete");
    assert.equal(snapshot.phases[1]?.status, "live");
    assert.equal(snapshot.selection.campaignId, "art");
    assert.equal(snapshot.run.runId, "art-run");
    assert.equal(snapshot.totals.campaigns, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
