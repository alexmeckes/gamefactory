import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
    ...(typeof value.resultLog === "string" ? { resultLog: value.resultLog } : {})
  };
}

export async function loadCampaign(path: string): Promise<Campaign> {
  const value = await readJson(path);
  assertObject(value, "Campaign");
  if (value.apiVersion !== "gamefactory.dev/v1") throw new Error("Unsupported campaign apiVersion");
  assertString(value.id, "Campaign id");
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

  return {
    apiVersion: "gamefactory.dev/v1",
    id: value.id,
    objective: value.objective,
    projectRoot: resolve(dirname(path), value.projectRoot),
    workflow: value.workflow,
    requires: value.requires,
    acceptance,
    ...(Array.isArray(value.optional) ? { optional: value.optional as string[] } : {}),
    ...(Array.isArray(value.mutablePaths) ? { mutablePaths: value.mutablePaths as string[] } : {}),
    ...(Array.isArray(value.immutablePaths) ? { immutablePaths: value.immutablePaths as string[] } : {}),
    ...(value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters) ? { parameters: value.parameters as Record<string, unknown> } : {}),
    ...(value.budget && typeof value.budget === "object" && !Array.isArray(value.budget) ? { budget: value.budget as NonNullable<Campaign["budget"]> } : {}),
    ...(Array.isArray(value.humanGates) ? { humanGates: value.humanGates as string[] } : {})
  };
}
