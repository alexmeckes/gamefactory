import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GameSpec, GameSpecChange, GameSpecClaim, GameSpecClaimCategory, GameSpecDecision, GameSpecSlicePlan } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATEGORIES = new Set<GameSpecClaimCategory>(["player", "world", "interaction", "loop", "system", "experience", "visual", "motion", "technical", "content", "exclusion", "other"]);

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function id(value: unknown, label: string): asserts value is string {
  text(value, label);
  if (!ID.test(value)) throw new Error(`${label} contains unsupported characters`);
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value as string[])];
}

function claim(value: unknown, index: number): GameSpecClaim {
  const label = `GameSpec claims[${index}]`;
  object(value, label);
  id(value.id, `${label}.id`);
  if (typeof value.category !== "string" || !CATEGORIES.has(value.category as GameSpecClaimCategory)) throw new Error(`${label}.category is invalid`);
  text(value.statement, `${label}.statement`);
  if (value.status !== "required" && value.status !== "assumption" && value.status !== "open") throw new Error(`${label}.status is invalid`);
  const falsifiers = strings(value.falsifiers, `${label}.falsifiers`);
  return { id: value.id, category: value.category as GameSpecClaimCategory, statement: value.statement, status: value.status, ...(falsifiers.length ? { falsifiers } : {}) };
}

function decision(value: unknown, index: number): GameSpecDecision {
  const label = `GameSpec decisions[${index}]`;
  object(value, label);
  id(value.id, `${label}.id`);
  if (value.status !== "accepted" && value.status !== "rejected" && value.status !== "deferred") throw new Error(`${label}.status is invalid`);
  text(value.question, `${label}.question`);
  text(value.resolution, `${label}.resolution`);
  const affectedClaims = strings(value.affectedClaims, `${label}.affectedClaims`);
  return { id: value.id, status: value.status, question: value.question, resolution: value.resolution, ...(affectedClaims.length ? { affectedClaims } : {}) };
}

function slice(value: unknown, index: number): GameSpecSlicePlan {
  const label = `GameSpec slices[${index}]`;
  object(value, label);
  id(value.id, `${label}.id`);
  text(value.playerOutcome, `${label}.playerOutcome`);
  text(value.primaryRisk, `${label}.primaryRisk`);
  const claimIds = strings(value.claimIds, `${label}.claimIds`);
  if (claimIds.length === 0) throw new Error(`${label}.claimIds must contain at least one claim`);
  return { id: value.id, playerOutcome: value.playerOutcome, primaryRisk: value.primaryRisk, claimIds };
}

function change(value: unknown): GameSpecChange {
  object(value, "GameSpec change");
  if (value.kind !== "initial" && value.kind !== "evidence-amendment" && value.kind !== "user-amendment") throw new Error("GameSpec change.kind is invalid");
  text(value.rationale, "GameSpec change.rationale");
  const evidence = strings(value.evidence, "GameSpec change.evidence");
  const affectedClaims = strings(value.affectedClaims, "GameSpec change.affectedClaims");
  const affectedSlices = strings(value.affectedSlices, "GameSpec change.affectedSlices");
  for (const claimId of affectedClaims) id(claimId, "GameSpec change.affectedClaims entry");
  for (const sliceId of affectedSlices) id(sliceId, "GameSpec change.affectedSlices entry");
  return { kind: value.kind, rationale: value.rationale, ...(evidence.length ? { evidence } : {}), ...(affectedClaims.length ? { affectedClaims } : {}), ...(affectedSlices.length ? { affectedSlices } : {}) };
}

