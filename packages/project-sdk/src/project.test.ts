import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryLogger, type CampaignResult } from "@gamefactory/core";
import { ProjectJourneyJournal } from "./journal.js";
import { loadProject } from "./manifest.js";
import { ProjectRunner } from "./runner.js";
import { gameSpecFingerprint, parseGameSpec } from "./spec.js";
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

test("project runner advances a successful bounded campaign after its experiment budget is consumed", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const project = await loadProject(manifestPath);
    const result: CampaignResult = { campaignId: "project-campaign", status: "budget-exhausted", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 3 }, summary: "accepted before bounded search ended", experiments: [{ campaignId: "project-campaign", runId: "run", experimentId: "candidate", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision: "c".repeat(40), summary: "kept", metrics: { score: 3 }, evaluations: [] }] };
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async () => result });
    const run = await runner.run();
    assert.equal(run.status, "complete");
    assert.equal(run.phases[0]?.acceptedRevision, "c".repeat(40));
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
    slices: [{ id: "first-errand", title: "First errand", order: 10, consumesClaims: ["loop.first-errand"], playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", attemptPolicy: { executionRetries: 2, creativeRepairs: 1, advisorEscalations: 1 }, evidence: { scenarios: ["first-errand"], requireInteractionTrace: true, requireEngineCapture: true, requireMotionEvidence: true }, attempts: [{ id: "slice-v1", campaign: "slice-campaign.json", config: "factory.json" }] }]
  }), "utf8");
  return { root, manifestPath, specPath: join(root, "game-spec.json") };
}

function acceptedResult(campaignId: string, revision: string, metadata?: Record<string, unknown>): CampaignResult {
  return { campaignId, status: "complete", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", bestMetrics: { score: 1 }, summary: "accepted", experiments: [{ campaignId, runId: `${campaignId}-run`, experimentId: `${campaignId}-candidate`, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "keep", revision, summary: "kept", metrics: { score: 1 }, evaluations: [], ...(metadata ? { metadata } : {}) }] };
}

test("v2 validates a frozen claim-addressed spec and advances player-complete slices", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = { apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "Walking, brewing, and delivery are one causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }] };
    let calls = 0;
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => {
      calls += 1;
      if (campaign.id === "spec-campaign") { await writeFile(specPath, JSON.stringify(spec), "utf8"); return acceptedResult(campaign.id, "a".repeat(40)); }
      const graph = ((campaign.parameters?.agentTeam as Record<string, unknown>).graph as Record<string, unknown>);
      assert.deepEqual(graph.claimIds, ["loop.first-errand"]);
      assert.equal(graph.enforceClaimedBlockers, true);
      assert.deepEqual(graph.attemptPolicy, { executionRetries: 2, creativeRepairs: 1, advisorEscalations: 1 });
      return acceptedResult(campaign.id, "b".repeat(40), { projectEvidence: { scenarios: ["first-errand"], interactionTrace: true, engineCapture: true, motionEvidence: true } });
    } });
    const result = await runner.run();
    assert.equal(result.status, "complete");
    assert.equal(calls, 2);
    assert.deepEqual(result.phases.map((phase) => phase.workKind), ["spec-convergence", "vertical-slice"]);
    assert.deepEqual((await runner.journal.read()).filter((event) => event.type === "spec-frozen" || event.type === "slice-completed").map((event) => event.type), ["spec-frozen", "slice-completed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 fails closed when runtime slice evidence is missing", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "A causal loop.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "Complete an errand." }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "Static menus.", claimIds: ["loop.first-errand"] }] }), "utf8");
    const runner = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => acceptedResult(campaign.id, campaign.id === "spec-campaign" ? "a".repeat(40) : "b".repeat(40)) });
    const result = await runner.run();
    assert.equal(result.status, "blocked");
    assert.match(result.phases.at(-1)?.reasons?.join(" ") ?? "", /interaction trace/);
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
    await writeFile(specPath, JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision: 1, status: "frozen", concept, thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "open", statement: "The player completes an errand." }, { id: "future.social", category: "system", status: "open", statement: "Villagers may remember deliveries." }], slices: [{ id: "first-errand", playerOutcome: "Complete one errand.", primaryRisk: "Static menus.", claimIds: ["loop.first-errand"] }] }), "utf8");
    const project = await loadProject(manifestPath);
    const runner = new ProjectRunner(project, { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => acceptedResult(campaign.id, "a".repeat(40)) });
    await assert.rejects(() => runner.run(), /consumes unresolved GameSpec claims: loop.first-errand/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 accepts later evidence amendments and reuses a slice when only unrelated claims change", async () => {
  const { root, manifestPath, specPath } = await v2Fixture();
  try {
    const spec = (revision: number, visualStatement: string) => ({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "v2-project", revision, status: "frozen", concept: "A courier brews potions and walks them to villagers.", thesis: "One causal errand.", claims: [{ id: "loop.first-errand", category: "loop", status: "required", statement: "The player walks, brews, and delivers one potion." }, { id: "visual.identity", category: "visual", status: "required", statement: visualStatement }], slices: [{ id: "first-errand", playerOutcome: "Complete one delivery through direct world interaction.", primaryRisk: "The game becomes a static menu.", claimIds: ["loop.first-errand"] }] });
    const initial = spec(1, "Direction A");
    await writeFile(specPath, JSON.stringify(initial), "utf8");
    const first = new ProjectRunner(await loadProject(manifestPath), { cwd: root, logger: new MemoryLogger(), executeCampaign: async ({ campaign }) => campaign.id === "spec-campaign" ? acceptedResult(campaign.id, "a".repeat(40)) : acceptedResult(campaign.id, "b".repeat(40), { projectEvidence: { scenarios: ["first-errand"], interactionTrace: true, engineCapture: true, motionEvidence: true } }) });
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
