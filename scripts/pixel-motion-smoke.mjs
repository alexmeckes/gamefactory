import { execFile } from "node:child_process";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { JsonlTraceStore } from "@gamefactory/core";
import { PixelMotionCompilerAgent, PixelMotionQualityEvaluator } from "../extensions/pixel-motion/dist/index.js";
import { Sam3TrackAgent } from "../extensions/sam3/dist/index.js";
import { GoogleOmniVideoAgent } from "../extensions/video-foundry/dist/index.js";

const execFileAsync = promisify(execFile);
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error("Usage: node scripts/pixel-motion-smoke.mjs <new-output-directory>");

const root = resolve(requestedRoot);
if (!isAbsolute(root)) throw new Error("Smoke output directory must be absolute");
try {
  await stat(root);
  throw new Error(`Refusing to overwrite existing smoke directory: ${root}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const sam3Python = process.env.GAMEFACTORY_SAM3_PYTHON;
if (!sam3Python) throw new Error("Set GAMEFACTORY_SAM3_PYTHON to the isolated SAM3 Python executable");
const sourceVideo = process.env.GAMEFACTORY_SMOKE_SOURCE_VIDEO;

await mkdir(root, { recursive: true });
const campaign = {
  apiVersion: "gamefactory.dev/v1",
  id: "pixel-motion-smoke",
  objective: "Test whether a generated clockwork beetle walk cycle survives tracking and deterministic pixel production",
  projectRoot: root,
  workflow: "autoresearch",
  requires: [],
  acceptance: { primaryMetric: "pixel_motion_quality", direction: "maximize" },
  parameters: {
    googleOmni: { requestPath: "video.request.json", timeoutSeconds: 900, pollIntervalMilliseconds: 5000, maxOutputBytes: 100_000_000 },
    sam3: {
      videoRequestPath: "sam3.video.request.json",
      videoCommand: [sam3Python, "{worker}"],
      modelSource: "facebook/sam3",
      backend: "transformers",
      device: "cuda",
      precision: "bfloat16",
      timeoutSeconds: 1800,
      maxOutputCharacters: 30_000,
      environmentAllowlist: ["HF_TOKEN", "HF_HOME", "HF_HUB_CACHE", "HF_XET_CACHE", "CUDA_DEVICE_ORDER", "CUDA_VISIBLE_DEVICES"]
    },
    pixelMotion: {
      requestPath: "pixel-motion.request.json",
      maximumLoopSeamError: 0.35,
      maximumAnchorDrift: 0.02,
      minimumTemporalChange: 0.002,
      maximumTemporalChange: 0.85
    }
  }
};

await writeFile(resolve(root, "video.request.json"), `${JSON.stringify({
  apiVersion: "gamefactory.video/v1",
  jobs: [{
    id: "beetle-walk",
    task: "text_to_video",
    aspectRatio: "16:9",
    prompt: "A single tiny clockwork beetle in strict side profile walks in place with a readable six-step gait. The beetle is centered and remains the same size. Locked orthographic camera, single continuous unbroken shot, no cuts, no camera movement. Simple matte pale-gray background, even studio light, crisp silhouette, no cast shadow, no props, no particles, no text, no other objects. The first and last pose match for a seamless loop. Emphasize clear leg contacts and a small mechanical body bob; preserve the beetle's shape and materials throughout.",
    references: [],
    outputPath: "motion/beetle-walk.mp4"
  }]
}, null, 2)}\n`, "utf8");

await writeFile(resolve(root, "sam3.video.request.json"), `${JSON.stringify({
  apiVersion: "gamefactory.sam3.video/v1",
  jobs: [{ id: "beetle", sourcePath: "motion/beetle-walk.mp4", prompt: "beetle", outputDirectory: "tracked/beetle", maxFrames: 48 }]
}, null, 2)}\n`, "utf8");

await writeFile(resolve(root, "pixel-motion.request.json"), `${JSON.stringify({
  apiVersion: "gamefactory.pixel-motion/v1",
  jobs: [{
    id: "beetle-walk",
    animationName: "walk",
    sourceDirectory: "tracked/beetle",
    outputDirectory: "pixel/beetle-walk",
    frameGlob: "*.cutout.png",
    sourceStride: 2,
    targetFrames: 8,
    framesPerSecond: 8,
    loop: true,
    anchor: "bottom-center",
    fit: "contain",
    allowUpscale: false,
    allowClipping: false,
    alphaThreshold: 24,
    frame: { width: 48, height: 48, pivotX: 24, pivotY: 44, padding: 2 },
    palette: { colors: ["#100f14", "#28232b", "#4b3940", "#70483b", "#9c5d3b", "#cf8747", "#e8b86a", "#f2dfad", "#477a83", "#78bcc0"] }
  }]
}, null, 2)}\n`, "utf8");

const traceStore = new JsonlTraceStore(resolve(root, ".factory", "traces", "pixel-motion-smoke.jsonl"));
const trace = { emit: async (event) => { await traceStore.append({ runId: "pixel-motion-smoke", campaignId: campaign.id }, event); } };
const candidate = { id: "pixel-motion-smoke", root, metadata: { purpose: "visual-lane-smoke" } };
const signal = new AbortController().signal;
const stages = [];

async function runAgent(name, experimentId, agent) {
  const startedAt = new Date().toISOString();
  try {
    const result = await agent.run({ campaign, candidate, experimentId, history: [], signal, trace });
    stages.push({ name, status: "complete", startedAt, finishedAt: new Date().toISOString(), summary: result.summary, artifacts: result.artifacts?.map(({ path, kind, label, mediaType, sha256 }) => ({ path, kind, label, mediaType, sha256 })) ?? [] });
    console.log(`${name}: ${result.summary}`);
    return result;
  } catch (error) {
    stages.push({ name, status: "failed", startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), artifacts: error?.artifacts ?? [] });
    await writeSummary("failed");
    throw error;
  }
}

async function writeSummary(status, evaluation) {
  await writeFile(resolve(root, "smoke-result.json"), `${JSON.stringify({ apiVersion: "gamefactory.pixel-motion-smoke/v1", status, root, stages, ...(evaluation ? { evaluation } : {}) }, null, 2)}\n`, "utf8");
}

if (sourceVideo) {
  const canonicalSourceVideo = resolve(sourceVideo);
  const sourceDetails = await stat(canonicalSourceVideo);
  if (!sourceDetails.isFile()) throw new Error(`GAMEFACTORY_SMOKE_SOURCE_VIDEO is not a file: ${canonicalSourceVideo}`);
  await mkdir(resolve(root, "motion"), { recursive: true });
  await copyFile(canonicalSourceVideo, resolve(root, "motion", "beetle-walk.mp4"));
  stages.push({ name: "source-video", status: "reused", finishedAt: new Date().toISOString(), summary: `Reused the prior generated video from ${canonicalSourceVideo}` });
  console.log("source-video: reused prior generated video");
} else {
  await runAgent("google-omni", "smoke-video", new GoogleOmniVideoAgent());
}
await runAgent("sam3-track", "smoke-track", new Sam3TrackAgent());
await runAgent("pixel-motion", "smoke-compile", new PixelMotionCompilerAgent());

const evaluation = await new PixelMotionQualityEvaluator().evaluate({ campaign, candidate, experimentId: "smoke-evaluate", priorEvaluations: [], signal });
console.log(`pixel-motion-quality: ${evaluation.status} (${evaluation.metrics.pixel_motion_quality})`);

if (process.env.GODOT_BINARY) {
  await writeFile(resolve(root, "project.godot"), `[application]\nconfig/name="Pixel Motion Smoke"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\ntextures/default_filters/use_nearest_mipmap_filter=false\n`, "utf8");
  await writeFile(resolve(root, "verify_pixel_motion.gd"), `extends SceneTree\n\nfunc _initialize() -> void:\n\tvar frames := load("res://pixel/beetle-walk/beetle-walk.tres") as SpriteFrames\n\tif frames == null or not frames.has_animation(&"walk") or frames.get_frame_count(&"walk") != 8:\n\t\tpush_error("Pixel-motion smoke resource is invalid")\n\t\tquit(1)\n\t\treturn\n\tquit(0)\n`, "utf8");
  const common = ["--disable-crash-handler", "--headless", "--path", root, "--log-file", resolve(root, "godot.log")];
  await execFileAsync(process.env.GODOT_BINARY, [...common, "--import"], { timeout: 60_000, windowsHide: true });
  await execFileAsync(process.env.GODOT_BINARY, [...common, "--script", "res://verify_pixel_motion.gd"], { timeout: 60_000, windowsHide: true });
  stages.push({ name: "godot-import", status: "complete", finishedAt: new Date().toISOString(), summary: "Godot loaded the generated eight-frame walk animation" });
}

await writeSummary(evaluation.status === "pass" ? "complete" : "quality-failed", evaluation);
console.log(`outputs: ${root}`);
