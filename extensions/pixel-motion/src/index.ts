import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentContribution, AgentDriver, AgentRequest, AgentResult, ArtifactReference, Evaluation, EvaluationRequest, Evaluator, FactoryTraceEventInput, Violation } from "@gamefactory/core";
import { combineDisposables, defineExtension } from "@gamefactory/extension-sdk";
import { decodePng, encodePng, type RgbaImage } from "./png.js";

const API_VERSION = "gamefactory.pixel-motion/v1" as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface PaletteSpec { colors?: string[]; path?: string; }
interface FrameSpec { width: number; height: number; pivotX: number; pivotY: number; padding: number; }
interface PixelMotionJob {
  id: string;
  animationName: string;
  sourceDirectory: string;
  outputDirectory: string;
  frameGlob: string;
  sourceStride: number;
  targetFrames: number;
  framesPerSecond: number;
  loop: boolean;
  anchor: "bottom-center" | "centroid";
  fit: "contain" | "none";
  allowUpscale: boolean;
  allowClipping: boolean;
  alphaThreshold: number;
  columns?: number;
  frame: FrameSpec;
  palette: PaletteSpec;
}
interface PixelMotionRequest { apiVersion: typeof API_VERSION; jobs: PixelMotionJob[]; }
interface PixelMotionSettings {
  requestPath: string;
  maximumLoopSeamError: number;
  maximumAnchorDrift: number;
  minimumTemporalChange: number;
  maximumTemporalChange: number;
}
interface Bounds { left: number; top: number; right: number; bottom: number; }
interface Color { red: number; green: number; blue: number; hex: string; }
interface JobDiagnostics {
  sourceFrameCount: number;
  transparentFrameCount: number;
  selectedFrameCount: number;
  outputFrameCount: number;
  frameSize: [number, number];
  atlasSize: [number, number];
  paletteColors: number;
  outputColors: number;
  meanSourceScale: number;
  sourceAnchorDrift: number;
  outputAnchorDrift: number;
  temporalPixelChange: number;
  loopSeamError: number | null;
  clippedPixels: number;
  estimatedGpuBytes: number;
}
interface CompiledJob {
  id: string;
  animationName: string;
  outputDirectory: string;
  atlasPath: string;
  godotResourcePath: string;
  manifestPath: string;
  framePaths: string[];
  atlasSha256: string;
  godotResourceSha256: string;
  diagnostics: JobDiagnostics;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string with at most ${maximum} characters`);
  return value.trim();
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return result;
}
function finite(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} must be a number from ${minimum} to ${maximum}`);
  return result;
}
function bool(value: unknown, fallback: boolean, label: string): boolean {
  const result = value ?? fallback;
  if (typeof result !== "boolean") throw new Error(`${label} must be boolean`);
  return result;
}
function contained(root: string, projectPath: string, label: string): string {
  if (projectPath.includes("\0") || isAbsolute(projectPath)) throw new Error(`${label} must be a relative candidate path`);
  const target = resolve(root, projectPath);
  const traversal = relative(resolve(root), target);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} must stay below the candidate root`);
  return target;
}
async function canonicalContained(root: string, target: string, label: string): Promise<string> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  const traversal = relative(canonicalRoot, canonicalTarget);
  if (!traversal || traversal === ".." || traversal.startsWith("..\\") || traversal.startsWith("../") || isAbsolute(traversal)) throw new Error(`${label} resolves outside the candidate root`);
  return canonicalTarget;
}
function candidateRelative(root: string, path: string): string { return relative(root, path).replaceAll("\\", "/"); }
function sha256(content: Buffer | string): string { return createHash("sha256").update(content).digest("hex"); }
function artifact(path: string, kind: ArtifactReference["kind"], label: string, mediaType: string, metadata?: Record<string, unknown>): ArtifactReference {
  return { path, kind, label, mediaType, ...(metadata ? { metadata } : {}) };
}
async function emit(request: AgentRequest, event: FactoryTraceEventInput): Promise<void> { try { await request.trace?.emit(event); } catch { /* observational */ } }

function settings(campaign: { parameters?: Record<string, unknown> }): PixelMotionSettings {
  const raw = campaign.parameters?.pixelMotion;
  const value = raw === undefined ? {} : object(raw, "parameters.pixelMotion");
  return {
    requestPath: text(value.requestPath ?? "pixel-motion.request.json", "parameters.pixelMotion.requestPath"),
    maximumLoopSeamError: finite(value.maximumLoopSeamError, 0.35, 0, 1, "parameters.pixelMotion.maximumLoopSeamError"),
    maximumAnchorDrift: finite(value.maximumAnchorDrift, 0.02, 0, 1, "parameters.pixelMotion.maximumAnchorDrift"),
    minimumTemporalChange: finite(value.minimumTemporalChange, 0.005, 0, 1, "parameters.pixelMotion.minimumTemporalChange"),
    maximumTemporalChange: finite(value.maximumTemporalChange, 0.85, 0, 1, "parameters.pixelMotion.maximumTemporalChange")
  };
}

function parsePalette(value: unknown, label: string): PaletteSpec {
  const record = object(value, label);
  if (record.colors !== undefined && record.path !== undefined) throw new Error(`${label} must use colors or path, not both`);
  if (record.path !== undefined) return { path: text(record.path, `${label}.path`) };
  if (!Array.isArray(record.colors) || record.colors.length < 2 || record.colors.length > 256 || !record.colors.every((color) => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color))) {
    throw new Error(`${label}.colors must contain from 2 to 256 #RRGGBB colors`);
  }
  return { colors: [...new Set(record.colors.map((color) => color.toLowerCase()))] };
}

