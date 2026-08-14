import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Campaign, FactoryConfig } from "./types.js";

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function assertSafeCampaignId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Campaign id must contain only letters, numbers, dot, underscore, or dash and be at most 128 characters");
  }
}

function validateBudget(value: unknown): asserts value is NonNullable<Campaign["budget"]> {
  assertObject(value, "Campaign budget");
  const integerFields = ["maximumExperiments", "maximumConsecutiveCrashes", "plateauExperiments"] as const;
  for (const field of integerFields) {
    const item = value[field];
    if (item !== undefined && (!Number.isSafeInteger(item) || (item as number) < 0)) {
      throw new Error(`Campaign budget.${field} must be a non-negative safe integer`);
    }
  }
  for (const field of ["wallTimeMinutes", "maximumCostUsd"] as const) {
    const item = value[field];
    if (item !== undefined && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
      throw new Error(`Campaign budget.${field} must be a non-negative finite number`);
    }
  }
}

function validateProjectPaths(value: string[] | undefined, label: string): void {
  const sentinel = resolve("gamefactory-project-root");
  for (const item of value ?? []) {
    const traversal = relative(sentinel, resolve(sentinel, item));
    if (!item || item.includes("\0") || isAbsolute(item) || !traversal || traversal.startsWith("..") || isAbsolute(traversal)) {
      throw new Error(`${label} entries must be non-empty relative paths inside the project`);
    }
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadFactoryConfig(path: string): Promise<FactoryConfig> {
  const value = await readJson(path);
  assertObject(value, "Factory config");
  if (value.apiVersion !== "gamefactory.dev/v1") throw new Error("Unsupported factory config apiVersion");
  assertStringArray(value.extensions, "Factory config extensions");
  return {
    apiVersion: "gamefactory.dev/v1",
    extensions: value.extensions.map((entry) => resolve(dirname(path), entry)),
    ...(typeof value.artifactDirectory === "string" ? { artifactDirectory: value.artifactDirectory } : {}),
    ...(typeof value.resultLog === "string" ? { resultLog: value.resultLog } : {}),
    ...(typeof value.journalLog === "string" ? { journalLog: value.journalLog } : {}),
    ...(typeof value.traceLog === "string" ? { traceLog: value.traceLog } : {})
  };
}

export async function loadCampaign(path: string): Promise<Campaign> {
  const value = await readJson(path);
  assertObject(value, "Campaign");
  if (value.apiVersion !== "gamefactory.dev/v1") throw new Error("Unsupported campaign apiVersion");
  assertString(value.id, "Campaign id");
  assertSafeCampaignId(value.id);
  assertString(value.objective, "Campaign objective");
  assertString(value.projectRoot, "Campaign projectRoot");
  assertString(value.workflow, "Campaign workflow");
  assertStringArray(value.requires, "Campaign requires");
  assertObject(value.acceptance, "Campaign acceptance");
  assertString(value.acceptance.primaryMetric, "Campaign acceptance.primaryMetric");
  if (value.acceptance.direction !== "minimize" && value.acceptance.direction !== "maximize") {
    throw new Error("Campaign acceptance.direction must be minimize or maximize");
  }

  const acceptance = {
    primaryMetric: value.acceptance.primaryMetric,
    direction: value.acceptance.direction,
    ...(typeof value.acceptance.minimumDelta === "number" ? { minimumDelta: value.acceptance.minimumDelta } : {}),
    ...(Array.isArray(value.acceptance.hardGates) ? { hardGates: value.acceptance.hardGates as string[] } : {}),
    ...(typeof value.acceptance.allowRegressions === "boolean" ? { allowRegressions: value.acceptance.allowRegressions } : {})
  } satisfies Campaign["acceptance"];

  const mutablePaths = Array.isArray(value.mutablePaths) ? value.mutablePaths as string[] : undefined;
  const immutablePaths = Array.isArray(value.immutablePaths) ? value.immutablePaths as string[] : undefined;
  validateProjectPaths(mutablePaths, "Campaign mutablePaths");
  validateProjectPaths(immutablePaths, "Campaign immutablePaths");
  if (value.budget !== undefined) validateBudget(value.budget);

  return {
    apiVersion: "gamefactory.dev/v1",
    id: value.id,
    objective: value.objective,
    projectRoot: resolve(dirname(path), value.projectRoot),
    workflow: value.workflow,
    requires: value.requires,
    acceptance,
    ...(Array.isArray(value.optional) ? { optional: value.optional as string[] } : {}),
    ...(mutablePaths ? { mutablePaths } : {}),
    ...(immutablePaths ? { immutablePaths } : {}),
    ...(value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters) ? { parameters: value.parameters as Record<string, unknown> } : {}),
    ...(value.budget && typeof value.budget === "object" && !Array.isArray(value.budget) ? { budget: value.budget as NonNullable<Campaign["budget"]> } : {}),
    ...(Array.isArray(value.humanGates) ? { humanGates: value.humanGates as string[] } : {})
  };
}
