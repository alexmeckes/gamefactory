import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { MemoryLogger, type Campaign, type CampaignResult } from "@gamefactory/core";
import { ProjectJourneyJournal } from "./journal.js";
import { loadProject } from "./manifest.js";
import { ProjectRunner } from "./runner.js";
import { gameSpecFingerprint, parseGameSpec } from "./spec.js";
import { SqliteProjectJourneyIndex } from "./sqlite.js";

const execFileAsync = promisify(execFile);

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

test("project runner bootstraps manifest-linked history exactly once", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.history = "project-history.jsonl";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await writeFile(join(root, "project-history.jsonl"), `${JSON.stringify({ version: 1, sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", projectId: "fixture-project", projectRunId: "historical", type: "project-started", idempotencyKey: "history:start", manifestFingerprint: "a".repeat(64), actor: { kind: "system" } })}\n`, "utf8");
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger() });
    assert.equal((await runner.readJourney()).length, 1);
    assert.equal((await runner.readJourney()).length, 1);
    assert.equal((await runner.journal.read())[0]?.idempotencyKey, "history:start");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project runner anchors state to the manifest project root when launched elsewhere", async () => {
  const { root, manifestPath } = await fixture();
  const launcher = await mkdtemp(join(tmpdir(), "gamefactory-launcher-"));
  try {
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: launcher, logger: new MemoryLogger() });
    assert.equal(runner.journal.path, join(root, ".factory", "projects", "fixture-project", "journey.jsonl"));
    assert.deepEqual(await runner.readJourney(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(launcher, { recursive: true, force: true });
  }
});