function parseRequest(value: unknown): PixelMotionRequest {
  const record = object(value, "pixel-motion request");
  if (record.apiVersion !== API_VERSION) throw new Error(`pixel-motion request apiVersion must be ${API_VERSION}`);
  if (!Array.isArray(record.jobs) || !record.jobs.length || record.jobs.length > 32) throw new Error("pixel-motion request jobs must contain from 1 to 32 jobs");
  const ids = new Set<string>();
  const jobs = record.jobs.map((raw, index): PixelMotionJob => {
    const job = object(raw, `pixel-motion jobs[${index}]`);
    const id = text(job.id, `pixel-motion jobs[${index}].id`, 64);
    if (!ID_PATTERN.test(id) || ids.has(id)) throw new Error(`pixel-motion job id ${id} is invalid or duplicated`);
    ids.add(id);
    const frame = object(job.frame, `pixel-motion jobs[${index}].frame`);
    const width = integer(frame.width, 0, 1, 512, `pixel-motion jobs[${index}].frame.width`);
    const height = integer(frame.height, 0, 1, 512, `pixel-motion jobs[${index}].frame.height`);
    const padding = integer(frame.padding, 1, 0, Math.floor(Math.min(width, height) / 3), `pixel-motion jobs[${index}].frame.padding`);
    const pivotX = integer(frame.pivotX, Math.floor(width / 2), 0, width - 1, `pixel-motion jobs[${index}].frame.pivotX`);
    const pivotY = integer(frame.pivotY, height - 1 - padding, 0, height - 1, `pixel-motion jobs[${index}].frame.pivotY`);
    const anchor = job.anchor ?? "bottom-center";
    if (anchor !== "bottom-center" && anchor !== "centroid") throw new Error(`pixel-motion jobs[${index}].anchor is unsupported`);
    const fit = job.fit ?? "contain";
    if (fit !== "contain" && fit !== "none") throw new Error(`pixel-motion jobs[${index}].fit is unsupported`);
    return {
      id,
      animationName: text(job.animationName ?? id, `pixel-motion jobs[${index}].animationName`, 128),
      sourceDirectory: text(job.sourceDirectory, `pixel-motion jobs[${index}].sourceDirectory`),
      outputDirectory: text(job.outputDirectory, `pixel-motion jobs[${index}].outputDirectory`),
      frameGlob: text(job.frameGlob ?? "*.cutout.png", `pixel-motion jobs[${index}].frameGlob`, 256),
      sourceStride: integer(job.sourceStride, 1, 1, 1000, `pixel-motion jobs[${index}].sourceStride`),
      targetFrames: integer(job.targetFrames, 8, 2, 64, `pixel-motion jobs[${index}].targetFrames`),
      framesPerSecond: finite(job.framesPerSecond, 8, 1, 60, `pixel-motion jobs[${index}].framesPerSecond`),
      loop: bool(job.loop, true, `pixel-motion jobs[${index}].loop`),
      anchor,
      fit,
      allowUpscale: bool(job.allowUpscale, false, `pixel-motion jobs[${index}].allowUpscale`),
      allowClipping: bool(job.allowClipping, false, `pixel-motion jobs[${index}].allowClipping`),
      alphaThreshold: integer(job.alphaThreshold, 24, 0, 254, `pixel-motion jobs[${index}].alphaThreshold`),
      ...(job.columns === undefined ? {} : { columns: integer(job.columns, 1, 1, 64, `pixel-motion jobs[${index}].columns`) }),
      frame: { width, height, pivotX, pivotY, padding },
      palette: parsePalette(job.palette, `pixel-motion jobs[${index}].palette`)
    };
  });
  return { apiVersion: API_VERSION, jobs };
}

