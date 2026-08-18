import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { GameSpecEvaluator } from "./index.js";

test("game spec evaluator validates frozen claims and preserves the concept", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-spec-extension-"));
  try {
    const concept = "A courier brews potions and walks them to villagers.";
    await writeFile(join(root, "concept.md"), concept, "utf8");
    await writeFile(join(root, "GAME_SPEC.json"), JSON.stringify({ apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: "fixture", revision: 4, status: "frozen", concept, thesis: "One causal errand.", claims: [{ id: "loop.errand", category: "loop", status: "required", statement: "Complete an errand." }, { id: "future.social", category: "system", status: "open", statement: "Villagers may remember deliveries." }], slices: [{ id: "first-errand", playerOutcome: "Deliver one potion.", primaryRisk: "Static menus.", claimIds: ["loop.errand"] }] }), "utf8");
    const campaign: Campaign = { apiVersion: "gamefactory.dev/v1", id: "spec", objective: "spec", projectRoot: ".", workflow: "fixture", requires: [], parameters: { gameSpec: { path: "GAME_SPEC.json", conceptPath: "concept.md", projectId: "fixture", maximumRevision: 3, requiredClaims: ["loop.errand"], requiredSlices: ["first-errand"] } }, acceptance: { primaryMetric: "spec_valid", direction: "maximize" } };
    const result = await new GameSpecEvaluator().evaluate({ campaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.spec_valid, 1);
    assert.equal(result.artifacts.length, 1);
    const unresolvedCampaign: Campaign = { ...campaign, parameters: { gameSpec: { ...(campaign.parameters?.gameSpec as Record<string, unknown>), requiredClaims: ["future.social"] } } };
    const unresolved = await new GameSpecEvaluator().evaluate({ campaign: unresolvedCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-open", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(unresolved.status, "fail");
    assert.equal(unresolved.violations[0]?.code, "game-spec.unresolved-claim");
  } finally { await rm(root, { recursive: true, force: true }); }
});
