import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { designIntentSha256, parseDesignIntent } from "@gamefactory/design-sdk";
import type { Campaign, Candidate, EngineDriver, ScenarioRunner } from "@gamefactory/core";
import { AgentPlaytestEvaluator, DesignIntentEvaluator, DesignSystemEvaluator, HumanPlaytestEvaluator } from "./index.js";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function intentFixture() {
  return {
    apiVersion: "gamefactory.design/v1",
    id: "cohort-fixture",
    version: "1.0.0",
    title: "Cohort fixture",
    audience: { description: "testers", needs: ["clarity"], exclusions: [] },
    playerExperience: { fantasy: "move with intent", emotions: ["focus"], pillars: [{ id: "clarity", statement: "Readable choices", priority: 1 }], antiPillars: [] },
    coreLoop: { verbs: ["move"], description: "Move and collect", sessionLengthMinutes: [1, 2] },
    hypotheses: [],
    playtests: {
      provider: "fixture/v1",
      version: "1",
      path: "fixture.scene",
      personas: [
        { id: "novice", label: "Novice", description: "Learns slowly", goals: ["survive"], behaviors: ["hesitate"], kind: "scripted", parameters: { skill: 0 } },
        { id: "expert", label: "Expert", description: "Plays efficiently", goals: ["score"], behaviors: ["optimize"], kind: "scripted", parameters: { skill: 1 } }
      ],
      scenarios: [{ id: "short", label: "Short", parameters: { ticks: 60 } }],
      seeds: [1, 2],
      concurrency: 2,
      metrics: [
        { metric: "completion", aggregate: "mean", weight: 1, min: 1, hard: true },
        { metric: "score", aggregate: "mean", weight: 1, min: 5 }
      ]
    },
    constraints: { accessibility: [], performance: [], platforms: ["test"] },
    unknowns: []
  };
}

