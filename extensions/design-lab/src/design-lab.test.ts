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
      identity: { intent: "A legible tactile system", toneWords: ["tactile"], avoidWords: ["generic"] },
      principles: [{ id: "clarity", statement: "Clarity before ornament", rationale: "Interaction must read", priority: 1 }],
      tokens: { color: { primary: "#ffffff" }, motion: { settleSeconds: 0.2 } },
      patterns: [],
      references: [{ path: "design/references/material.png", role: "Material study", source: "imagegen", sha256: sha256(reference), prompt: "A tactile material study" }],
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
