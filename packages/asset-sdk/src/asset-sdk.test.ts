import assert from "node:assert/strict";
import test from "node:test";
import { candidateSlot, parseAssetBrief, parseGeneratorReport, parseStyleProfile, resolveProjectAssetPath, styleProfileSha256 } from "./index.js";

test("asset SDK accepts modality-neutral briefs and preserves generator provenance", () => {
  for (const modality of ["image", "audio", "model", "animation", "font", "other"] as const) {
    const brief = parseAssetBrief({
      apiVersion: "gamefactory.assets/v1",
      id: `${modality}-fixture`,
      modality,
      role: "test asset",
      prompt: `Generate a ${modality} fixture`,
      output: { path: `assets/${modality}/fixture.bin`, mediaType: "application/octet-stream" },
      technical: { budget: 1 },
      constraints: ["original work"]
    });
    assert.equal(brief.modality, modality);
  }

  const report = parseGeneratorReport({
    generator: { id: "fixture.generator", version: "1", model: "fixture-model" },
    prompt: "A bounded fixture",
    seed: 7,
    processors: [{ id: "fixture.normalize", parameters: { size: 64 } }],
    license: "project-owned"
  });
  assert.equal(report.generator.model, "fixture-model");
  assert.equal(report.processors?.[0]?.id, "fixture.normalize");
});

test("asset SDK resolves candidate-local paths and stable tournament slots", () => {
  const root = resolveProjectAssetPath("C:/candidate", "assets/enemies/drone.png");
  assert.match(root.replaceAll("\\", "/"), /C:\/candidate\/assets\/enemies\/drone\.png$/i);
  assert.throws(() => resolveProjectAssetPath("C:/candidate", "../outside.png"));
  assert.equal(candidateSlot("tournament-r0001-c003"), 3);
  assert.equal(candidateSlot("exp-0004"), 4);
});

test("style profiles carry versioned multimodal criteria and pinned references", () => {
  const profile = parseStyleProfile({
    apiVersion: "gamefactory.style/v1",
    id: "fixture-style",
    version: "1.2.0",
    description: "A compact fixture style",
    references: [{ path: "references/anchor.png", role: "canonical silhouette", sha256: "a".repeat(64) }],
    modalities: {
      image: {
        requiredTraits: ["centered"],
        prohibitedTraits: ["watermark"],
        criteria: [{ metric: "contrast", weight: 2, min: 0.5, hard: true }]
      },
      audio: {
        criteria: [{ metric: "integrated_lufs", weight: 1, target: -16, tolerance: 2 }]
      }
    }
  });
  assert.equal(profile.id, "fixture-style");
  assert.equal(profile.modalities.image?.criteria[0]?.hard, true);
  assert.equal(profile.modalities.audio?.criteria[0]?.target, -16);
  assert.equal(styleProfileSha256(profile), styleProfileSha256(parseStyleProfile(JSON.parse(JSON.stringify(profile, null, 2)))));
  assert.throws(() => parseStyleProfile({ ...profile, version: "", modalities: {} }));
});