test("project runner supersedes a revision-stale run that never started a phase", async () => {
  const { root, manifestPath } = await fixture();
  try {
    await writeFile(join(root, ".gitignore"), ".factory/\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "factory@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "GameFactory Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    const oldRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const project = await loadProject(manifestPath);
    const runner = new ProjectRunner(project, {
      cwd: root,
      logger: new MemoryLogger(),
      executeCampaign: async () => ({
        campaignId: "project-campaign",
        status: "complete",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        bestMetrics: { score: 3 },
        summary: "accepted",
        experiments: [{ campaignId: "project-campaign", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "pending", summary: "kept", metrics: { score: 3 }, evaluations: [] }],
      }),
    });
    await runner.journal.append({ projectId: project.id, projectRunId: "stale-run", type: "project-started", idempotencyKey: "stale-run:started", manifestFingerprint: runner.manifestFingerprint, actor: { kind: "factory" }, sourceRevision: oldRevision });
    await writeFile(join(root, "revision-change.txt"), "infrastructure repair\n", "utf8");
    await execFileAsync("git", ["add", "revision-change.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "repair"], { cwd: root });
    const newRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const result = await runner.run();
    const events = await runner.journal.read();
    const staleTerminalData = events.find((event) => event.projectRunId === "stale-run" && event.type === "project-finished")?.data;

    assert.equal(result.status, "complete");
    assert.notEqual(result.projectRunId, "stale-run");
    assert.equal(staleTerminalData && typeof staleTerminalData === "object" && !Array.isArray(staleTerminalData) ? staleTerminalData.status : undefined, "superseded-before-execution");
    assert.equal(events.find((event) => event.projectRunId === result.projectRunId && event.type === "project-started")?.sourceRevision, newRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project runner starts a new lineage after a committed repair to a blocked run", async () => {
  const { root, manifestPath } = await fixture();
  try {
    await writeFile(join(root, ".gitignore"), ".factory/\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "factory@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "GameFactory Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    let calls = 0;
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => {
      calls += 1;
      if (calls === 1) return { campaignId: "project-campaign", status: "blocked", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: {}, summary: "repair needed", experiments: [] };
      return { campaignId: "project-campaign", status: "complete", startedAt: "2026-01-01T00:00:02.000Z", finishedAt: "2026-01-01T00:00:03.000Z", bestMetrics: { score: 3 }, summary: "accepted", experiments: [{ campaignId: "project-campaign", experimentId: "candidate", startedAt: "2026-01-01T00:00:02.000Z", finishedAt: "2026-01-01T00:00:03.000Z", status: "keep", revision: "b".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    } });
    const blocked = await runner.run();
    await writeFile(join(root, "repair.txt"), "bounded repair\n", "utf8");
    await execFileAsync("git", ["add", "repair.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "repair"], { cwd: root });
    const repaired = await runner.run();
    assert.equal(repaired.status, "complete");
    assert.notEqual(repaired.projectRunId, blocked.projectRunId);
    const superseded = (await runner.journal.read()).find((event) => event.projectRunId === blocked.projectRunId && event.type === "project-finished");
    assert.equal((superseded?.data as Record<string, unknown>).status, "superseded-after-blocked-repair");
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

test("SQLite index reconciles a stale project lineage from the authoritative journal snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-sqlite-reconcile-"));
  const index = await SqliteProjectJourneyIndex.open(join(root, "factory.sqlite"));
  try {
    const base = {
      projectId: "fixture",
      manifestFingerprint: "a".repeat(64),
      actor: { kind: "factory" as const },
      version: 1 as const,
    };
    await index.put({ ...base, projectRunId: "stale", type: "project-started", idempotencyKey: "stale:start", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" });
    const authoritative = [
      { ...base, projectRunId: "current", type: "project-started" as const, idempotencyKey: "current:start", sequence: 1, timestamp: "2026-02-01T00:00:00.000Z" },
      { ...base, projectRunId: "current", type: "project-finished" as const, idempotencyKey: "current:finish", sequence: 2, timestamp: "2026-02-01T00:01:00.000Z" },
    ];

    await index.sync(authoritative);

    assert.deepEqual(await index.read("fixture"), authoritative);
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

test("project runner advances a successful bounded campaign after its experiment budget is consumed", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.phases[0].gate.allowBudgetExhaustedAfterAcceptance = true;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const project = await loadProject(manifestPath);
    const result: CampaignResult = { campaignId: "project-campaign", status: "budget-exhausted", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 3 }, summary: "accepted before bounded search ended", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "c".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => result });
    const run = await runner.run();
    assert.equal(run.status, "complete");
    assert.equal(run.phases[0]?.acceptedRevision, "c".repeat(40));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project runner does not treat budget exhaustion as success without an explicit phase policy", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const result: CampaignResult = { campaignId: "project-campaign", status: "budget-exhausted", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 3 }, summary: "budget ended", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "c".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => result });
    const run = await runner.run();
    assert.equal(run.status, "blocked");
    assert.match(run.phases[0]?.reasons?.join(" ") ?? "", /explicit phase policy/);
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

test("human approval is a durable evidence-bound promotion and never a prompt assertion", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.phases[0].gate.requireHumanApproval = true;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const accepted: CampaignResult = { campaignId: "project-campaign", status: "complete", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 3 }, summary: "awaiting approval", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "d".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [{ evaluator: "fixture", version: "1", status: "pass", metrics: {}, violations: [], artifacts: [{ kind: "test-report", path: "evidence.json", sha256: "e".repeat(64) }] }] }] };
    let calls = 0;
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => { calls += 1; return accepted; } });
    assert.equal((await runner.run()).status, "blocked");
    const intent = (await runner.journal.read()).find((event) => event.type === "promotion-intent");
    assert.equal(intent?.resultingRevision, "d".repeat(40));
    const approval = await runner.approve("proof", "alex");
    assert.equal(approval.type, "promotion-applied");
    assert.equal(approval.actor.id, "alex");
    assert.equal((approval.data as Record<string, unknown>).promotionIntentSequence, intent?.sequence);
    assert.equal((await runner.run()).status, "complete");
    assert.equal(calls, 1, "approval must resume the verified promotion rather than rerun the campaign");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function v2Fixture(): Promise<{ root: string; manifestPath: string; specPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-project-v2-"));
  const campaign = (id: string) => ({ apiVersion: "gamefactory.dev/v1", id, objective: id, projectRoot: ".", workflow: "fixture", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } });
  await Promise.all([
    writeFile(join(root, "concept.md"), "A courier brews potions and walks them to villagers.", "utf8"),
    writeFile(join(root, "spec-campaign.json"), JSON.stringify(campaign("spec-campaign")), "utf8"),
    writeFile(join(root, "slice-campaign.json"), JSON.stringify({ ...campaign("slice-campaign"), parameters: { agentTeam: { graph: { nodes: [{ id: "builder", role: "implementer", permissions: "write", command: ["fixture"] }] } } } }), "utf8"),
    writeFile(join(root, "factory.json"), JSON.stringify({ apiVersion: "gamefactory.dev/v1", extensions: [] }), "utf8")
  ]);
  const manifestPath = join(root, "gamefactory.project.json");
  await writeFile(manifestPath, JSON.stringify({
    apiVersion: "gamefactory.dev/v2", kind: "Project", id: "v2-project", title: "V2", projectRoot: ".",
    preproduction: { concept: "concept.md", spec: "game-spec.json", maximumConvergencePasses: 3, attempts: [{ id: "spec-v1", campaign: "spec-campaign.json", config: "factory.json" }] },
    slices: [{ id: "first-errand", title: "First errand", order: 10, consumesClaims: ["loop.first-errand"], playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", mutablePaths: ["game/**"], attemptPolicy: { executionRetries: 2, creativeRepairs: 1, specAmendments: 1, advisorEscalations: 1 }, evidence: { scenarios: ["first-errand"], requireInteractionTrace: true, requireEmbodiedGameplay: true, requireEngineCapture: true, requireMotionEvidence: true }, attempts: [{ id: "slice-v1", campaign: "slice-campaign.json", config: "factory.json" }] }]
  }), "utf8");
  return { root, manifestPath, specPath: join(root, "game-spec.json") };
}

function acceptedResult(campaignId: string, revision: string, metadata?: Record<string, unknown>): CampaignResult {
  return { campaignId, status: "complete", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 1 }, summary: "accepted", experiments: [{ campaignId, runId: `${campaignId}-run`, experimentId: `${campaignId}-candidate`, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision, summary: "kept", metrics: { score: 1 }, evaluations: [], ...(metadata ? { metadata } : {}) }] };
}

function evidencedResult(campaign: Campaign, revision: string, evaluator = "godot.scenario", engineAuthority = false): CampaignResult {
  const scenarioSha = "e".repeat(64);
  const interactionSha = "f".repeat(64);
  const captureSha = "d".repeat(64);
  const targetSha = "a".repeat(64);
  const motionSha = "b".repeat(64);
  const embodiedSha = "c".repeat(64);
  const contract = campaign.parameters?.projectSlice as Record<string, unknown>;
  const result = acceptedResult(campaign.id, revision, { projectEvidence: {
    scenarios: [{ id: "first-errand", artifactSha256: scenarioSha }],
    interactionTrace: { artifactSha256: interactionSha },
    engineCapture: { artifactSha256: captureSha },
    targetSha256: { artifactSha256: targetSha },
    motionEvidence: { artifactSha256: motionSha },
    embodiedGameplay: { artifactSha256: embodiedSha },
    specRevision: contract.specRevision,
    specFingerprint: contract.specFingerprint
  } });
  const runtimeMetadata = engineAuthority ? { evidenceAuthority: "factory-engine", engine: "unity" } : {};
  result.experiments[0]!.agent = { summary: "real engine evidence", contributors: [], artifacts: [] };
  result.experiments[0]!.evaluations = [
    { evaluator, version: "1", status: "pass", metrics: {}, violations: [], artifacts: [
      { kind: "test-report", path: "evidence/first-errand-report.json", sha256: scenarioSha, metadata: { evidenceClass: "embodied-gameplay", verified: true, ...runtimeMetadata } },
      { kind: "replay", path: "evidence/first-errand-trace.json", sha256: interactionSha, metadata: { evidenceClass: "embodied-gameplay", verified: true, ...runtimeMetadata } },
      { kind: "test-report", path: "evidence/embodied-proof.json", sha256: embodiedSha, metadata: { evidenceClass: "embodied-gameplay", verified: true, ...runtimeMetadata } }
    ] },
    { evaluator, version: "1", status: "pass", metrics: {}, violations: [], artifacts: [
      { kind: "image", path: "evidence/current-engine.png", sha256: captureSha, metadata: runtimeMetadata },
      { kind: "video", path: "evidence/current-motion.mp4", sha256: motionSha, metadata: runtimeMetadata }
    ] },
    { evaluator: "design.system", version: "1", status: "pass", metrics: {}, violations: [], artifacts: [
      { kind: "image", path: "evidence/approved-target.png", sha256: targetSha }
    ] }
  ];
  return result;
}

test("v2 validates a frozen claim-addressed spec and advances player-complete slices", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = { apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "Walking, brewing, and delivery are one causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } };
    let calls = 0;
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      calls += 1;
      if (campaign.id === "spec-campaign") { await writeFile(specPath, JSON.stringify(spec), "utf8"); return acceptedResult(campaign.id, "a".repeat(40)); }
      const graph = ((campaign.parameters?.agentTeam as Record<string, unknown>).graph as Record<string, unknown>);
      assert.deepEqual(graph.claimIds, ["loop.first-errand"]);
      assert.equal(graph.enforceClaimedBlockers, true);
      assert.equal(graph.enforceWriteContracts, true);
      assert.deepEqual(graph.attemptPolicy, { executionRetries: 2, creativeRepairs: 1, advisorEscalations: 1 });
      assert.deepEqual(campaign.mutablePaths, ["game/**"]);
      assert.equal((campaign.parameters?.projectSlice as Record<string, unknown>).primaryRisk, "The game becomes a static menu.");
      return evidencedResult(campaign, "b".repeat(40));
    } });
    const result = await runner.run();
    assert.equal(result.status, "complete");
    assert.equal(calls, 2);
    assert.deepEqual(result.phases.map((phase) => phase.workKind), ["spec-convergence", "vertical-slice"]);
    const journey = await runner.journal.read();
    assert.deepEqual(journey.filter((event) => event.type === "spec-frozen" || event.type === "slice-completed").map((event) => event.type), ["spec-frozen", "slice-completed"]);
    const specData = journey.find((event) => event.type === "spec-frozen")?.data as Record<string, unknown>;
    assert.match(String(specData.specArchivePath), /specs[\\/]r0001-/);
    assert.match(await readFile(String(specData.specArchivePath), "utf8"), /"revision":1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 accepts engine-neutral trusted Unity evidence without hard-coded evaluator ids", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = { apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "Walking, brewing, and delivery are one causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } };
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      if (campaign.id === "spec-campaign") {
        await writeFile(specPath, JSON.stringify(spec), "utf8");
        return acceptedResult(campaign.id, "a".repeat(40));
      }
      return evidencedResult(campaign, "b".repeat(40), "unity.scenario", true);
    } });
    const result = await runner.run();
    assert.equal(result.status, "complete");
    assert.equal(result.phases.find((phase) => phase.phaseId === "first-errand")?.status, "complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 promotion-only budget policy does not invalidate the campaign execution contract", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.slices[0].gate = { requireAcceptedRevision: true, allowBudgetExhaustedAfterAcceptance: true };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const spec = { apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "Walking, brewing, and delivery are one causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } };
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      if (campaign.id === "spec-campaign") { await writeFile(specPath, JSON.stringify(spec), "utf8"); return acceptedResult(campaign.id, "a".repeat(40)); }
      assert.deepEqual((campaign.parameters?.projectSlice as Record<string, unknown>).gate, { requireAcceptedRevision: true });
      const result = evidencedResult(campaign, "b".repeat(40));
      const projectEvidence = result.experiments[0]!.metadata!.projectEvidence as Record<string, any>;
      const scenarioReference = projectEvidence.scenarios[0];
      const captureReference = projectEvidence.engineCapture;
      projectEvidence.embodiedGameplay = captureReference;
      projectEvidence.engineCapture = { artifactSha256: scenarioReference.artifactSha256, representativeFrames: [captureReference] };
      projectEvidence.motionEvidence = scenarioReference;
      result.status = "budget-exhausted";
      return result;
    } });
    assert.equal((await runner.run()).status, "complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an embodied core slice can require engine capture before any visual target exists", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = { apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "Walking, brewing, and delivery are one causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } };
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      if (campaign.id === "spec-campaign") { await writeFile(specPath, JSON.stringify(spec), "utf8"); return acceptedResult(campaign.id, "a".repeat(40)); }
      const result = evidencedResult(campaign, "b".repeat(40));
      const metadata = result.experiments[0]!.metadata!.projectEvidence as Record<string, unknown>;
      delete metadata.targetSha256;
      result.experiments[0]!.evaluations = result.experiments[0]!.evaluations.filter((evaluation) => evaluation.evaluator !== "design.system");
      return result;
    } });
    assert.equal((await runner.run()).status, "complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 fails closed when runtime slice evidence is missing", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "A causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "Complete an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } }), "utf8");
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => acceptedResult(campaign.id, campaign.id === "spec-campaign" ? "a".repeat(40) : "b".repeat(40)) });
    const result = await runner.run();
    assert.equal(result.status, "blocked");
    assert.match(result.phases.at(-1)?.reasons?.join(" ") ?? "", /interaction trace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 does not accept candidate-declared artifact kinds as engine evidence", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "A causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "Complete an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } }), "utf8");
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      if (campaign.id === "spec-campaign") return acceptedResult(campaign.id, "a".repeat(40));
      const contract = campaign.parameters?.projectSlice as Record<string, unknown>;
      const forgedSha = "f".repeat(64);
      const forged = acceptedResult(campaign.id, "b".repeat(40), { projectEvidence: {
        scenarios: [{ id: "first-errand", artifactSha256: forgedSha }],
        interactionTrace: { artifactSha256: forgedSha },
        engineCapture: { artifactSha256: forgedSha },
        targetSha256: { artifactSha256: forgedSha },
        motionEvidence: { artifactSha256: forgedSha },
        specRevision: contract.specRevision,
        specFingerprint: contract.specFingerprint
      } });
      forged.experiments[0]!.agent = { summary: "self-declared evidence", contributors: [], artifacts: [{ kind: "image", path: "candidate-authored.txt", sha256: forgedSha }, { kind: "replay", path: "candidate-authored.txt", sha256: forgedSha }] };
      return forged;
    } });
    const result = await runner.run();
    assert.equal(result.status, "blocked");
    assert.match(result.phases.at(-1)?.reasons?.join(" ") ?? "", /trusted real interaction trace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 rejects ordinary scenario reports when embodied gameplay proof is required", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "A causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "Complete an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } }), "utf8");
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      if (campaign.id === "spec-campaign") return acceptedResult(campaign.id, "a".repeat(40));
      const result = evidencedResult(campaign, "b".repeat(40));
      const embodied = result.experiments[0]!.evaluations.flatMap((evaluation) => evaluation.artifacts).filter((artifact) => artifact.metadata?.evidenceClass === "embodied-gameplay");
      assert.ok(embodied.length > 0);
      for (const artifact of embodied) delete artifact.metadata;
      return result;
    } });
    const result = await runner.run();
    assert.equal(result.status, "blocked");
    assert.match(result.phases.at(-1)?.reasons?.join(" ") ?? "", /evaluator-verified embodied gameplay/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("claim fingerprints ignore unrelated spec revisions but change with consumed claims", () => {
  const base = parseGameSpec({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "Concept", thesis: "Thesis", claims: [{ id: "loop.a", category: "loop", status: "required", statement: "A" }, { id: "visual.b", category: "visual", status: "required", statement: "B" }], slices: [{ id: "slice", playerOutcome: "Outcome", primaryRisk: "Risk", claimIds: ["loop.a"] }] });
  const unrelated = parseGameSpec({ ...base, revision: 2, claims: [base.claims[0]!, { ...base.claims[1]!, statement: "Changed B" }] });
  assert.equal(gameSpecFingerprint(base, ["loop.a"]), gameSpecFingerprint(unrelated, ["loop.a"]));
  const changed = parseGameSpec({ ...unrelated, claims: [{ ...base.claims[0]!, statement: "Changed A" }, unrelated.claims[1]!] });
  assert.notEqual(gameSpecFingerprint(base, ["loop.a"]), gameSpecFingerprint(changed, ["loop.a"]));
});

test("GameSpec amendments carry attributable evidence and validate their impact references", () => {
  const base = parseGameSpec({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "Concept", thesis: "Thesis", claims: [{ id: "loop.a", category: "loop", status: "required", statement: "A" }], slices: [{ id: "slice", playerOutcome: "Outcome", primaryRisk: "Risk", claimIds: ["loop.a"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } });
  const amended = parseGameSpec({ ...base, revision: 4, supersedes: { revision: 1, sha256: gameSpecFingerprint(base) }, change: { kind: "evidence-amendment", rationale: "The runtime trace falsified the original cadence.", evidence: ["trace:first-session"], affectedClaims: ["loop.a"], affectedSlices: ["slice"] } });
  assert.equal(amended.change?.kind, "evidence-amendment");
  assert.deepEqual(amended.change?.affectedSlices, ["slice"]);
  assert.throws(() => parseGameSpec({ ...amended, change: { ...amended.change, affectedClaims: ["invalid claim!"] } }), /unsupported characters/);
  assert.throws(() => parseGameSpec({ ...amended, supersedes: undefined }), /must identify the superseded revision/);
});

test("a frozen spec may retain open future claims while active slice claims must be resolved", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const concept = "A courier brews potions and walks them to villagers.";
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept, thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "open", statement: "The player completes an errand." }, { id: "future.social", category: "system", status: "open", statement: "Villagers may remember deliveries." }], slices: [{ id: "first-errand", playerOutcome: "Complete one errand.", primaryRisk: "Static menus.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } }), "utf8");
    const project = await loadProject(manifestPath);
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => acceptedResult(campaign.id, "a".repeat(40)) });
    await assert.rejects(() => runner.run(), /consumes unresolved GameSpec claims: loop.first-errand/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 accepts later evidence amendments and reuses a slice when only unrelated claims change", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = (revision: number, visualStatement: string) => ({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }, { id: "visual.identity", category: "visual", status: "required", statement: visualStatement }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }] });
    const initial = { ...spec(1, "Direction A"), change: { kind: "initial", rationale: "Initial bounded thesis." } };
    await writeFile(specPath, JSON.stringify(initial), "utf8");
    const first = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => campaign.id === "spec-campaign" ? acceptedResult(campaign.id, "a".repeat(40)) : evidencedResult(campaign, "b".repeat(40)) });
    assert.equal((await first.run()).status, "complete");
    const amended = { ...spec(4, "Direction B"), supersedes: { revision: 1, sha256: gameSpecFingerprint(parseGameSpec(initial)) }, change: { kind: "evidence-amendment", rationale: "Captured evidence requires a clearer visual direction.", evidence: ["capture:first-errand"], affectedClaims: ["visual.identity"] } };
    await writeFile(specPath, JSON.stringify(amended), "utf8");
    const calls: string[] = [];
    const second = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => { calls.push(campaign.id); return acceptedResult(campaign.id, "c".repeat(40)); } });
    const result = await second.run();
    assert.equal(result.status, "complete");
    assert.deepEqual(calls, ["spec-campaign"]);
    assert.equal(result.phases.find((phase) => phase.phaseId === "first-errand")?.reused, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 routes an evidence-backed slice failure through one bounded spec amendment", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const concept = "A courier brews potions and walks them to villagers.";
    const initial = parseGameSpec({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept, thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player completes an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } });
    const evidenceSha = "d".repeat(64);
    const calls: string[] = [];
    let specPass = 0;
    let slicePass = 0;
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      calls.push(campaign.id);
      if (campaign.id === "spec-campaign") {
        assert.equal(campaign.budget?.maximumExperiments, 3);
        specPass += 1;
        if (specPass === 1) await writeFile(specPath, JSON.stringify(initial), "utf8");
        else {
          assert.equal(((campaign.parameters?.projectSpec as Record<string, unknown>).amendment as Record<string, unknown>).kind, "spec-amendment");
          await writeFile(specPath, JSON.stringify({ ...initial, revision: 2, claims: [{ ...initial.claims[0]!, statement: "The player completes a short embodied errand with immediate movement feedback." }], supersedes: { revision: 1, sha256: gameSpecFingerprint(initial) }, change: { kind: "evidence-amendment", rationale: "The preserved trace showed the first loop was inert.", evidence: [evidenceSha], affectedClaims: ["loop.first-errand"], affectedSlices: ["first-errand"] } }), "utf8");
        }
        return acceptedResult(campaign.id, "a".repeat(40));
      }
      slicePass += 1;
      if (slicePass === 1) {
        const blocked = evidencedResult(campaign, "b".repeat(40));
        blocked.status = "blocked";
        blocked.experiments[0]!.metadata = { ...blocked.experiments[0]!.metadata, projectDisposition: { kind: "spec-amendment", rationale: "The embodied loop is inert in the preserved trace.", claimIds: ["loop.first-errand"], evidenceArtifactSha256: [evidenceSha] } };
        return blocked;
      }
      return evidencedResult(campaign, "c".repeat(40));
    } });
    const result = await runner.run();
    assert.equal(result.status, "complete");
    assert.deepEqual(calls, ["spec-campaign", "slice-campaign", "spec-campaign", "slice-campaign"]);
    const journey = await runner.journal.read();
    assert.equal(journey.filter((event) => event.type === "slice-invalidated").length, 1);
    assert.deepEqual(journey.filter((event) => event.type === "spec-frozen").map((event) => event.specRevision), [1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 reconstructs a pending amendment from the journal after a crash on the return edge", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const concept = "A courier brews potions and walks them to villagers.";
    const initial = parseGameSpec({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept, thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player completes an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } });
    const evidenceSha = "d".repeat(64);
    let specCalls = 0;
    let sliceCalls = 0;
    const execute = async ({ campaign }: { campaign: Campaign }): Promise<CampaignResult> => {
      if (campaign.id === "spec-campaign") {
        specCalls += 1;
        if (specCalls === 1) await writeFile(specPath, JSON.stringify(initial), "utf8");
        else if (specCalls === 2) throw new Error("simulated crash after invalidation");
        else {
          assert.equal(((campaign.parameters?.projectSpec as Record<string, unknown>).amendment as Record<string, unknown>).kind, "spec-amendment");
          await writeFile(specPath, JSON.stringify({ ...initial, revision: 2, claims: [{ ...initial.claims[0]!, statement: "The player completes an embodied errand." }], supersedes: { revision: 1, sha256: gameSpecFingerprint(initial) }, change: { kind: "evidence-amendment", rationale: "Runtime evidence required an embodied loop.", evidence: [evidenceSha], affectedClaims: ["loop.first-errand"], affectedSlices: ["first-errand"] } }), "utf8");
        }
        return acceptedResult(campaign.id, "a".repeat(40));
      }
      sliceCalls += 1;
      if (sliceCalls === 1) {
        const blocked = evidencedResult(campaign, "b".repeat(40));
        blocked.status = "blocked";
        blocked.experiments[0]!.metadata = { ...blocked.experiments[0]!.metadata, projectDisposition: { kind: "spec-amendment", rationale: "The preserved loop is inert.", claimIds: ["loop.first-errand"], evidenceArtifactSha256: [evidenceSha] } };
        return blocked;
      }
      return evidencedResult(campaign, "c".repeat(40));
    };
    const first = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: execute });
    await assert.rejects(() => first.run(), /simulated crash/);
    assert.equal((await first.journal.read()).filter((event) => event.type === "slice-invalidated").length, 1);
    const resumed = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: execute });
    assert.equal((await resumed.run()).status, "complete");
    assert.equal(specCalls, 3);
    assert.equal(sliceCalls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 invalidates slice reuse when its authority or non-goals change", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "Complete one errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }], change: { kind: "initial", rationale: "Initial bounded thesis." } }), "utf8");
    const first = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => campaign.id === "spec-campaign" ? acceptedResult(campaign.id, "a".repeat(40)) : evidencedResult(campaign, "b".repeat(40)) });
    assert.equal((await first.run()).status, "complete");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { slices: Array<Record<string, unknown>> };
    manifest.slices[0]!.mutablePaths = ["game/**", "assets/**"];
    manifest.slices[0]!.nonGoals = ["Do not add a meta loop."];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const calls: string[] = [];
    const second = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => { calls.push(campaign.id); return evidencedResult(campaign, "c".repeat(40)); } });
    assert.equal((await second.run()).status, "complete");
    assert.deepEqual(calls, ["slice-campaign"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
