import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { Campaign, EngineDriver, ScenarioRunner } from "@gamefactory/core";
import { automationArgs, embodiedProbeScriptPath, godotProcessSucceeded, GodotEvidenceAgent, GodotScenarioRunner, GodotVisualEvaluator, normalizeScenarioArtifacts, verifyEmbodiedScenarioArtifacts } from "./index.js";

test("Godot automation disables the interactive native crash handler", () => {
  assert.deepEqual(
    automationArgs(["--headless", "--editor", "--quit"]),
    ["--disable-crash-handler", "--headless", "--editor", "--quit"]
  );
});

test("Godot automation rejects exit-zero runs that contain engine errors", () => {
  assert.equal(godotProcessSucceeded({ exitCode: 0, stdout: "SCRIPT ERROR: null texture", stderr: "", timedOut: false }), false);
  assert.equal(godotProcessSucceeded({ exitCode: 0, stdout: "Godot Engine", stderr: "", timedOut: false }), true);
  assert.equal(godotProcessSucceeded({
    exitCode: 0,
    stdout: "Godot Engine",
    stderr: "ERROR: Failed to read the root certificate store.\n   at: get_system_ca_certificates (platform/windows/os_windows.cpp:2582)\n",
    timedOut: false
  }), true);
});

test("embodied campaigns use a factory-owned probe outside candidate projects", async () => {
  const path = embodiedProbeScriptPath();
  const source = await readFile(path, "utf8");
  assert.match(source, /factory-owned-godot-probe/);
  assert.match(source, /Input\.parse_input_event/);
  assert.doesNotMatch(path, /test-fixtures/);
});

test("embodied campaigns fail closed before Godot launch when probe configuration is absent", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-probe-config-"));
  try {
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "probe-config-test",
      objective: "prove embodied play",
      projectRoot: root,
      workflow: "autoresearch",
      requires: [],
      mutablePaths: ["**"],
      acceptance: { primaryMetric: "embodied_proof", direction: "maximize" },
      parameters: { godot: { embodiedProof: {}, scenario: { path: "res://main.tscn" } } }
    };
    const result = await new GodotScenarioRunner().run({
      campaign,
      projectRoot: root,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "probe-config",
      scenario: { provider: "godot.factory/v1", version: "1", path: "res://main.tscn" },
      signal: new AbortController().signal
    });
    assert.equal(result.status, "fail");
    assert.equal(result.violations[0]?.code, "godot.embodied.probe-config");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("embodied campaigns reject unresolved probe template bindings before engine work", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-probe-placeholder-"));
  try {
    const engine: EngineDriver = {
      id: "fixture.engine",
      async doctor() { return { ok: true, checks: [] }; },
      async build() { throw new Error("engine must not run with unresolved probe bindings"); }
    };
    const scenarios: ScenarioRunner = {
      id: "fixture.scenario",
      async run() { throw new Error("scenario must not run with unresolved probe bindings"); }
    };
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "probe-placeholder-test",
      objective: "fail before expensive work",
      projectRoot: root,
      workflow: "autoresearch",
      requires: [],
      mutablePaths: ["**"],
      acceptance: { primaryMetric: "embodied_proof", direction: "maximize" },
      parameters: { godot: {
        embodiedProof: {},
        embodiedProbe: {
          actorPath: "__REPLACE_WITH_RUNTIME_ACTOR_NODE_PATH__",
          stateObservations: [{ id: "state", nodePath: "Target", property: "active" }],
          steps: [{ action: "interact", kind: "action", pressed: true, frames: 1 }]
        }
      } }
    };
    await assert.rejects(() => new GodotEvidenceAgent(engine, scenarios).run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "placeholder",
      history: [],
      signal: new AbortController().signal
    }), /unresolved __REPLACE_\*__ template values/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("factory-owned probe drives a real Godot scene through its shipping InputMap", { skip: !process.env.GODOT_BINARY }, async () => {
  const projectRoot = resolve("extensions", "godot", "test-fixtures", "embodied-probe");
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "probe-smoke-test",
    objective: "drive a visible actor into a spatial consequence",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["**"],
    acceptance: { primaryMetric: "embodied_proof", direction: "maximize" },
    parameters: { godot: {
      binary: process.env.GODOT_BINARY,
      rendered: true,
      timeoutSeconds: 30,
      embodiedProof: {
        minimumDurationSeconds: 2,
        minimumShippingInputEvents: 4,
        minimumDisplacementPixels: 120,
        minimumSpatialInteractions: 1,
        minimumStateConsequences: 1,
        minimumDistinctFrames: 3
      }
    } }
  };
  const result = await new GodotScenarioRunner().run({
    campaign,
    projectRoot,
    candidate: { id: "fixture", root: projectRoot, metadata: {} },
    experimentId: "probe-smoke",
    scenario: {
      provider: "godot.factory/v1",
      version: "1",
      path: "res://main.tscn",
      parameters: { physics_hz: 60, embodiedProbe: {
        actorPath: "Player",
        targetPath: "Target",
        interactionAction: "interact",
        interactionRange: 24,
        captureEveryFrames: 20,
        stateObservations: [{ id: "activated", nodePath: "Target", property: "activated", state: "target-activated" }],
        steps: [
          { action: "move_right", kind: "axis", pressed: true, frames: 120 },
          { action: "move_right", kind: "axis", pressed: false, frames: 1 },
          { action: "interact", kind: "action", pressed: true, frames: 2 },
          { action: "interact", kind: "action", pressed: false, frames: 10 }
        ]
      } }
    },
    signal: new AbortController().signal
  });
  assert.equal(result.status, "pass", JSON.stringify(result.violations));
  assert.equal(result.metrics.embodied_proof, 1);
  assert.ok(result.artifacts.some((artifact) => artifact.metadata?.producer === "factory-owned-godot-probe"));
});

