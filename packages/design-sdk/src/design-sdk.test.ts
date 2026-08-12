import assert from "node:assert/strict";
import test from "node:test";
import { designIntentSha256, parseDesignIntent, parseDesignIntentReference, parseHumanPlaytestReport, resolveDesignPath } from "./index.js";

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