function parseColors(colors: string[]): Color[] {
  return colors.map((hex) => ({ red: Number.parseInt(hex.slice(1, 3), 16), green: Number.parseInt(hex.slice(3, 5), 16), blue: Number.parseInt(hex.slice(5, 7), 16), hex: hex.toLowerCase() }));
}
async function resolvePalette(root: string, spec: PaletteSpec, label: string): Promise<{ colors: Color[]; source?: string }> {
  if (spec.colors) return { colors: parseColors(spec.colors) };
  const palettePath = contained(root, spec.path!, `${label} palette path`);
  const canonical = await canonicalContained(root, palettePath, `${label} palette`);
  const parsed = JSON.parse(await readFile(canonical, "utf8")) as unknown;
  const rawColors = Array.isArray(parsed) ? parsed : object(parsed, `${label} palette file`).colors;
  const normalized = parsePalette({ colors: rawColors }, `${label} palette file`);
  return { colors: parseColors(normalized.colors!), source: candidateRelative(root, canonical) };
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}
function bounds(image: RgbaImage, threshold: number): Bounds | undefined {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    if ((image.pixels[(y * image.width + x) * 4 + 3] ?? 0) <= threshold) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right >= left && bottom >= top ? { left, top, right, bottom } : undefined;
}
function anchorPoint(box: Bounds, anchor: PixelMotionJob["anchor"]): [number, number] {
  return anchor === "bottom-center"
    ? [(box.left + box.right) / 2, box.bottom]
    : [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
}
function meanDrift(points: Array<[number, number]>, diagonal: number): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1]) / Math.max(1, diagonal);
  return total / (points.length - 1);
}
function closest(red: number, green: number, blue: number, palette: Color[]): Color {
  let winner = palette[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const distance = (red - color.red) ** 2 * 0.3 + (green - color.green) ** 2 * 0.59 + (blue - color.blue) ** 2 * 0.11;
    if (distance < best) { best = distance; winner = color; }
  }
  return winner;
}

function normalizeFrame(source: RgbaImage, box: Bounds, job: PixelMotionJob, palette: Color[]): { image: RgbaImage; scale: number; clipped: number } {
  const boxWidth = box.right - box.left + 1;
  const boxHeight = box.bottom - box.top + 1;
  const availableWidth = Math.max(1, job.frame.width - job.frame.padding * 2);
  const availableHeight = job.anchor === "bottom-center"
    ? Math.max(1, job.frame.pivotY - job.frame.padding + 1)
    : Math.max(1, job.frame.height - job.frame.padding * 2);
  const fittingScale = Math.min(availableWidth / boxWidth, availableHeight / boxHeight);
  const scale = job.fit === "none" ? 1 : job.allowUpscale ? fittingScale : Math.min(1, fittingScale);
  const scaledWidth = Math.max(1, Math.round(boxWidth * scale));
  const scaledHeight = Math.max(1, Math.round(boxHeight * scale));
  const left = job.anchor === "bottom-center" ? Math.round(job.frame.pivotX - (scaledWidth - 1) / 2) : Math.round(job.frame.pivotX - (scaledWidth - 1) / 2);
  const top = job.anchor === "bottom-center" ? job.frame.pivotY - scaledHeight + 1 : Math.round(job.frame.pivotY - (scaledHeight - 1) / 2);
  const output: RgbaImage = { width: job.frame.width, height: job.frame.height, pixels: Buffer.alloc(job.frame.width * job.frame.height * 4) };
  let clipped = 0;
  for (let targetY = 0; targetY < scaledHeight; targetY += 1) for (let targetX = 0; targetX < scaledWidth; targetX += 1) {
    const sourceLeft = box.left + Math.floor(targetX * boxWidth / scaledWidth);
    const sourceRight = box.left + Math.max(Math.floor(targetX * boxWidth / scaledWidth) + 1, Math.ceil((targetX + 1) * boxWidth / scaledWidth));
    const sourceTop = box.top + Math.floor(targetY * boxHeight / scaledHeight);
    const sourceBottom = box.top + Math.max(Math.floor(targetY * boxHeight / scaledHeight) + 1, Math.ceil((targetY + 1) * boxHeight / scaledHeight));
    let alpha = 0, weightedRed = 0, weightedGreen = 0, weightedBlue = 0, samples = 0;
    for (let y = sourceTop; y < Math.min(sourceBottom, box.bottom + 1); y += 1) for (let x = sourceLeft; x < Math.min(sourceRight, box.right + 1); x += 1) {
      const offset = (y * source.width + x) * 4;
      const pixelAlpha = source.pixels[offset + 3] ?? 0;
      alpha += pixelAlpha; samples += 1;
      weightedRed += (source.pixels[offset] ?? 0) * pixelAlpha;
      weightedGreen += (source.pixels[offset + 1] ?? 0) * pixelAlpha;
      weightedBlue += (source.pixels[offset + 2] ?? 0) * pixelAlpha;
    }
    const averageAlpha = samples ? alpha / samples : 0;
    if (averageAlpha <= job.alphaThreshold || alpha === 0) continue;
    const destinationX = left + targetX, destinationY = top + targetY;
    if (destinationX < 0 || destinationY < 0 || destinationX >= output.width || destinationY >= output.height) { clipped += 1; continue; }
    const color = closest(weightedRed / alpha, weightedGreen / alpha, weightedBlue / alpha, palette);
    const destination = (destinationY * output.width + destinationX) * 4;
    output.pixels[destination] = color.red;
    output.pixels[destination + 1] = color.green;
    output.pixels[destination + 2] = color.blue;
    output.pixels[destination + 3] = 255;
  }
  return { image: output, scale, clipped };
}

