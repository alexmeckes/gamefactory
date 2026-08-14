import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { automationArgs, godotProcessSucceeded, GodotVisualEvaluator } from "./index.js";

test("Godot automation disables the interactive native crash handler", () => {
  assert.deepEqual(
    automationArgs(["--headless", "--editor", "--quit"]),
    ["--disable-crash-handler", "--headless", "--editor", "--quit"]
  );
});

test("Godot automation rejects exit-zero runs that contain engine errors", () => {
  assert.equal(godotProcessSucceeded({ exitCode: 0, stdout: "SCRIPT ERROR: null texture", stderr: "", timedOut: false }), false);
  assert.equal(godotProcessSucceeded({ exitCode: 0, stdout: "Godot Engine", stderr: "", timedOut: false }), true);
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
