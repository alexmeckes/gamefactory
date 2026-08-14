import assert from "node:assert/strict";
import test from "node:test";
import { designIntentSha256, gameDesignSystemSha256, parseDesignIntent, parseDesignIntentReference, parseGameDesignSystem, parseHumanPlaytestReport, parseVisualDirection, resolveDesignPath, visualDirectionSha256 } from "./index.js";

const fixture = {
  apiVersion: "gamefactory.design/v1",
  id: "fixture",
  version: "1.0.0",
  title: "Fixture",
  audience: { description: "testers", needs: ["clarity"], exclusions: [] },
  playerExperience: {
    fantasy: "test a system",
    emotions: ["curiosity"],
    pillars: [{ id: "clarity", statement: "Readable choices", priority: 1 }],
    antiPillars: ["busywork"]
  },
  coreLoop: { verbs: ["move"], description: "Move and observe", sessionLengthMinutes: [1, 2] },
  creativeBounds: {
    mustPreserve: ["short sessions"],
    preferences: ["direct controls"],
    freeToExplore: ["movement model", "reward topology"]
  },
  explorationQuestions: [{ id: "q1", question: "What makes movement expressive?", whyItMatters: "It is the core verb", signals: ["route diversity"] }],
  hypotheses: [{ id: "h1", predictedDynamic: "exploration", intendedExperience: "curiosity", evidence: [], falsifiers: [] }],
  playtests: {
    provider: "fixture/v1",
    version: "1",
    path: "res://main.tscn",
    personas: [{ id: "novice", label: "Novice", description: "Slow learner", goals: ["survive"], behaviors: ["hesitate"], kind: "scripted", parameters: {} }],
    scenarios: [{ id: "short", label: "Short run", parameters: { ticks: 10 } }],
    seeds: [1, 2],
    concurrency: 2,
    metrics: [{ metric: "completion", aggregate: "mean", weight: 1, min: 0.9, hard: true }]
  },
  constraints: { accessibility: ["remappable input"], performance: ["60 fps"], platforms: ["desktop"] },
  unknowns: ["onboarding"]
};

test("design SDK parses and canonically hashes intent", () => {
  const intent = parseDesignIntent(fixture);
  assert.equal(intent.playtests.personas[0]?.id, "novice");
  assert.equal(intent.playerExperience.pillars[0]?.id, "clarity");
  assert.equal(intent.creativeBounds.freeToExplore[1], "reward topology");
  assert.equal(intent.explorationQuestions[0]?.id, "q1");
  assert.equal(intent.hypotheses[0]?.mechanic, undefined);
  assert.equal(designIntentSha256(intent), designIntentSha256(parseDesignIntent(JSON.parse(JSON.stringify(fixture, null, 2)))));
  const legacyIntent = parseDesignIntent({ ...fixture, creativeBounds: undefined, explorationQuestions: undefined });
  assert.deepEqual(legacyIntent.creativeBounds, { mustPreserve: [], preferences: [], freeToExplore: [] });
  assert.deepEqual(legacyIntent.explorationQuestions, []);
  const reference = parseDesignIntentReference({ path: "design.intent.json", id: "fixture", version: "1.0.0", sha256: designIntentSha256(intent) });
  assert.equal(reference.sha256.length, 64);
});

test("design SDK rejects traversal, duplicate personas, and invalid ranges", () => {
  assert.throws(() => resolveDesignPath("C:/project", "../intent.json"));
  assert.throws(() => parseDesignIntent({
    ...fixture,
    playtests: { ...fixture.playtests, personas: [fixture.playtests.personas[0], fixture.playtests.personas[0]] }
  }));
  assert.throws(() => parseDesignIntent({ ...fixture, coreLoop: { ...fixture.coreLoop, sessionLengthMinutes: [3, 1] } }));
});