function pixelDifference(left: RgbaImage, right: RgbaImage): number {
  let difference = 0;
  for (let index = 0; index < left.pixels.length; index += 1) difference += Math.abs((left.pixels[index] ?? 0) - (right.pixels[index] ?? 0));
  return difference / Math.max(1, left.pixels.length * 255);
}
function selectedIndices(total: number, target: number): number[] {
  if (total <= target) return Array.from({ length: total }, (_, index) => index);
  return Array.from({ length: target }, (_, index) => Math.round(index * (total - 1) / (target - 1)));
}
function uniqueColors(frames: RgbaImage[]): number {
  const colors = new Set<number>();
  for (const frame of frames) for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
    const offset = pixel * 4;
    if ((frame.pixels[offset + 3] ?? 0) === 0) continue;
    colors.add(((frame.pixels[offset] ?? 0) << 16) | ((frame.pixels[offset + 1] ?? 0) << 8) | (frame.pixels[offset + 2] ?? 0));
  }
  return colors.size;
}
function atlas(frames: RgbaImage[], columns: number): RgbaImage {
  const rows = Math.ceil(frames.length / columns);
  const width = frames[0]!.width * columns, height = frames[0]!.height * rows;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const offsetX = (index % columns) * frame.width, offsetY = Math.floor(index / columns) * frame.height;
    for (let y = 0; y < frame.height; y += 1) frame.pixels.copy(pixels, ((offsetY + y) * width + offsetX) * 4, y * frame.width * 4, (y + 1) * frame.width * 4);
  }
  return { width, height, pixels };
}
function godotResource(job: PixelMotionJob, atlasPath: string, frameCount: number, columns: number): string {
  const resourcePath = `res://${atlasPath.replaceAll("\\", "/")}`;
  const subresources = Array.from({ length: frameCount }, (_, index) => {
    const x = (index % columns) * job.frame.width, y = Math.floor(index / columns) * job.frame.height;
    return `[sub_resource type="AtlasTexture" id="AtlasTexture_${index}"]\natlas = ExtResource("1_atlas")\nregion = Rect2(${x}, ${y}, ${job.frame.width}, ${job.frame.height})`;
  }).join("\n\n");
  const frames = Array.from({ length: frameCount }, (_, index) => `{ "duration": 1.0, "texture": SubResource("AtlasTexture_${index}") }`).join(", ");
  return `[gd_resource type="SpriteFrames" load_steps=${frameCount + 2} format=3]\n\n[ext_resource type="Texture2D" path=${JSON.stringify(resourcePath)} id="1_atlas"]\n\n${subresources}\n\n[resource]\nanimations = [{\n"frames": [${frames}],\n"loop": ${job.loop ? "true" : "false"},\n"name": &${JSON.stringify(job.animationName)},\n"speed": ${job.framesPerSecond}\n}]\n`;
}

