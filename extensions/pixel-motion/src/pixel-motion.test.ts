import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Campaign } from "@gamefactory/core";
import { PixelMotionCompilerAgent, PixelMotionExecutionError, PixelMotionQualityEvaluator, decodePng, encodePng } from "./index.js";

const execFileAsync = promisify(execFile);

function campaign(root: string, parameters: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "pixel-motion-test",
    objective: "compile a coherent pixel animation",
    projectRoot: root,
    workflow: "autoresearch",
    requires: [],
    acceptance: { primaryMetric: "pixel_motion_quality", direction: "maximize" },
    parameters: { pixelMotion: { maximumLoopSeamError: 0.05, minimumTemporalChange: 0.001, ...parameters } }
  };
}

function frame(offsetX: number, accentX: number): Buffer {
  const width = 32, height = 32, pixels = Buffer.alloc(width * height * 4);
  for (let y = 13; y <= 22; y += 1) for (let x = offsetX; x < offsetX + 8; x += 1) {
    const at = (y * width + x) * 4;
    pixels[at] = 210; pixels[at + 1] = 35; pixels[at + 2] = 48; pixels[at + 3] = 255;
  }
  for (let y = 14; y <= 16; y += 1) for (let x = offsetX + accentX; x < offsetX + accentX + 2; x += 1) {
    const at = (y * width + x) * 4;
    pixels[at] = 255; pixels[at + 1] = 220; pixels[at + 2] = 64; pixels[at + 3] = 255;
  }
  return encodePng({ width, height, pixels });
}

function transparentFrame(): Buffer {
  return encodePng({ width: 32, height: 32, pixels: Buffer.alloc(32 * 32 * 4) });
}

async function fixture(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const source = resolve(root, "tracked", "hero");
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(resolve(source, "000000.cutout.png"), frame(4, 1)),
    writeFile(resolve(source, "000001.cutout.png"), frame(9, 3)),
    writeFile(resolve(source, "000002.cutout.png"), frame(14, 5)),
    writeFile(resolve(source, "000003.cutout.png"), frame(4, 1))
  ]);
  await writeFile(resolve(root, "pixel-motion.request.json"), JSON.stringify({
    apiVersion: "gamefactory.pixel-motion/v1",
    jobs: [{
      id: "hero-idle",
      animationName: "idle",
      sourceDirectory: "tracked/hero",
      outputDirectory: "assets/pixel/hero-idle",
      targetFrames: 4,
      framesPerSecond: 8,
      loop: true,
      frame: { width: 16, height: 16, pivotX: 8, pivotY: 14, padding: 1 },
      palette: { colors: ["#17151f", "#d22330", "#ffdc40"] },
      ...overrides
    }]
  }, null, 2));
}

test("PNG codec round-trips exact RGBA pixels", () => {
  const content = frame(7, 2);
  const decoded = decodePng(content);
  const roundTrip = decodePng(encodePng(decoded));
  assert.equal(roundTrip.width, 32);
  assert.equal(roundTrip.height, 32);
  assert.deepEqual(roundTrip.pixels, decoded.pixels);
});