test("design intent and agent cohort evaluators verify intent and aggregate persona runs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-design-lab-"));
  try {
    const rawIntent = intentFixture();
    const parsed = parseDesignIntent(rawIntent);
    await writeFile(resolve(root, "design.intent.json"), `${JSON.stringify(rawIntent, null, 2)}\n`, "utf8");
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "design-lab-test",
      objective: "test cohorts",
      projectRoot: root,
      workflow: "autoresearch",
      requires: [],
      parameters: {
        design: { intent: { path: "design.intent.json", id: parsed.id, version: parsed.version, sha256: designIntentSha256(parsed) } },
        playtest: { importCheck: true, maximumRuns: 8, humanReportPath: "human-playtest.json", humanSubjectId: "fixture-build" }
      },
      acceptance: { primaryMetric: "score.mean", direction: "maximize" }
    };
    const candidate: Candidate = { id: "candidate", root, metadata: {} };
    let active = 0;
    let maximumActive = 0;
    const runner: ScenarioRunner = {
      id: "fixture.runner",
      async run(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        active -= 1;
        const skill = Number(input.scenario.parameters?.skill ?? 0);
        const seed = Number(input.scenario.parameters?.seed ?? 0);
        return { status: "pass", metrics: { completion: 1, score: 5 + skill * 3 + seed }, artifacts: [], violations: [] };
      }
    };
    const engine: EngineDriver = {
      id: "fixture.engine",
      async doctor() { return { ok: true, checks: [] }; },
      async build() { return { ok: true, exitCode: 0, stdout: "", stderr: "", artifacts: [], metrics: { import_ok: 1 } }; }
    };
    const signal = new AbortController().signal;
    const intentEvaluation = await new DesignIntentEvaluator().evaluate({ campaign, candidate, experimentId: "fixture", priorEvaluations: [], signal });
    assert.equal(intentEvaluation.status, "pass");
    const evaluation = await new AgentPlaytestEvaluator(() => runner, () => engine).evaluate({ campaign, candidate, experimentId: "fixture", priorEvaluations: [intentEvaluation], signal });
    assert.equal(evaluation.status, "pass");
    assert.equal(evaluation.metrics.planned_runs, 4);
    assert.equal(evaluation.metrics["score.mean"], 8);
    assert.equal(evaluation.metrics["persona.novice.score.mean"], 6.5);
    assert.equal(evaluation.metrics["persona.expert.score.mean"], 9.5);
    assert.equal(maximumActive, 2);
    const report = JSON.parse(await readFile(resolve(root, ".factory/runs/fixture/agent-playtest/report.json"), "utf8"));
    assert.equal(report.synthetic, true);
    assert.equal(report.runs.length, 4);

    const awaitingHuman = await new HumanPlaytestEvaluator().evaluate({ campaign, candidate, experimentId: "fixture", priorEvaluations: [intentEvaluation, evaluation], signal });
    assert.equal(awaitingHuman.status, "inconclusive");
    assert.equal(awaitingHuman.metrics.human_approval, 0);

    await writeFile(resolve(root, "human-playtest.json"), `${JSON.stringify({
      apiVersion: "gamefactory.human-playtest/v1",
      id: "fixture-study",
      conductedAt: "2026-08-11T00:00:00.000Z",
      designIntent: { id: parsed.id, version: parsed.version, sha256: designIntentSha256(parsed) },
      subject: { id: "fixture-build" },
      study: { method: "moderated", participantCount: 5, audienceMatch: 0.8, consentConfirmed: true, containsPersonalData: false },
      findings: [{ id: "minor", severity: "concern", observation: "One participant hesitated", evidence: ["observer note"], pillarIds: ["clarity"] }],
      decision: { status: "approve", rationale: "Intent met with a minor onboarding concern", decidedBy: "fixture-researcher" }
    }, null, 2)}\n`, "utf8");
    const human = await new HumanPlaytestEvaluator().evaluate({ campaign, candidate, experimentId: "fixture", priorEvaluations: [intentEvaluation, evaluation], signal });
    assert.equal(human.status, "pass");
    assert.equal(human.metrics.human_approval, 1);
    assert.equal(human.metrics.participant_count, 5);
    assert.ok(human.violations.some((violation) => violation.severity === "warning"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("design system evaluator verifies ImageGen provenance and pinned candidate files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-design-system-"));
  try {
    await mkdir(resolve(root, "design/references"), { recursive: true });
    await mkdir(resolve(root, "design/theme"), { recursive: true });
    const reference = Buffer.from("fixture image bytes");
    const theme = "[gd_resource type=\"Theme\" format=3]\n";
    await writeFile(resolve(root, "design/references/material.png"), reference);
    await writeFile(resolve(root, "design/theme/game.tres"), theme, "utf8");
    await writeFile(resolve(root, "design-system.json"), `${JSON.stringify({
      apiVersion: "gamefactory.design-system/v1",
      id: "fixture-system",
      version: "1.0.0",
      title: "Fixture system",
      maturity: "direction",
      identity: { intent: "A legible tactile system", toneWords: ["tactile"], avoidWords: ["generic"] },
      principles: [{ id: "clarity", statement: "Clarity before ornament", rationale: "Interaction must read", priority: 1 }],
      tokens: { color: { primary: "#ffffff" }, motion: { settleSeconds: 0.2 } },
      patterns: [],
      references: [{ path: "design/references/material.png", role: "Material study", purpose: "material", authority: "inspiration", source: "imagegen", sha256: sha256(reference), prompt: "A tactile material study" }],
      implementations: [{ id: "godot-theme", adapter: "godot-theme", path: "design/theme/game.tres", sha256: sha256(theme) }]
    }, null, 2)}\n`, "utf8");
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "design-system-test",
      objective: "verify a candidate design system",
      projectRoot: root,
      workflow: "tournament",
      requires: [],
      parameters: { designSystem: { path: "design-system.json", requiredTokenGroups: ["color", "motion"], requiredAdapters: ["godot-theme"], minimumReferences: 1, requireImagegenReference: true } },
      acceptance: { primaryMetric: "design_system_integrity", direction: "maximize" }
    };
    const evaluator = new DesignSystemEvaluator();
    const signal = new AbortController().signal;
    const baseline = await evaluator.evaluate({ campaign, candidate: null, experimentId: "baseline", priorEvaluations: [], signal });
    assert.equal(baseline.status, "pass");
    assert.equal(baseline.metrics.polish_ready, 0);
    const passing = await evaluator.evaluate({ campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "candidate", priorEvaluations: [], signal });
    assert.equal(passing.status, "pass");
    assert.equal(passing.metrics.design_system_imagegen_references, 1);
    assert.equal(passing.artifacts.length, 3);
    await writeFile(resolve(root, "design/references/material.png"), "tampered", "utf8");
    const tampered = await evaluator.evaluate({ campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "candidate", priorEvaluations: [], signal });
    assert.equal(tampered.status, "fail");
    assert.match(tampered.violations[0]?.message ?? "", /hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("design system evaluator gates production-slice maturity on captured engine evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-production-slice-"));
  try {
    await mkdir(resolve(root, "design/references"), { recursive: true });
    const concept = Buffer.from("concept bytes");
    const capture = Buffer.from("captured engine bytes");
    const manifest = `${JSON.stringify({
      apiVersion: "gamefactory.polish-readiness/v1",
      stage: "production-slice",
      representativeBuild: { engine: "godot-4", captureEvidence: ["design/references/slice.png"] },
      surfaces: [{ id: "gameplay", label: "Representative gameplay", required: true, status: "production", evidence: ["design/references/slice.png"] }],
      assets: [],
      gates: [
        { id: "engine-capture", label: "Engine capture", status: "pass", evidence: ["design/references/slice.png"], findings: [] },
        { id: "art-direction", label: "Art direction", status: "pass", evidence: ["design/references/slice.png"], findings: [] }
      ],
      unresolved: []
    }, null, 2)}\n`;
    await writeFile(resolve(root, "concept.png"), concept);
    await writeFile(resolve(root, "design/references/slice.png"), capture);
    await writeFile(resolve(root, "design/production-slice.json"), manifest, "utf8");
    await writeFile(resolve(root, "visual-direction.json"), `${JSON.stringify({
      apiVersion: "gamefactory.visual-direction/v1",
      id: "fixture-direction",
      intent: "Prove a feasible authored game view",
      renderingStrategy: { mode: "layered 2D", feasibility: "Capture the implementation at its shipping camera" },
      references: [{ path: "concept.png", label: "Concept-only material study", purpose: "material", authority: "inspiration", source: "other", sha256: sha256(concept), provenanceNote: "Legacy prompt unavailable" }],
      nonnegotiables: ["Gameplay reads"],
      qualityDimensions: { readability: "The interaction reads in motion" },
      antiPatterns: ["concept art presented as engine evidence"],
      views: [{ id: "slice", purpose: "Prove the production method" }]
    }, null, 2)}\n`, "utf8");
    await writeFile(resolve(root, "design-system.json"), `${JSON.stringify({
      apiVersion: "gamefactory.design-system/v1",
      id: "fixture-production-system",
      version: "1.1.0",
      title: "Fixture production slice",
      maturity: "production-slice",
      identity: { intent: "A feasible authored system", toneWords: ["authored"], avoidWords: ["generic"] },
      principles: [{ id: "proof", statement: "Prove before expanding", rationale: "Avoid speculative assets", priority: 1 }],
      tokens: { color: { primary: "#ffffff" } },
      patterns: [],
      references: [{ path: "design/references/slice.png", role: "Running engine slice", purpose: "gameplay", authority: "production-target", source: "captured", sha256: sha256(capture) }],
      implementations: [
        { id: "slice", adapter: "godot-production-slice", path: "design/production-slice.json", sha256: sha256(manifest) },
        { id: "readiness", adapter: "production-readiness", path: "design/production-slice.json", sha256: sha256(manifest) }
      ]
    }, null, 2)}\n`, "utf8");
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "production-slice-test",
      objective: "verify staged art production",
      projectRoot: root,
      workflow: "tournament",
      requires: [],
      parameters: { designSystem: { path: "design-system.json", visualDirectionPath: "visual-direction.json", minimumMaturity: "production-slice", requiredAdapters: ["godot-production-slice"], requiredReferenceAuthorities: ["production-target"], requiredPolishGates: ["engine-capture", "art-direction"] } },
      acceptance: { primaryMetric: "design_system_integrity", direction: "maximize" }
    };
    const evaluation = await new DesignSystemEvaluator().evaluate({ campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "candidate", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(evaluation.status, "pass");
    assert.equal(evaluation.metrics.design_system_maturity, 1);
    assert.equal(evaluation.metrics.design_system_production_targets, 1);
    assert.equal(evaluation.metrics.polish_ready, 1);
    assert.equal(evaluation.metrics.polish_surfaces_unfinished, 0);
    assert.equal(evaluation.metrics.visual_direction_references, 1);

    const blockedManifest = {
      ...JSON.parse(manifest),
      assets: [{ id: "runtime-sprite", label: "Runtime sprite", kind: "sprite", runtime: true, maturity: "extracted", evidence: ["design/references/slice.png"] }]
    };
    const blockedManifestText = `${JSON.stringify(blockedManifest, null, 2)}\n`;
    await writeFile(resolve(root, "design/production-slice.json"), blockedManifestText, "utf8");
    const blockedSystem = JSON.parse(await readFile(resolve(root, "design-system.json"), "utf8")) as { implementations: Array<{ sha256: string }> };
    for (const implementation of blockedSystem.implementations) implementation.sha256 = sha256(blockedManifestText);
    await writeFile(resolve(root, "design-system.json"), `${JSON.stringify(blockedSystem, null, 2)}\n`, "utf8");
    const blocked = await new DesignSystemEvaluator().evaluate({ campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "candidate", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(blocked.status, "fail");
    assert.match(blocked.violations[0]?.message ?? "", /Runtime assets are not production-ready/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("design system evaluator verifies approved scene targets and component lineage", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-scene-target-"));
  try {
    await mkdir(resolve(root, "design/scene-targets"), { recursive: true });
    await mkdir(resolve(root, "design/components"), { recursive: true });
    await mkdir(resolve(root, "design/evidence"), { recursive: true });
    await mkdir(resolve(root, "assets/ui"), { recursive: true });
    const planning = Buffer.from("approved whole planning screen");
    const action = Buffer.from("approved whole action screen");
    const source = Buffer.from("component source conditioned on whole screen");
    const runtime = Buffer.from("compiled runtime component");
    const comparison = Buffer.from("component composited into approved layout");
    await writeFile(resolve(root, "design/scene-targets/planning.png"), planning);
    await writeFile(resolve(root, "design/scene-targets/action.png"), action);
    await writeFile(resolve(root, "design/components/action-source.png"), source);
    await writeFile(resolve(root, "assets/ui/action.png"), runtime);
    await writeFile(resolve(root, "design/evidence/action-comparison.png"), comparison);
    const sceneTarget = {
      apiVersion: "gamefactory.scene-target/v1",
      id: "fixture-scene",
      version: "1.0.0",
      selectedCandidateId: "candidate-a",
      nativeGeometry: { viewport: { width: 320, height: 180 }, baseUnitPx: 4, borderWidthsPx: [1, 2], typographyPx: { body: 8, heading: 16 }, scalingRules: ["Native raster geometry is preserved."] },
      candidates: [{
        id: "candidate-a",
        label: "Approved complete scene",
        primaryViewId: "planning",
        views: [
          { id: "planning", label: "Planning", state: "planning", path: "design/scene-targets/planning.png", sha256: sha256(planning), prompt: "A complete readable gameplay screen", required: true },
          { id: "action", label: "Action", state: "action", path: "design/scene-targets/action.png", sha256: sha256(action), prompt: "The identical layout during action", required: true }
        ]
      }],
      components: [{
        id: "action-button",
        label: "Action button",
        sourceViewId: "planning",
        crop: { x: 240, y: 140, width: 64, height: 24 },
        stateIds: ["planning", "action"],
        derivedFromSceneTargetSha256: sha256(planning),
        production: {
          method: "regenerate",
          sourcePath: "design/components/action-source.png",
          sourceSha256: sha256(source),
          runtimePath: "assets/ui/action.png",
          runtimeSha256: sha256(runtime),
          nativeSize: { width: 64, height: 24 },
          renderSize: { width: 64, height: 24 },
          scaling: "native-1:1",
          matchEvidence: [{ kind: "comparison", path: "design/evidence/action-comparison.png", sha256: sha256(comparison) }]
        }
      }],
      experience: {
        composition: {
          regions: [
            { id: "playfield", label: "Playfield", stateIds: ["planning", "action"], rect: { x: 0, y: 0, width: 220, height: 180 }, allowsOverlapWith: [] },
            { id: "command-rail", label: "Command rail", stateIds: ["planning", "action"], rect: { x: 220, y: 0, width: 100, height: 180 }, allowsOverlapWith: [] }
          ],
          rules: ["Peer regions remain collision-free."]
        },
        typography: {
          mode: "hybrid",
          roles: [
            { id: "display", label: "Display", purpose: "Identity accents", treatment: "Expressive display face" },
            { id: "body", label: "Body", purpose: "Gameplay information", treatment: "Readable text face" }
          ],
          rules: ["Typography follows information role rather than rendering style."]
        },
        motion: {
          beats: [
            { id: "ambient", label: "Ambient continuity", kind: "ambient", stateIds: ["planning"], trigger: "Idle planning", visibleResponse: "The scene remains inhabited" },
            { id: "selection", label: "Selection response", kind: "interaction", stateIds: ["planning"], trigger: "Select", visibleResponse: "The choice responds" },
            { id: "action", label: "Action consequence", kind: "gameplay", stateIds: ["action"], trigger: "Act", visibleResponse: "Cause and effect remain readable" },
            { id: "settle", label: "Result transition", kind: "transition", stateIds: ["action"], trigger: "Resolve", visibleResponse: "The scene settles into result" }
          ],
          continuityRules: ["Identity, scale, and anchors remain stable."]
        }
      },
      approval: { status: "approved", reviewer: "fixture-art-director", selectedTargetSha256: sha256(planning), findings: [] }
    };
    await writeFile(resolve(root, "design/scene-targets/scene-target.json"), `${JSON.stringify(sceneTarget, null, 2)}\n`, "utf8");
    await writeFile(resolve(root, "design-system.json"), `${JSON.stringify({
      apiVersion: "gamefactory.design-system/v1",
      id: "fixture-scene-system",
      version: "1.0.0",
      title: "Fixture scene system",
      maturity: "direction",
      identity: { intent: "A coherent complete screen", toneWords: ["clear"], avoidWords: ["piecemeal"] },
      principles: [{ id: "whole-first", statement: "Approve the whole before producing parts", rationale: "Relationships define the interface", priority: 1 }],
      tokens: { color: { primary: "#ffffff" } },
      patterns: [],
      references: [{ path: "design/scene-targets/planning.png", role: "Approved whole-screen target", purpose: "gameplay", authority: "inspiration", source: "imagegen", sha256: sha256(planning), prompt: "A complete readable gameplay screen" }],
      implementations: [{ id: "action-button", adapter: "godot-ui-component", path: "assets/ui/action.png", sha256: sha256(runtime) }]
    }, null, 2)}\n`, "utf8");
    const campaign: Campaign = {
      apiVersion: "gamefactory.dev/v1",
      id: "scene-target-test",
      objective: "verify whole-scene to runtime lineage",
      projectRoot: root,
      workflow: "tournament",
      requires: [],
      parameters: { designSystem: { path: "design-system.json", sceneTargetPath: "design/scene-targets/scene-target.json", requireSceneTarget: true, requireSceneTargetComponentLineage: true, requireSceneTargetExperienceContract: true, requiredSceneTargetMotionKinds: ["ambient", "interaction", "gameplay", "transition"] } },
      acceptance: { primaryMetric: "design_system_integrity", direction: "maximize" }
    };
    const evaluator = new DesignSystemEvaluator();
    const request = { campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "candidate", priorEvaluations: [], signal: new AbortController().signal };
    const passing = await evaluator.evaluate(request);
    assert.equal(passing.status, "pass");
    assert.equal(passing.metrics.scene_target_approved, 1);
    assert.equal(passing.metrics.scene_target_components_produced, 1);

    const missingMotion = structuredClone(sceneTarget);
    missingMotion.experience.motion.beats = missingMotion.experience.motion.beats.filter((beat) => beat.kind !== "ambient");
    await writeFile(resolve(root, "design/scene-targets/scene-target.json"), `${JSON.stringify(missingMotion, null, 2)}\n`, "utf8");
    const incomplete = await evaluator.evaluate(request);
    assert.equal(incomplete.status, "fail");
    assert.match(incomplete.violations[0]?.message ?? "", /lacks required motion kinds: ambient/);

    sceneTarget.components[0]!.derivedFromSceneTargetSha256 = "f".repeat(64);
    await writeFile(resolve(root, "design/scene-targets/scene-target.json"), `${JSON.stringify(sceneTarget, null, 2)}\n`, "utf8");
    const broken = await evaluator.evaluate(request);
    assert.equal(broken.status, "fail");
    assert.match(broken.violations[0]?.message ?? "", /lineage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