async function compileJob(root: string, job: PixelMotionJob): Promise<CompiledJob> {
  const sourceDirectory = await canonicalContained(root, contained(root, job.sourceDirectory, `${job.id} sourceDirectory`), `${job.id} sourceDirectory`);
  const outputDirectory = contained(root, job.outputDirectory, `${job.id} outputDirectory`);
  await mkdir(outputDirectory, { recursive: true });
  await canonicalContained(root, outputDirectory, `${job.id} outputDirectory`);
  const pattern = wildcard(job.frameGlob);
  const names = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const strided = names.filter((_, index) => index % job.sourceStride === 0);
  if (strided.length < 2) throw new Error(`${job.id} requires at least two source frames after sourceStride`);
  const decoded: Array<{ image: RgbaImage; box: Bounds | undefined }> = [];
  for (const name of strided) {
    const framePath = await canonicalContained(root, resolve(sourceDirectory, name), `${job.id} source frame`);
    const details = await stat(framePath);
    if (!details.isFile()) throw new Error(`${job.id} source frame is not a regular file`);
    const image = decodePng(await readFile(framePath));
    decoded.push({ image, box: bounds(image, job.alphaThreshold) });
  }
  const sourceSize = decoded[0]!.image;
  if (decoded.some(({ image }) => image.width !== sourceSize.width || image.height !== sourceSize.height)) throw new Error(`${job.id} source frames must share dimensions`);
  const usable = decoded.filter((entry): entry is { image: RgbaImage; box: Bounds } => entry.box !== undefined);
  const transparentFrameCount = decoded.length - usable.length;
  if (usable.length < 2) throw new Error(`${job.id} requires at least two non-transparent tracked frames; rejected ${transparentFrameCount} transparent frame(s)`);
  const indices = selectedIndices(usable.length, job.targetFrames);
  const selected = indices.map((index) => usable[index]!);
  const sources = selected.map((entry) => entry.image);
  const sourceBounds = selected.map((entry) => entry.box);
  const palette = await resolvePalette(root, job.palette, job.id);
  const normalized = sources.map((frame, index) => normalizeFrame(frame, sourceBounds[index]!, job, palette.colors));
  const frames = normalized.map((entry) => entry.image);
  const clippedPixels = normalized.reduce((sum, entry) => sum + entry.clipped, 0);
  if (clippedPixels > 0 && !job.allowClipping) throw new Error(`${job.id} clipped ${clippedPixels} pixels; increase frame size or enable allowClipping`);
  const columns = job.columns ?? Math.ceil(Math.sqrt(frames.length));
  const packed = atlas(frames, columns);
  if (packed.width > 8192 || packed.height > 8192) throw new Error(`${job.id} atlas exceeds 8192 pixels on one axis`);
  const framesDirectory = resolve(outputDirectory, "frames");
  await mkdir(framesDirectory, { recursive: true });
  const framePaths: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const path = resolve(framesDirectory, `${String(index).padStart(4, "0")}.png`);
    await writeFile(path, encodePng(frames[index]!));
    framePaths.push(candidateRelative(root, path));
  }
  const atlasPath = resolve(outputDirectory, "atlas.png");
  const atlasBytes = encodePng(packed);
  await writeFile(atlasPath, atlasBytes);
  const godotPath = resolve(outputDirectory, `${job.id}.tres`);
  const godot = godotResource(job, candidateRelative(root, atlasPath), frames.length, columns);
  await writeFile(godotPath, godot, "utf8");
  const sourcePoints = sourceBounds.map((box) => anchorPoint(box!, job.anchor));
  const outputBounds = frames.map((frame) => bounds(frame, 0)!);
  const outputPoints = outputBounds.map((box) => anchorPoint(box, job.anchor));
  const temporal = frames.slice(1).map((frame, index) => pixelDifference(frames[index]!, frame));
  const diagnostics: JobDiagnostics = {
    sourceFrameCount: names.length,
    transparentFrameCount,
    selectedFrameCount: selected.length,
    outputFrameCount: frames.length,
    frameSize: [job.frame.width, job.frame.height],
    atlasSize: [packed.width, packed.height],
    paletteColors: palette.colors.length,
    outputColors: uniqueColors(frames),
    meanSourceScale: normalized.reduce((sum, entry) => sum + entry.scale, 0) / normalized.length,
    sourceAnchorDrift: meanDrift(sourcePoints, Math.hypot(sourceSize.width, sourceSize.height)),
    outputAnchorDrift: meanDrift(outputPoints, Math.hypot(job.frame.width, job.frame.height)),
    temporalPixelChange: temporal.length ? temporal.reduce((sum, value) => sum + value, 0) / temporal.length : 0,
    loopSeamError: job.loop ? pixelDifference(frames[0]!, frames.at(-1)!) : null,
    clippedPixels,
    estimatedGpuBytes: packed.width * packed.height * 4
  };
  const manifestPath = resolve(outputDirectory, "pixel-motion.json");
  const manifest = {
    apiVersion: API_VERSION,
    id: job.id,
    animationName: job.animationName,
    sourceDirectory: job.sourceDirectory.replaceAll("\\", "/"),
    outputDirectory: job.outputDirectory.replaceAll("\\", "/"),
    frame: job.frame,
    framesPerSecond: job.framesPerSecond,
    loop: job.loop,
    palette: { colors: palette.colors.map((color) => color.hex), ...(palette.source ? { source: palette.source } : {}) },
    files: { atlas: candidateRelative(root, atlasPath), godotResource: candidateRelative(root, godotPath), frames: framePaths },
    hashes: { atlas: sha256(atlasBytes), godotResource: sha256(godot) },
    diagnostics
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { id: job.id, animationName: job.animationName, outputDirectory: job.outputDirectory.replaceAll("\\", "/"), atlasPath: candidateRelative(root, atlasPath), godotResourcePath: candidateRelative(root, godotPath), manifestPath: candidateRelative(root, manifestPath), framePaths, atlasSha256: manifest.hashes.atlas, godotResourceSha256: manifest.hashes.godotResource, diagnostics };
}

