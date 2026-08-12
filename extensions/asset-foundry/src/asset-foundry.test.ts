import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Campaign, Candidate } from "@gamefactory/core";
import { parseStyleProfile, styleProfileSha256 } from "@gamefactory/asset-sdk";
import { AssetStyleEvaluator, AssetTechnicalEvaluator, CommandAssetFoundryAgent, inspectPng } from "./index.js";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples/godot/asset-sources");
const fixture = resolve(fixtureDirectory, "drone-variant-1.png");

function campaign(root: string, generatorCommand: string[]): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "asset-foundry-test",
    objective: "Generate a fixture asset",
    projectRoot: root,
    workflow: "tournament",
    requires: [],
    parameters: {
      asset: { briefPath: "asset-brief.json", manifestPath: "assets.manifest.json", generatorCommand }
    },
    acceptance: { primaryMetric: "asset_quality", direction: "maximize" }
  };
}

test("PNG inspector measures real alpha, margin, coverage, and contrast", async () => {
  const inspection = inspectPng(await readFile(fixture), 32);
  assert.deepEqual([inspection.width, inspection.height, inspection.colorType], [1254, 1254, 6]);
  assert.equal(inspection.hasAlpha, true);
  assert.equal(inspection.transparentCorners, 1);
  assert.equal(inspection.safeMargin, 1);
  assert.ok(inspection.opaqueCoverage > 0.3 && inspection.opaqueCoverage < 0.5);
  assert.ok(inspection.contrast > 0.5);
  assert.ok(inspection.redDominance > 0.7);
  assert.ok(inspection.horizontalSymmetry > 0.98);
  assert.ok(inspection.verticalSymmetry > 0.9);
});

test("command foundry creates a hashed manifest and technical evaluator validates it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-asset-foundry-"));
  try {
    const styleProfile = {
      apiVersion: "gamefactory.style/v1",
      id: "fixture-style",
      version: "1.0.0",
      description: "Fixture drone style",
      references: [{
        path: "style-anchor.png",
        role: "canonical fixture",
        sha256: "0613e341717929f22866f004241d20cbf9120b14cb6717b85aab31ac4c3d9180"
      }],
      modalities: {
        image: {
          requiredTraits: ["red"],
          prohibitedTraits: ["asymmetric"],
          criteria: [
            { metric: "red_dominance", weight: 1, min: 0.72, hard: true },
            { metric: "vertical_symmetry", weight: 1, min: 0.9, hard: true }
          ]
        }
      }
    };
    const styleProfileContent = `${JSON.stringify(styleProfile)}\n`;
    const brief = {
      apiVersion: "gamefactory.assets/v1",
      id: "fixture.drone",
      modality: "image",
      role: "test drone",
      prompt: "Generate a fixture drone",
      output: { path: "assets/drone.png", mediaType: "image/png" },
      technical: { width: 1254, height: 1254, marginPixels: 32 },
      constraints: ["transparent background"],
      style: {
        profilePath: "style-profile.json",
        profileId: "fixture-style",
        profileVersion: "1.0.0",
        profileSha256: styleProfileSha256(parseStyleProfile(styleProfile))
      }
    };
    await writeFile(resolve(root, "asset-brief.json"), `${JSON.stringify(brief)}\n`, "utf8");
    await copyFile(fixture, resolve(root, "style-anchor.png"));
    await writeFile(resolve(root, "style-profile.json"), styleProfileContent, "utf8");
    const generatorPath = resolve(root, "generator.mjs");
    await writeFile(generatorPath, `
      import { copyFile, readFile, writeFile } from "node:fs/promises";
      const request = JSON.parse(await readFile(process.env.GAMEFACTORY_ASSET_REQUEST, "utf8"));
      await copyFile(${JSON.stringify(fixture)}, request.outputPath);
      await writeFile(process.env.GAMEFACTORY_ASSET_RESULT, JSON.stringify({
        generator: { id: "fixture.generator", version: "1" },
        prompt: request.brief.prompt,
        processors: [{ id: "fixture.alpha" }],
        license: "fixture-only"
      }));
    `, "utf8");
    const configuredCampaign = campaign(root, [process.execPath, generatorPath]);
    const candidate: Candidate = { id: "candidate-1", root, metadata: {} };
    const controller = new AbortController();
    const result = await new CommandAssetFoundryAgent().run({
      campaign: configuredCampaign,
      candidate,
      experimentId: "tournament-r0001-c001",
      history: [],
      signal: controller.signal
    });
    assert.match(result.summary, /fixture\.generator/);
    const manifest = JSON.parse(await readFile(resolve(root, "assets.manifest.json"), "utf8"));
    assert.equal(manifest.recipe.generator.id, "fixture.generator");
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.style.profileId, "fixture-style");
    assert.equal(manifest.style.references[0].sha256, "0613e341717929f22866f004241d20cbf9120b14cb6717b85aab31ac4c3d9180");

    const evaluation = await new AssetTechnicalEvaluator().evaluate({
      campaign: configuredCampaign,
      candidate,
      experimentId: "tournament-r0001-c001",
      priorEvaluations: [],
      signal: controller.signal
    });
    assert.equal(evaluation.status, "pass");
    assert.equal(evaluation.metrics.manifest_integrity, 1);
    assert.ok((evaluation.metrics.asset_quality ?? 0) > 0.8);

    const styleEvaluator = new AssetStyleEvaluator();
    const styleEvaluation = await styleEvaluator.evaluate({
      campaign: configuredCampaign,
      candidate,
      experimentId: "tournament-r0001-c001",
      priorEvaluations: [evaluation],
      signal: controller.signal
    });
    assert.equal(styleEvaluation.status, "pass");
    assert.equal(styleEvaluation.metrics.reference_similarity, 1);
    assert.equal(styleEvaluation.metrics.style_alignment, 1);

    await copyFile(resolve(fixtureDirectory, "drone-variant-2.png"), resolve(root, "assets/drone.png"));
    const asymmetric = await styleEvaluator.evaluate({
      campaign: configuredCampaign,
      candidate,
      experimentId: "tournament-r0001-c002",
      priorEvaluations: [],
      signal: controller.signal
    });
    assert.equal(asymmetric.status, "fail");
    assert.ok(asymmetric.violations.some((violation) => violation.code === "asset.style.vertical_symmetry"));

    await copyFile(resolve(fixtureDirectory, "drone-variant-3.png"), resolve(root, "assets/drone.png"));
    const offPalette = await styleEvaluator.evaluate({
      campaign: configuredCampaign,
      candidate,
      experimentId: "tournament-r0001-c003",
      priorEvaluations: [],
      signal: controller.signal
    });
    assert.equal(offPalette.status, "fail");
    assert.ok(offPalette.violations.some((violation) => violation.code === "asset.style.red_dominance"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