test("design SDK parses explicit human evidence without treating it as synthetic", () => {
  const intent = parseDesignIntent(fixture);
  const report = parseHumanPlaytestReport({
    apiVersion: "gamefactory.human-playtest/v1",
    id: "study-1",
    conductedAt: "2026-08-11T00:00:00.000Z",
    designIntent: { id: intent.id, version: intent.version, sha256: designIntentSha256(intent) },
    subject: { id: "prototype-1" },
    study: { method: "moderated", participantCount: 3, audienceMatch: 0.8, consentConfirmed: true, containsPersonalData: false },
    findings: [{ id: "f1", severity: "concern", observation: "Goal was initially unclear", evidence: ["2 of 3 hesitated"], pillarIds: ["clarity"] }],
    decision: { status: "needs-changes", rationale: "Improve onboarding", decidedBy: "research-lead" }
  });
  assert.equal(report.study.participantCount, 3);
  assert.equal(report.decision.status, "needs-changes");
});

test("design SDK preserves an extensible, reproducible visual language", () => {
  const system = parseGameDesignSystem({
    apiVersion: "gamefactory.design-system/v1",
    id: "tactile-workshop",
    version: "1.0.0",
    title: "Tactile workshop",
    maturity: "direction",
    identity: { intent: "Make the rope feel physical and authored", toneWords: ["tactile", "quiet"], avoidWords: ["generic"] },
    principles: [{ id: "rope-first", statement: "The rope owns the highest contrast", rationale: "Topology must remain readable", priority: 1 }],
    tokens: {
      color: { rope: "#d4ae72", surface: "#172027" },
      motion: { settleSeconds: 0.18 },
      customMaterialLanguage: { fibers: "visible near contact points" }
    },
    patterns: [{ id: "anchor", intent: "Show fixed topology", rules: ["Use a brass center"], avoid: ["glow-only state"], examples: [] }],
    references: [{ path: "design/references/material.png", role: "Material and hierarchy study", purpose: "material", authority: "inspiration", source: "imagegen", sha256: "a".repeat(64), prompt: "A tactile rope workshop material study" }],
    implementations: [{ id: "godot-theme", adapter: "godot-theme", path: "design/theme/game.tres", sha256: "b".repeat(64) }],
    metadata: { experiment: "candidate-a" }
  });
  assert.equal(system.tokens.customMaterialLanguage?.fibers, "visible near contact points");
  assert.equal(system.references[0]?.prompt, "A tactile rope workshop material study");
  assert.equal(gameDesignSystemSha256(system), gameDesignSystemSha256(parseGameDesignSystem(JSON.parse(JSON.stringify(system)))));
  assert.throws(() => parseGameDesignSystem({ ...system, references: [{ ...system.references[0], prompt: undefined }] }), /prompt is required/);
  assert.throws(() => parseGameDesignSystem({ ...system, tokens: { color: {} } }), /must not be empty/);
  assert.throws(() => parseGameDesignSystem({ ...system, references: [{ ...system.references[0], authority: "production-target" }] }), /must be captured/);
});

test("visual direction separates concept inspiration from captured production targets", () => {
  const fixtureDirection = {
    apiVersion: "gamefactory.visual-direction/v1",
    id: "workshop",
    intent: "A tactile workshop whose interactions remain readable",
    renderingStrategy: { mode: "layered 2D", feasibility: "Use engine-native sprites and lighting at the shipping camera" },
    references: [
      { path: "visual/concept.png", label: "Material mood", purpose: "material", authority: "inspiration", source: "other", sha256: "c".repeat(64), provenanceNote: "Legacy prompt unavailable" },
      { path: "visual/slice.png", label: "Running slice", purpose: "gameplay", authority: "production-target", source: "captured", sha256: "d".repeat(64) }
    ],
    nonnegotiables: ["Gameplay remains readable"],
    qualityDimensions: { readability: "Interactions read at gameplay scale" },
    antiPatterns: ["concept art presented as a screenshot"],
    views: [{ id: "gameplay", purpose: "Prove the shipping camera" }]
  };
  const direction = parseVisualDirection(fixtureDirection);
  assert.equal(direction.references[0]?.authority, "inspiration");
  assert.equal(visualDirectionSha256(direction), visualDirectionSha256(parseVisualDirection(JSON.parse(JSON.stringify(direction)))));
  assert.throws(() => parseVisualDirection({ ...fixtureDirection, references: [{ ...fixtureDirection.references[0], authority: "production-target" }] }), /must be captured/);
});