export class PixelMotionExecutionError extends Error {
  constructor(message: string, readonly artifacts: ArtifactReference[], readonly provenance: Record<string, unknown> = {}) { super(message); this.name = "PixelMotionExecutionError"; }
}

export class PixelMotionCompilerAgent implements AgentDriver {
  readonly id = "pixel-motion.compile";
  async run(request: AgentRequest): Promise<AgentResult> {
    const config = settings(request.campaign);
    const runDirectory = resolve(request.candidate.root, ".factory", "pixel-motion", request.experimentId);
    await mkdir(runDirectory, { recursive: true });
    const reportPath = resolve(runDirectory, "compile-result.json");
    const traceNode = `agent:${request.experimentId}:pixel-motion.compile`;
    await emit(request, { type: "node:created", nodeId: traceNode, experimentId: request.experimentId, parentNodeId: `experiment:${request.experimentId}`, label: "Pixel-motion compiler", role: "asset-processor", data: { requestPath: config.requestPath } });
    await emit(request, { type: "node:started", nodeId: traceNode, experimentId: request.experimentId, label: "Pixel-motion compiler", role: "asset-processor" });
    let requestPath: string | undefined;
    let specification: PixelMotionRequest;
    try {
      requestPath = await canonicalContained(request.candidate.root, contained(request.candidate.root, config.requestPath, "pixel-motion requestPath"), "pixel-motion request");
      specification = parseRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
      const outputDirectories = new Set<string>();
      for (const job of specification.jobs) {
        const output = contained(request.candidate.root, job.outputDirectory, `${job.id} outputDirectory`);
        const key = process.platform === "win32" ? output.toLowerCase() : output;
        if (outputDirectories.has(key)) throw new Error(`${job.id} reuses another job's outputDirectory`);
        outputDirectories.add(key);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: API_VERSION, status: "failed", stage: "request", error: message }, null, 2)}\n`, "utf8");
      await emit(request, { type: "node:failed", nodeId: traceNode, experimentId: request.experimentId, label: "Pixel-motion compiler", role: "asset-processor", status: "failed", message });
      throw new PixelMotionExecutionError(`Pixel-motion request is invalid: ${message}`, [
        ...(requestPath ? [artifact(requestPath, "other", "Pixel-motion request", "application/json")] : []),
        artifact(reportPath, "other", "Pixel-motion compile report", "application/json")
      ]);
    }
    const baseArtifacts = [artifact(requestPath, "other", "Pixel-motion request", "application/json"), artifact(reportPath, "other", "Pixel-motion compile report", "application/json")];
    const startedAt = new Date().toISOString();
    const outputs: CompiledJob[] = [];
    const outputArtifacts: ArtifactReference[] = [];
    try {
      for (const job of specification.jobs) {
        if (request.signal.aborted) throw new Error("Pixel-motion compilation was cancelled");
        const output = await compileJob(request.candidate.root, job);
        outputs.push(output);
        const atlasPath = contained(request.candidate.root, output.atlasPath, `${job.id} atlas`);
        const godotPath = contained(request.candidate.root, output.godotResourcePath, `${job.id} Godot resource`);
        const manifestPath = contained(request.candidate.root, output.manifestPath, `${job.id} manifest`);
        outputArtifacts.push(
          { ...artifact(atlasPath, "image", `${job.id} pixel atlas`, "image/png", { diagnostics: output.diagnostics }), sha256: output.atlasSha256 },
          { ...artifact(godotPath, "other", `${job.id} Godot SpriteFrames`, "text/plain", { animationName: output.animationName }), sha256: output.godotResourceSha256 },
          artifact(manifestPath, "other", `${job.id} pixel-motion manifest`, "application/json", { diagnostics: output.diagnostics })
        );
      }
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: API_VERSION, status: "complete", outputs }, null, 2)}\n`, "utf8");
    } catch (error) {
      await writeFile(reportPath, `${JSON.stringify({ apiVersion: API_VERSION, status: "failed", outputs, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
      await emit(request, { type: "node:failed", nodeId: traceNode, experimentId: request.experimentId, label: "Pixel-motion compiler", role: "asset-processor", status: "failed", message: error instanceof Error ? error.message : String(error) });
      throw new PixelMotionExecutionError(`Pixel-motion compilation failed: ${error instanceof Error ? error.message : String(error)}`, [...baseArtifacts, ...outputArtifacts], { outputs });
    }
    const finishedAt = new Date().toISOString();
    const artifacts = [...baseArtifacts, ...outputArtifacts];
    await emit(request, { type: "artifact:produced", nodeId: traceNode, experimentId: request.experimentId, label: "Pixel animations", role: "asset-processor", message: `${outputs.length} animation(s)`, data: { outputs: outputs.length } });
    await emit(request, { type: "node:completed", nodeId: traceNode, experimentId: request.experimentId, label: "Pixel-motion compiler", role: "asset-processor", status: "complete", message: `${outputs.length} animation(s) compiled` });
    const contributor: AgentContribution = { agentId: this.id, role: "worker", status: "complete", startedAt, finishedAt, summary: `Compiled ${outputs.length} pixel animation(s)`, artifacts, metadata: { outputs } };
    return { summary: contributor.summary, artifacts, contributors: [contributor], metadata: { outputs } };
  }
}

function metric(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export class PixelMotionQualityEvaluator implements Evaluator {
  readonly id = "pixel-motion.quality";
  readonly version = "1.0.0";
  async evaluate(input: EvaluationRequest): Promise<Evaluation> {
    const config = settings(input.campaign);
    const root = input.candidate?.root ?? input.campaign.projectRoot;
    let specification: PixelMotionRequest;
    let requestPath: string;
    try {
      requestPath = await canonicalContained(root, contained(root, config.requestPath, "pixel-motion requestPath"), "pixel-motion request");
      specification = parseRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
    } catch (error) {
      if (input.candidate === null) return { evaluator: this.id, version: this.version, status: "pass", metrics: { pixel_motion_quality: 0 }, violations: [{ code: "pixel-motion.baseline.empty", message: "No pixel-motion request exists yet; candidates may establish the baseline.", severity: "info" }], artifacts: [], confidence: 1, summary: "Measured an empty pixel-motion baseline." };
      return { evaluator: this.id, version: this.version, status: "fail", metrics: { pixel_motion_quality: 0 }, violations: [{ code: "pixel-motion.request", message: error instanceof Error ? error.message : String(error), severity: "error" }], artifacts: [], confidence: 1, summary: "Pixel-motion request is invalid." };
    }
    const artifacts: ArtifactReference[] = [artifact(requestPath, "other", "Pixel-motion request", "application/json")];
    const violations: Violation[] = [];
    const qualities: number[] = [];
    const loopErrors: number[] = [], drifts: number[] = [], changes: number[] = [];
    for (const job of specification.jobs) {
      const manifestPath = contained(root, `${job.outputDirectory}/pixel-motion.json`, `${job.id} manifest`);
      let manifest: Record<string, unknown>;
      try { manifest = object(JSON.parse(await readFile(manifestPath, "utf8")) as unknown, `${job.id} manifest`); }
      catch {
        if (input.candidate === null) continue;
        violations.push({ code: "pixel-motion.output.missing", message: `${job.id} has no compiled pixel-motion manifest`, severity: "error", location: candidateRelative(root, manifestPath) });
        continue;
      }
      const diagnostics = object(manifest.diagnostics, `${job.id} diagnostics`);
      const files = object(manifest.files, `${job.id} files`), hashes = object(manifest.hashes, `${job.id} hashes`);
      try {
        const atlasPath = await canonicalContained(root, contained(root, text(files.atlas, `${job.id} atlas path`), `${job.id} atlas path`), `${job.id} atlas`);
        const godotPath = await canonicalContained(root, contained(root, text(files.godotResource, `${job.id} Godot resource path`), `${job.id} Godot resource path`), `${job.id} Godot resource`);
        const [atlasBytes, godotBytes] = await Promise.all([readFile(atlasPath), readFile(godotPath)]);
        artifacts.push(artifact(manifestPath, "other", `${job.id} pixel-motion manifest`, "application/json"), artifact(atlasPath, "image", `${job.id} pixel atlas`, "image/png"), artifact(godotPath, "other", `${job.id} Godot SpriteFrames`, "text/plain"));
        if (sha256(atlasBytes) !== hashes.atlas) violations.push({ code: "pixel-motion.hash.atlas", message: `${job.id} atlas hash does not match its manifest`, severity: "error" });
        if (sha256(godotBytes) !== hashes.godotResource) violations.push({ code: "pixel-motion.hash.godot", message: `${job.id} Godot resource hash does not match its manifest`, severity: "error" });
      } catch (error) { violations.push({ code: "pixel-motion.output.invalid", message: error instanceof Error ? error.message : String(error), severity: "error" }); }
      const loop = diagnostics.loopSeamError === null ? 0 : metric(diagnostics.loopSeamError, 1);
      const drift = metric(diagnostics.outputAnchorDrift, 1);
      const change = metric(diagnostics.temporalPixelChange);
      const clipping = metric(diagnostics.clippedPixels);
      const colors = metric(diagnostics.outputColors, 257), paletteColors = metric(diagnostics.paletteColors, 256);
      if (job.loop && loop > config.maximumLoopSeamError) violations.push({ code: "pixel-motion.loop-seam", message: `${job.id} loop seam ${loop.toFixed(4)} exceeds ${config.maximumLoopSeamError}`, severity: "error" });
      if (drift > config.maximumAnchorDrift) violations.push({ code: "pixel-motion.anchor-drift", message: `${job.id} anchor drift ${drift.toFixed(4)} exceeds ${config.maximumAnchorDrift}`, severity: "error" });
      if (change < config.minimumTemporalChange) violations.push({ code: "pixel-motion.motion-static", message: `${job.id} temporal change ${change.toFixed(4)} is below ${config.minimumTemporalChange}`, severity: "error" });
      if (change > config.maximumTemporalChange) violations.push({ code: "pixel-motion.motion-chaotic", message: `${job.id} temporal change ${change.toFixed(4)} exceeds ${config.maximumTemporalChange}`, severity: "error" });
      if (clipping > 0 && !job.allowClipping) violations.push({ code: "pixel-motion.clipping", message: `${job.id} clipped ${clipping} pixels`, severity: "error" });
      if (colors > paletteColors) violations.push({ code: "pixel-motion.palette", message: `${job.id} uses ${colors} colors from a ${paletteColors}-color palette`, severity: "error" });
      qualities.push(Math.max(0, 1 - loop * 0.3 - drift * 2 - Math.max(0, config.minimumTemporalChange - change) * 4 - Math.max(0, change - config.maximumTemporalChange) * 2));
      loopErrors.push(loop); drifts.push(drift); changes.push(change);
    }
    if (input.candidate === null && qualities.length === 0) return { evaluator: this.id, version: this.version, status: "pass", metrics: { pixel_motion_quality: 0 }, violations: [{ code: "pixel-motion.baseline.empty", message: "No compiled pixel animation exists yet; candidates may establish the baseline.", severity: "info" }], artifacts, confidence: 1, summary: "Measured an empty pixel-motion baseline." };
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      evaluator: this.id,
      version: this.version,
      status: violations.some((violation) => violation.severity === "error") ? "fail" : "pass",
      metrics: { pixel_motion_quality: Number(average(qualities).toFixed(6)), loop_seam_error: Number(average(loopErrors).toFixed(6)), anchor_drift: Number(average(drifts).toFixed(6)), temporal_pixel_change: Number(average(changes).toFixed(6)), compiled_animations: qualities.length },
      violations,
      artifacts,
      confidence: 1,
      summary: `${qualities.length} pixel animation(s); quality ${average(qualities).toFixed(3)}.`
    };
  }
}

export { decodePng, encodePng } from "./png.js";

export default defineExtension((api) => combineDisposables(
  api.register("agent", "pixel-motion.compile", new PixelMotionCompilerAgent()),
  api.register("evaluator", "pixel-motion.quality", new PixelMotionQualityEvaluator())
));