test("pixel-motion compiles tracked frames into a palette-locked Godot animation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-"));
  try {
    await fixture(root);
    const activeCampaign = campaign(root);
    const request = { campaign: activeCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-pixel", history: [], signal: new AbortController().signal };
    const result = await new PixelMotionCompilerAgent().run(request);
    assert.equal(result.contributors?.[0]?.agentId, "pixel-motion.compile");
    assert.equal(result.artifacts?.filter((item) => item.kind === "image").length, 1);
    const manifest = JSON.parse(await readFile(resolve(root, "assets", "pixel", "hero-idle", "pixel-motion.json"), "utf8")) as Record<string, any>;
    assert.equal(manifest.diagnostics.outputFrameCount, 4);
    assert.equal(manifest.diagnostics.paletteColors, 3);
    assert.ok(manifest.diagnostics.outputColors <= 3);
    assert.equal(manifest.diagnostics.loopSeamError, 0);
    assert.equal(manifest.diagnostics.clippedPixels, 0);
    assert.ok(manifest.diagnostics.sourceAnchorDrift > 0);
    assert.equal(manifest.diagnostics.outputAnchorDrift, 0);
    const atlas = decodePng(await readFile(resolve(root, "assets", "pixel", "hero-idle", "atlas.png")));
    assert.deepEqual([atlas.width, atlas.height], [32, 32]);
    const godot = await readFile(resolve(root, "assets", "pixel", "hero-idle", "hero-idle.tres"), "utf8");
    assert.match(godot, /type="SpriteFrames"/);
    assert.match(godot, /"name": &"idle"/);
    assert.match(godot, /"speed": 8/);
    const evaluation = await new PixelMotionQualityEvaluator().evaluate({ campaign: activeCampaign, candidate: request.candidate, experimentId: request.experimentId, priorEvaluations: [], signal: request.signal });
    assert.equal(evaluation.status, "pass");
    assert.equal(evaluation.metrics.compiled_animations, 1);
    assert.ok((evaluation.metrics.pixel_motion_quality ?? 0) > 0.9);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pixel-motion rejects transparent tracking gaps without discarding a usable animation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-transparent-"));
  try {
    await fixture(root);
    await writeFile(resolve(root, "tracked", "hero", "000004.cutout.png"), transparentFrame());
    const activeCampaign = campaign(root);
    await new PixelMotionCompilerAgent().run({ campaign: activeCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-transparent", history: [], signal: new AbortController().signal });
    const manifest = JSON.parse(await readFile(resolve(root, "assets", "pixel", "hero-idle", "pixel-motion.json"), "utf8")) as Record<string, any>;
    assert.equal(manifest.diagnostics.sourceFrameCount, 5);
    assert.equal(manifest.diagnostics.transparentFrameCount, 1);
    assert.equal(manifest.diagnostics.outputFrameCount, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pixel-motion evaluator fails closed when a compiled atlas is modified", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-tamper-"));
  try {
    await fixture(root);
    const activeCampaign = campaign(root);
    const candidate = { id: "candidate", root, metadata: {} };
    const signal = new AbortController().signal;
    await new PixelMotionCompilerAgent().run({ campaign: activeCampaign, candidate, experimentId: "exp-tamper", history: [], signal });
    const atlasPath = resolve(root, "assets", "pixel", "hero-idle", "atlas.png");
    await writeFile(atlasPath, Buffer.concat([await readFile(atlasPath), Buffer.from("tampered")]));
    const evaluation = await new PixelMotionQualityEvaluator().evaluate({ campaign: activeCampaign, candidate, experimentId: "exp-tamper", priorEvaluations: [], signal });
    assert.equal(evaluation.status, "fail");
    assert.ok(evaluation.violations.some((violation) => violation.code === "pixel-motion.hash.atlas"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pixel-motion permits a genuinely empty baseline before a motion brief exists", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-baseline-"));
  try {
    const activeCampaign = campaign(root);
    const evaluation = await new PixelMotionQualityEvaluator().evaluate({ campaign: activeCampaign, candidate: null, experimentId: "baseline", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(evaluation.status, "pass");
    assert.equal(evaluation.metrics.pixel_motion_quality, 0);
    assert.ok(evaluation.violations.some((violation) => violation.code === "pixel-motion.baseline.empty"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pixel-motion retains its request and report when strict framing would clip", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-clip-"));
  try {
    await fixture(root, { fit: "none", frame: { width: 4, height: 4, pivotX: 2, pivotY: 3, padding: 0 } });
    const activeCampaign = campaign(root);
    await assert.rejects(
      () => new PixelMotionCompilerAgent().run({ campaign: activeCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-clip", history: [], signal: new AbortController().signal }),
      (error: unknown) => error instanceof PixelMotionExecutionError && error.artifacts.length >= 2 && /clipped/.test(error.message)
    );
    const report = await readFile(resolve(root, ".factory", "pixel-motion", "exp-clip", "compile-result.json"), "utf8");
    assert.match(report, /"status": "failed"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pixel-motion retains a malformed request and a typed failure report", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-invalid-"));
  try {
    await writeFile(resolve(root, "pixel-motion.request.json"), JSON.stringify({ apiVersion: "wrong", jobs: [] }));
    const activeCampaign = campaign(root);
    await assert.rejects(
      () => new PixelMotionCompilerAgent().run({ campaign: activeCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-invalid", history: [], signal: new AbortController().signal }),
      (error: unknown) => error instanceof PixelMotionExecutionError && error.artifacts.length === 2 && /request is invalid/.test(error.message)
    );
    const report = JSON.parse(await readFile(resolve(root, ".factory", "pixel-motion", "exp-invalid", "compile-result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(report.status, "failed");
    assert.equal(report.stage, "request");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Godot loads the generated SpriteFrames resource", { skip: !process.env.GODOT_BINARY, timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-pixel-motion-godot-"));
  try {
    await fixture(root);
    const activeCampaign = campaign(root);
    await new PixelMotionCompilerAgent().run({ campaign: activeCampaign, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-godot", history: [], signal: new AbortController().signal });
    await writeFile(resolve(root, "project.godot"), `[application]\nconfig/name="Pixel Motion Import Test"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`, "utf8");
    await writeFile(resolve(root, "verify_pixel_motion.gd"), `extends SceneTree\n\nfunc _initialize() -> void:\n\tvar frames := load("res://assets/pixel/hero-idle/hero-idle.tres") as SpriteFrames\n\tif frames == null or not frames.has_animation(&"idle") or frames.get_frame_count(&"idle") != 4:\n\t\tpush_error("Generated SpriteFrames resource is invalid")\n\t\tquit(1)\n\t\treturn\n\tif frames.get_frame_texture(&"idle", 0) == null:\n\t\tpush_error("Generated SpriteFrames texture was not imported")\n\t\tquit(1)\n\t\treturn\n\tquit(0)\n`, "utf8");
    const commonArguments = ["--disable-crash-handler", "--headless", "--path", root, "--log-file", resolve(root, "godot.log")];
    await execFileAsync(process.env.GODOT_BINARY!, [...commonArguments, "--import"], { timeout: 25_000, windowsHide: true });
    const result = await execFileAsync(process.env.GODOT_BINARY!, [...commonArguments, "--script", "res://verify_pixel_motion.gd"], { timeout: 25_000, windowsHide: true });
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SCRIPT ERROR:|PARSE ERROR:/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