export function parseGameSpec(value: unknown, expectedProjectId?: string): GameSpec {
  object(value, "GameSpec");
  if (value.apiVersion !== "gamefactory.game-spec/v1") throw new Error("Unsupported GameSpec apiVersion");
  if (value.kind !== "GameSpec") throw new Error("GameSpec kind must be GameSpec");
  id(value.projectId, "GameSpec projectId");
  if (expectedProjectId && value.projectId !== expectedProjectId) throw new Error(`GameSpec projectId ${value.projectId} does not match project ${expectedProjectId}`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("GameSpec revision must be a positive safe integer");
  if (value.status !== "draft" && value.status !== "frozen") throw new Error("GameSpec status must be draft or frozen");
  text(value.concept, "GameSpec concept");
  text(value.thesis, "GameSpec thesis");
  if (!Array.isArray(value.claims) || value.claims.length === 0) throw new Error("GameSpec claims must contain at least one claim");
  const claims = value.claims.map(claim);
  if (new Set(claims.map((item) => item.id)).size !== claims.length) throw new Error("GameSpec contains duplicate claim ids");
  if (!Array.isArray(value.slices) || value.slices.length === 0) throw new Error("GameSpec slices must contain at least one slice");
  const slices = value.slices.map(slice);
  if (new Set(slices.map((item) => item.id)).size !== slices.length) throw new Error("GameSpec contains duplicate slice ids");
  const claimIds = new Set(claims.map((item) => item.id));
  for (const item of slices) for (const claimId of item.claimIds) if (!claimIds.has(claimId)) throw new Error(`GameSpec slice ${item.id} references unknown claim ${claimId}`);
  const decisions = value.decisions === undefined ? [] : Array.isArray(value.decisions) ? value.decisions.map(decision) : (() => { throw new Error("GameSpec decisions must be an array"); })();
  if (new Set(decisions.map((item) => item.id)).size !== decisions.length) throw new Error("GameSpec contains duplicate decision ids");
  for (const item of decisions) for (const claimId of item.affectedClaims ?? []) if (!claimIds.has(claimId)) throw new Error(`GameSpec decision ${item.id} references unknown claim ${claimId}`);
  const assumptions = strings(value.assumptions, "GameSpec assumptions");
  const openQuestions = strings(value.openQuestions, "GameSpec openQuestions");
  let supersedes: GameSpec["supersedes"];
  if (value.supersedes !== undefined) {
    object(value.supersedes, "GameSpec supersedes");
    if (!Number.isSafeInteger(value.supersedes.revision) || (value.supersedes.revision as number) < 1) throw new Error("GameSpec supersedes.revision must be a positive safe integer");
    if (typeof value.supersedes.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.supersedes.sha256)) throw new Error("GameSpec supersedes.sha256 must be a lowercase SHA-256");
    if ((value.supersedes.revision as number) >= (value.revision as number)) throw new Error("GameSpec supersedes.revision must be earlier than the current revision");
    supersedes = { revision: value.supersedes.revision as number, sha256: value.supersedes.sha256 };
  }
  const parsedChange = value.change === undefined ? undefined : change(value.change);
  if (parsedChange?.kind === "initial" && value.revision !== 1) throw new Error("GameSpec initial change metadata is only valid for revision 1");
  if (parsedChange && parsedChange.kind !== "initial" && !supersedes) throw new Error("GameSpec amendments must identify the superseded revision");
  return {
    apiVersion: "gamefactory.game-spec/v1", kind: "GameSpec", projectId: value.projectId,
    revision: value.revision as number, status: value.status, concept: value.concept, thesis: value.thesis,
    claims, ...(decisions.length ? { decisions } : {}), slices,
    ...(assumptions.length ? { assumptions } : {}), ...(openQuestions.length ? { openQuestions } : {}), ...(supersedes ? { supersedes } : {}), ...(parsedChange ? { change: parsedChange } : {})
  };
}

export async function loadGameSpec(path: string, expectedProjectId?: string): Promise<GameSpec> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { throw new Error(`Unable to read GameSpec at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseGameSpec(value, expectedProjectId);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function gameSpecFingerprint(spec: GameSpec, claimIds?: string[]): string {
  const selected = claimIds
    ? { projectId: spec.projectId, claims: [...new Set(claimIds)].sort().map((id) => spec.claims.find((item) => item.id === id) ?? (() => { throw new Error(`Unknown GameSpec claim ${id}`); })()) }
    : spec;
  return createHash("sha256").update(canonical(selected)).digest("hex");
}