test("factory-owned probe supports a distinct trusted target for each interaction step", async () => {
  const source = await readFile(embodiedProbeScriptPath(), "utf8");
  assert.match(source, /step\.get\("targetPath", default_target_path\)/);
  assert.match(source, /subject\.get_node_or_null\(NodePath\(target_path\)\)/);
});

test("Godot scenario artifacts normalize candidate-defined kinds before crossing adapter boundaries", async () => {
  const normalized = await normalizeScenarioArtifacts([{
    kind: "gameplay-evidence",
    path: "evidence/gameplay.json",
    mediaType: "application/json",
    label: "Causal gameplay trace"
  }]);
  assert.deepEqual(normalized.artifacts, [{
    kind: "other",
    path: "evidence/gameplay.json",
    mediaType: "application/json",
    label: "Causal gameplay trace",
    metadata: { declaredKind: "gameplay-evidence" }
  }]);
  assert.equal(normalized.violations[0]?.severity, "warning");
});

test("Godot scenario artifacts cannot escape the factory-owned output directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-artifact-root-"));
  try {
    const output = resolve(root, "scenario");
    await mkdir(output);
    const outside = resolve(root, "host-secret.txt");
    await writeFile(outside, "secret", "utf8");
    const normalized = await normalizeScenarioArtifacts([{ kind: "test-report", path: outside }], output);
    assert.equal(normalized.artifacts.length, 0);
    assert.equal(normalized.violations[0]?.code, "godot.artifact.0.containment");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("embodied proof requires shipping InputEvents, visible displacement, spatial interaction, consequence, and changing engine frames", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-embodied-"));
  try {
    const tracePath = resolve(root, "trace.json");
    const frames = [0, 1, 2].map((index) => resolve(root, `frame-${index}.png`));
    await writeFile(tracePath, JSON.stringify({
      apiVersion: "gamefactory.embodied-trace/v1",
      samples: [
        { time: 0, input: { delivery: "godot-input-event", kind: "axis", action: "move_right" }, actor: { id: "player", visible: true, position: { x: 10, y: 20 } }, events: [] },
        { time: 1, input: { delivery: "godot-input-event", kind: "axis", action: "move_right" }, actor: { id: "player", visible: true, position: { x: 30, y: 20 } }, events: [] },
        { time: 2, input: { delivery: "godot-input-event", kind: "action", action: "interact" }, actor: { id: "player", visible: true, position: { x: 34, y: 20 } }, events: [
          { kind: "spatial-interaction", targetId: "villager", distance: 8, range: 12, outcome: "applied" },
          { kind: "state-change", cause: "player-input", state: "delivery-complete" }
        ] }
      ]
    }), "utf8");
    await Promise.all(frames.map((path, index) => writeFile(path, png(32, 32, index + 1))));
    const artifacts = [
      { kind: "replay" as const, path: tracePath, metadata: { protocol: "gamefactory.embodied-trace/v1" } },
      ...frames.map((path) => ({ kind: "image" as const, path, metadata: { evidenceRole: "continuous-frame" } }))
    ];
    const result = await verifyEmbodiedScenarioArtifacts(artifacts, {
      minimumDurationSeconds: 2,
      minimumShippingInputEvents: 3,
      minimumDisplacementPixels: 20,
      minimumSpatialInteractions: 1,
      minimumStateConsequences: 1,
      minimumDistinctFrames: 3
    });
    assert.equal(result.verified, true);
    assert.equal(result.metrics.embodied_proof, 1);
    assert.equal(result.metrics.embodied_displacement_pixels, 24);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("embodied proof rejects direct function replay over a static plate", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-static-"));
  try {
    const tracePath = resolve(root, "trace.json");
    const still = resolve(root, "still.png");
    await writeFile(tracePath, JSON.stringify({
      apiVersion: "gamefactory.embodied-trace/v1",
      samples: [
        { time: 0, input: { delivery: "direct-call", kind: "axis" }, actor: { visible: false, position: { x: 0, y: 0 } }, events: [] },
        { time: 2, input: { delivery: "direct-call", kind: "action" }, actor: { visible: false, position: { x: 40, y: 0 } }, events: [] }
      ]
    }), "utf8");
    await writeFile(still, png(32, 32, 9));
    const result = await verifyEmbodiedScenarioArtifacts([
      { kind: "replay", path: tracePath, metadata: { protocol: "gamefactory.embodied-trace/v1" } },
      { kind: "image", path: still, metadata: { evidenceRole: "continuous-frame" } },
      { kind: "image", path: still, metadata: { evidenceRole: "continuous-frame" } }
    ], {
      minimumDurationSeconds: 1,
      minimumShippingInputEvents: 2,
      minimumDisplacementPixels: 12,
      minimumSpatialInteractions: 1,
      minimumStateConsequences: 1,
      minimumDistinctFrames: 2
    });
    assert.equal(result.verified, false);
    assert.ok(result.violations.some((violation) => violation.code === "godot.embodied.shipping-input"));
    assert.ok(result.violations.some((violation) => violation.code === "godot.embodied.actor-visible"));
    assert.ok(result.violations.some((violation) => violation.code === "godot.embodied.visible-motion"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("factory-owned embodied verification rejects a candidate-authored producer claim mismatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-untrusted-probe-"));
  try {
    const tracePath = resolve(root, "trace.json");
    await writeFile(tracePath, JSON.stringify({
      apiVersion: "gamefactory.embodied-trace/v1",
      producer: "candidate",
      samples: [{ time: 0 }, { time: 1 }]
    }), "utf8");
    const result = await verifyEmbodiedScenarioArtifacts([{
      kind: "replay",
      path: tracePath,
      metadata: { protocol: "gamefactory.embodied-trace/v1", producer: "candidate" }
    }], {
      minimumDurationSeconds: 0,
      minimumShippingInputEvents: 1,
      minimumDisplacementPixels: 0,
      minimumSpatialInteractions: 1,
      minimumStateConsequences: 1,
      minimumDistinctFrames: 2
    }, "factory-owned-godot-probe");
    assert.equal(result.verified, false);
    assert.equal(result.violations[0]?.code, "godot.embodied.untrusted-producer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Godot evidence agent refreshes deterministic engine evidence for read-only reviewers", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-evidence-"));
  try {
    const engine: EngineDriver = {
      id: "fixture.engine",
      async doctor() { return { ok: true, checks: [] }; },
      async build() { return { ok: true, exitCode: 0, stdout: "", stderr: "", artifacts: [], metrics: { import_ok: 1 } }; }
    };
    const scenarios: ScenarioRunner = {
      id: "fixture.scenario",
      async run() {
        return { status: "pass", metrics: { mechanic_proven: 1, events: 11 }, artifacts: [], violations: [] };
      }
    };
    const value: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "evidence-test",
      objective: "prove the mechanic",
      projectRoot: root,
      workflow: "tournament",
      requires: [],
      mutablePaths: ["**"],
      acceptance: { primaryMetric: "mechanic_proven", direction: "maximize" },
      parameters: { godot: { importCheck: true, scenario: { provider: "godot.factory/v1", version: "1", path: "res://main.tscn" } } }
    };
    const result = await new GodotEvidenceAgent(engine, scenarios).run({
      campaign: value,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-evidence",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(result.metadata?.outcome, "pass");
    assert.deepEqual(result.metadata?.metrics, { import_ok: 1, mechanic_proven: 1, events: 11 });
    const manifest = result.artifacts?.find((artifact) => artifact.label === "Fresh Godot evidence manifest");
    assert.ok(manifest);
    const stored = JSON.parse(await readFile(manifest.path, "utf8")) as Record<string, unknown>;
    assert.equal(stored.status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot evidence agent keeps clean-start and returning-player scenarios distinct", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-multi-evidence-"));
  try {
    const engine: EngineDriver = {
      id: "fixture.engine",
      async doctor() { return { ok: true, checks: [] }; },
      async build() { return { ok: true, exitCode: 0, stdout: "", stderr: "", artifacts: [], metrics: { import_ok: 1 } }; }
    };
    const calls: Array<{ experimentId: string; mode: unknown }> = [];
    const scenarios: ScenarioRunner = {
      id: "fixture.scenario",
      async run(input) {
        const mode = input.scenario.parameters?.mode;
        calls.push({ experimentId: input.experimentId, mode });
        return mode === "first-session"
          ? { status: "pass", metrics: { first_session_complete: 1, consequential_choices: 3 }, artifacts: [], violations: [] }
          : { status: "pass", metrics: { offline_contract: 1, causal_events: 9 }, artifacts: [], violations: [] };
      }
    };
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "multi-evidence-test",
      objective: "prove the opening and return loops separately",
      projectRoot: root,
      workflow: "tournament",
      requires: [],
      mutablePaths: ["**"],
      acceptance: { primaryMetric: "first-session.first_session_complete", direction: "maximize" },
      parameters: { godot: { importCheck: true, scenarios: [
        { id: "first-session", provider: "godot.factory/v1", version: "1", path: "res://main.tscn", parameters: { mode: "first-session" } },
        { id: "returning-player", provider: "godot.factory/v1", version: "1", path: "res://main.tscn", parameters: { mode: "returning-player" } }
      ] } }
    };
    const result = await new GodotEvidenceAgent(engine, scenarios).run({
      campaign,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-evidence",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(result.metadata?.outcome, "pass");
    assert.deepEqual(result.metadata?.metrics, {
      import_ok: 1,
      "first-session.first_session_complete": 1,
      first_session_complete: 1,
      "first-session.consequential_choices": 3,
      consequential_choices: 3,
      "returning-player.offline_contract": 1,
      "returning-player.causal_events": 9,
      scenarios_total: 2,
      scenarios_passed: 2
    });
    assert.deepEqual(calls, [
      { experimentId: "exp-evidence-first-session", mode: "first-session" },
      { experimentId: "exp-evidence-returning-player", mode: "returning-player" }
    ]);
    const manifest = result.artifacts?.find((artifact) => artifact.label === "Fresh Godot evidence manifest");
    assert.ok(manifest);
    const stored = JSON.parse(await readFile(manifest.path, "utf8")) as { scenarios: unknown[] };
    assert.equal(stored.scenarios.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function png(width: number, height: number, marker: number): Buffer {
  const bytes = Buffer.alloc(32, marker);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function campaign(root: string, baselineSha256?: string): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "visual-evidence-test",
    objective: "verify rendered visual evidence",
    projectRoot: root,
    workflow: "tournament",
    requires: [],
    mutablePaths: ["**"],
    acceptance: { primaryMetric: "score", direction: "maximize" },
    parameters: {
      godot: {
        visualReview: {
          reviewNode: "visual-critic",
          minimumScore: 70,
          minimumDimensionScore: 55,
          minimumWidth: 960,
          minimumHeight: 600,
          requiredDimensions: ["material_depth", "focal_hierarchy"],
          requiredViews: [
            { id: "title", path: ".factory/previews/title.png", ...(baselineSha256 ? { baselineSha256 } : {}) },
            { id: "puzzle", path: ".factory/previews/puzzle.png" }
          ],
          requiredSequences: [
            { id: "tower-fire", paths: [".factory/previews/motion-000.png", ".factory/previews/motion-001.png", ".factory/previews/motion-002.png"] }
          ]
        }
      }
    }
  };
}

async function fixture(): Promise<{ root: string; title: Buffer }> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-visual-"));
  const preview = resolve(root, ".factory", "previews");
  const review = resolve(root, ".factory", "agent-team", "exp-visual", "graph", "visual-critic", "attempt-2");
  await Promise.all([mkdir(preview, { recursive: true }), mkdir(review, { recursive: true })]);
  const title = png(1152, 720, 1);
  await Promise.all([
    writeFile(resolve(preview, "title.png"), title),
    writeFile(resolve(preview, "puzzle.png"), png(1152, 720, 2)),
    writeFile(resolve(preview, "motion-000.png"), png(1152, 720, 3)),
    writeFile(resolve(preview, "motion-001.png"), png(1152, 720, 4)),
    writeFile(resolve(preview, "motion-002.png"), png(1152, 720, 5)),
    writeFile(resolve(review, "output.json"), `${JSON.stringify({
      summary: "rendered views clear the visual bar",
      outcome: "pass",
      findings: {
        scorecard: { material_depth: 80, focal_hierarchy: 76 },
        evidence: [
          { view: "title", path: ".factory/previews/title.png", observation: "Layered hardware and rope create clear depth." },
          { view: "puzzle", path: ".factory/previews/puzzle.png", observation: "Contrast directs attention to the active rope crossing." },
          { sequence: "tower-fire", observation: "Three distinct frames show anticipation, projectile travel, and impact." }
        ]
      }
    }, null, 2)}\n`, "utf8")
  ]);
  return { root, title };
}

test("Godot visual evaluator gates candidates using semantic scores and rendered PNG evidence", async () => {
  const { root } = await fixture();
  try {
    const result = await new GodotVisualEvaluator().evaluate({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-visual",
      priorEvaluations: [],
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.visual_quality, 78);
    assert.equal(result.artifacts.filter((artifact) => artifact.kind === "image").length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot visual evaluator accepts keyed semantic evidence from model critics", async () => {
  const { root } = await fixture();
  try {
    const review = resolve(root, ".factory", "agent-team", "exp-visual", "graph", "visual-critic", "attempt-2", "output.json");
    await writeFile(review, `${JSON.stringify({
      summary: "rendered views clear the visual bar",
      outcome: "pass",
      findings: {
        scorecard: { material_depth: 80, focal_hierarchy: 76 },
        evidence: {
          title: { path: ".factory/previews/title.png", finding: "Layered hardware and rope create clear depth." },
          puzzle: { path: ".factory/previews/puzzle.png", finding: "Contrast directs attention to the active rope crossing." },
          "tower-fire": { paths: [".factory/previews/motion-000.png", ".factory/previews/motion-001.png", ".factory/previews/motion-002.png"], finding: "The sequence shows anticipation, travel, and impact." }
        }
      }
    }, null, 2)}\n`, "utf8");
    const result = await new GodotVisualEvaluator().evaluate({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-visual",
      priorEvaluations: [],
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.visual_quality, 78);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot visual evaluator accepts trusted Gemini graph output without a duplicate art-director schema", async () => {
  const { root } = await fixture();
  try {
    const value = campaign(root);
    const godot = value.parameters!.godot as Record<string, unknown>;
    const visualReview = godot.visualReview as Record<string, unknown>;
    visualReview.requiredDimensions = ["gameplayLegibility", "focalHierarchy"];
    const reviewPath = resolve(root, ".factory", "agent-team", "exp-visual", "graph", "visual-critic", "attempt-2", "output.json");
    await writeFile(reviewPath, `${JSON.stringify({
      summary: "Gemini reviewed the current post-integration engine sequence.",
      outcome: "pass",
      verdict: "pass",
      scores: { gameplayLegibility: 82, focalHierarchy: 78 },
      findings: [],
      evidence: [{ id: "runtime-image-001", role: "runtime", kind: "image", label: "Factory-owned Godot frame" }]
    }, null, 2)}\n`, "utf8");
    const result = await new GodotVisualEvaluator().evaluate({
      campaign: value,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-visual",
      priorEvaluations: [],
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.visual_quality, 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot visual evaluator rejects a static frame sequence presented as motion", async () => {
  const { root } = await fixture();
  try {
    const still = png(1152, 720, 9);
    await Promise.all([0, 1, 2].map((frame) => writeFile(resolve(root, ".factory", "previews", `motion-00${frame}.png`), still)));
    const result = await new GodotVisualEvaluator().evaluate({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-visual",
      priorEvaluations: [],
      signal: new AbortController().signal
    });
    assert.equal(result.status, "fail");
    assert.ok(result.violations.some((violation) => violation.code === "godot.visual.sequence.tower-fire.motion"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot visual evaluator fails closed on malformed sequence configuration", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-config-"));
  try {
    const value = campaign(root);
    const godot = value.parameters!.godot as Record<string, unknown>;
    const review = godot.visualReview as Record<string, unknown>;
    review.requiredSequences = [{ id: "bad", paths: ["same.png", "same.png"] }];
    await assert.rejects(() => new GodotVisualEvaluator().evaluate({
      campaign: value,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-invalid-sequence",
      priorEvaluations: [],
      signal: new AbortController().signal
    }), /requiredSequences contains an invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Godot visual evaluator rejects a polished claim backed by an unchanged baseline", async () => {
  const { root, title } = await fixture();
  try {
    const baseline = createHash("sha256").update(title).digest("hex");
    const result = await new GodotVisualEvaluator().evaluate({
      campaign: campaign(root, baseline),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-visual",
      priorEvaluations: [],
      signal: new AbortController().signal
    });
    assert.equal(result.status, "fail");
    assert.ok(result.violations.some((violation) => violation.code === "godot.visual.unchanged.title"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
