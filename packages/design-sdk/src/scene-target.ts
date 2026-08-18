import { createHash } from "node:crypto";

export const SCENE_TARGET_API_VERSION = "gamefactory.scene-target/v1" as const;

export type SceneTargetApprovalStatus = "approved" | "needs-revision" | "rejected";
export type SceneTargetProductionMethod = "extract" | "regenerate" | "code-native" | "hybrid";
export type SceneTargetScaling = "native-1:1" | "integer-scale" | "nine-slice";
export type SceneTargetEvidenceKind = "composite" | "engine-capture" | "comparison";
export type SceneTargetTypographyMode = "pixel" | "hybrid" | "non-pixel";
export type SceneTargetMotionKind = "ambient" | "interaction" | "gameplay" | "transition";

export interface SceneTargetSize {
  width: number;
  height: number;
}

export interface SceneTargetRect extends SceneTargetSize {
  x: number;
  y: number;
}

export interface SceneTargetView {
  id: string;
  label: string;
  state: string;
  path: string;
  sha256: string;
  prompt: string;
  required: boolean;
}

export interface SceneTargetCandidate {
  id: string;
  label: string;
  primaryViewId: string;
  views: SceneTargetView[];
}

export interface SceneTargetEvidence {
  kind: SceneTargetEvidenceKind;
  path: string;
  sha256: string;
}

export interface SceneTargetComponentProduction {
  method: SceneTargetProductionMethod;
  sourcePath: string;
  sourceSha256: string;
  runtimePath: string;
  runtimeSha256: string;
  nativeSize: SceneTargetSize;
  renderSize: SceneTargetSize;
  scaling: SceneTargetScaling;
  matchEvidence: SceneTargetEvidence[];
}

export interface SceneTargetComponent {
  id: string;
  label: string;
  sourceViewId: string;
  crop: SceneTargetRect;
  stateIds: string[];
  derivedFromSceneTargetSha256: string;
  production?: SceneTargetComponentProduction;
}

export interface SceneTargetExperienceContract {
  composition: {
    regions: Array<{
      id: string;
      label: string;
      stateIds: string[];
      rect: SceneTargetRect;
      allowsOverlapWith: string[];
    }>;
    rules: string[];
  };
  typography: {
    mode: SceneTargetTypographyMode;
    roles: Array<{
      id: string;
      label: string;
      purpose: string;
      treatment: string;
    }>;
    rules: string[];
  };
  motion: {
    beats: Array<{
      id: string;
      label: string;
      kind: SceneTargetMotionKind;
      stateIds: string[];
      trigger: string;
      visibleResponse: string;
      startViewId?: string;
      endViewId?: string;
    }>;
    continuityRules: string[];
  };
}

export interface SceneTargetManifest {
  apiVersion: typeof SCENE_TARGET_API_VERSION;
  id: string;
  version: string;
  selectedCandidateId: string;
  nativeGeometry: {
    viewport: SceneTargetSize;
    baseUnitPx: number;
    borderWidthsPx: number[];
    typographyPx: Record<string, number>;
    scalingRules: string[];
  };
  candidates: SceneTargetCandidate[];
  components: SceneTargetComponent[];
  experience?: SceneTargetExperienceContract;
  approval: {
    status: SceneTargetApprovalStatus;
    reviewer: string;
    selectedTargetSha256: string;
    findings: string[];
    approvedAt?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface SceneTargetReadinessOptions {
  requireProducedComponents?: boolean;
  requireExperienceContract?: boolean;
  requiredMotionKinds?: SceneTargetMotionKind[];
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string, maximum = 16_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`${location} must be a non-empty string with at most ${maximum} characters`);
  return value.trim();
}

function id(value: unknown, location: string): string {
  const result = text(value, location, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error(`${location} contains unsupported characters`);
  return result;
}

function path(value: unknown, location: string): string {
  return text(value, location, 4096);
}

function hash(value: unknown, location: string): string {
  const result = text(value, location, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${location} must be a SHA-256 hex digest`);
  return result;
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${location} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${location} must be a non-negative integer`);
  return value;
}

function strings(value: unknown, location: string, maximum = 128): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 4000)) throw new Error(`${location} must be an array of at most ${maximum} non-empty strings`);
  return value.map((item) => (item as string).trim());
}

function size(value: unknown, location: string): SceneTargetSize {
  const record = object(value, location);
  return { width: positiveInteger(record.width, `${location}.width`), height: positiveInteger(record.height, `${location}.height`) };
}

function rect(value: unknown, location: string): SceneTargetRect {
  const record = object(value, location);
  return { x: nonnegativeInteger(record.x, `${location}.x`), y: nonnegativeInteger(record.y, `${location}.y`), ...size(record, location) };
}

function jsonValue(value: unknown, location: string, depth = 0): unknown {
  if (depth > 16) throw new Error(`${location} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error(`${location} has too many entries`);
    return value.map((item, index) => jsonValue(item, `${location}[${index}]`, depth + 1));
  }
  const record = object(value, location);
  if (Object.keys(record).length > 512) throw new Error(`${location} has too many keys`);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, jsonValue(item, `${location}.${key}`, depth + 1)]));
}

function uniqueIds<T extends { id: string }>(items: T[], location: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${location} contains duplicate id ${item.id}`);
    seen.add(item.id);
  }
}

export function selectedSceneTarget(manifest: SceneTargetManifest): { candidate: SceneTargetCandidate; view: SceneTargetView } {
  const candidate = manifest.candidates.find((item) => item.id === manifest.selectedCandidateId);
  if (!candidate) throw new Error(`scene target selected candidate ${manifest.selectedCandidateId} does not exist`);
  const view = candidate.views.find((item) => item.id === candidate.primaryViewId);
  if (!view) throw new Error(`scene target selected candidate ${candidate.id} has no primary view ${candidate.primaryViewId}`);
  return { candidate, view };
}

export function parseSceneTarget(value: unknown): SceneTargetManifest {
  const record = object(value, "scene target");
  if (record.apiVersion !== SCENE_TARGET_API_VERSION) throw new Error(`scene target apiVersion must be ${SCENE_TARGET_API_VERSION}`);
  const geometry = object(record.nativeGeometry, "scene target nativeGeometry");
  const viewport = size(geometry.viewport, "scene target nativeGeometry.viewport");
  if (!Array.isArray(geometry.borderWidthsPx) || geometry.borderWidthsPx.length === 0 || geometry.borderWidthsPx.length > 32) throw new Error("scene target nativeGeometry.borderWidthsPx must contain from 1 to 32 entries");
  const borderWidthsPx = geometry.borderWidthsPx.map((item, index) => positiveInteger(item, `scene target nativeGeometry.borderWidthsPx[${index}]`));
  const rawTypography = object(geometry.typographyPx, "scene target nativeGeometry.typographyPx");
  if (Object.keys(rawTypography).length === 0 || Object.keys(rawTypography).length > 64) throw new Error("scene target nativeGeometry.typographyPx must contain from 1 to 64 entries");
  const typographyPx = Object.fromEntries(Object.entries(rawTypography).map(([key, item]) => [id(key, `scene target typography key ${key}`), positiveInteger(item, `scene target nativeGeometry.typographyPx.${key}`)]));

  if (!Array.isArray(record.candidates) || record.candidates.length === 0 || record.candidates.length > 32) throw new Error("scene target candidates must contain from 1 to 32 entries");
  const candidates: SceneTargetCandidate[] = record.candidates.map((raw, candidateIndex) => {
    const item = object(raw, `scene target candidates[${candidateIndex}]`);
    if (!Array.isArray(item.views) || item.views.length === 0 || item.views.length > 64) throw new Error(`scene target candidates[${candidateIndex}].views must contain from 1 to 64 entries`);
    const views: SceneTargetView[] = item.views.map((rawView, viewIndex) => {
      const view = object(rawView, `scene target candidates[${candidateIndex}].views[${viewIndex}]`);
      if (typeof view.required !== "boolean") throw new Error(`scene target candidates[${candidateIndex}].views[${viewIndex}].required must be boolean`);
      return {
        id: id(view.id, `scene target candidates[${candidateIndex}].views[${viewIndex}].id`),
        label: text(view.label, `scene target candidates[${candidateIndex}].views[${viewIndex}].label`, 512),
        state: id(view.state, `scene target candidates[${candidateIndex}].views[${viewIndex}].state`),
        path: path(view.path, `scene target candidates[${candidateIndex}].views[${viewIndex}].path`),
        sha256: hash(view.sha256, `scene target candidates[${candidateIndex}].views[${viewIndex}].sha256`),
        prompt: text(view.prompt, `scene target candidates[${candidateIndex}].views[${viewIndex}].prompt`, 32_000),
        required: view.required
      };
    });
    uniqueIds(views, `scene target candidate ${String(item.id)} views`);
    const primaryViewId = id(item.primaryViewId, `scene target candidates[${candidateIndex}].primaryViewId`);
    if (!views.some((view) => view.id === primaryViewId)) throw new Error(`scene target candidates[${candidateIndex}] primary view ${primaryViewId} does not exist`);
    return { id: id(item.id, `scene target candidates[${candidateIndex}].id`), label: text(item.label, `scene target candidates[${candidateIndex}].label`, 512), primaryViewId, views };
  });
  uniqueIds(candidates, "scene target candidates");

  if (!Array.isArray(record.components) || record.components.length === 0 || record.components.length > 512) throw new Error("scene target components must contain from 1 to 512 entries");
  const components: SceneTargetComponent[] = record.components.map((raw, componentIndex) => {
    const item = object(raw, `scene target components[${componentIndex}]`);
    let production: SceneTargetComponentProduction | undefined;
    if (item.production !== undefined) {
      const rawProduction = object(item.production, `scene target components[${componentIndex}].production`);
      const method = rawProduction.method;
      if (method !== "extract" && method !== "regenerate" && method !== "code-native" && method !== "hybrid") throw new Error(`scene target components[${componentIndex}].production.method is unsupported`);
      const scaling = rawProduction.scaling;
      if (scaling !== "native-1:1" && scaling !== "integer-scale" && scaling !== "nine-slice") throw new Error(`scene target components[${componentIndex}].production.scaling is unsupported`);
      if (!Array.isArray(rawProduction.matchEvidence) || rawProduction.matchEvidence.length === 0 || rawProduction.matchEvidence.length > 64) throw new Error(`scene target components[${componentIndex}].production.matchEvidence must contain from 1 to 64 entries`);
      const matchEvidence: SceneTargetEvidence[] = rawProduction.matchEvidence.map((rawEvidence, evidenceIndex) => {
        const evidence = object(rawEvidence, `scene target components[${componentIndex}].production.matchEvidence[${evidenceIndex}]`);
        const kind = evidence.kind;
        if (kind !== "composite" && kind !== "engine-capture" && kind !== "comparison") throw new Error(`scene target components[${componentIndex}].production.matchEvidence[${evidenceIndex}].kind is unsupported`);
        return { kind, path: path(evidence.path, `scene target components[${componentIndex}].production.matchEvidence[${evidenceIndex}].path`), sha256: hash(evidence.sha256, `scene target components[${componentIndex}].production.matchEvidence[${evidenceIndex}].sha256`) };
      });
      const nativeSize = size(rawProduction.nativeSize, `scene target components[${componentIndex}].production.nativeSize`);
      const renderSize = size(rawProduction.renderSize, `scene target components[${componentIndex}].production.renderSize`);
      if (scaling === "native-1:1" && (nativeSize.width !== renderSize.width || nativeSize.height !== renderSize.height)) throw new Error(`scene target component ${String(item.id)} declares native-1:1 scaling with different native and render sizes`);
      if (scaling === "integer-scale" && (renderSize.width % nativeSize.width !== 0 || renderSize.height % nativeSize.height !== 0 || renderSize.width / nativeSize.width !== renderSize.height / nativeSize.height)) throw new Error(`scene target component ${String(item.id)} integer scaling must use one positive whole-number scale factor`);
      production = {
        method,
        sourcePath: path(rawProduction.sourcePath, `scene target components[${componentIndex}].production.sourcePath`),
        sourceSha256: hash(rawProduction.sourceSha256, `scene target components[${componentIndex}].production.sourceSha256`),
        runtimePath: path(rawProduction.runtimePath, `scene target components[${componentIndex}].production.runtimePath`),
        runtimeSha256: hash(rawProduction.runtimeSha256, `scene target components[${componentIndex}].production.runtimeSha256`),
        nativeSize,
        renderSize,
        scaling,
        matchEvidence
      };
    }
    return {
      id: id(item.id, `scene target components[${componentIndex}].id`),
      label: text(item.label, `scene target components[${componentIndex}].label`, 512),
      sourceViewId: id(item.sourceViewId, `scene target components[${componentIndex}].sourceViewId`),
      crop: rect(item.crop, `scene target components[${componentIndex}].crop`),
      stateIds: strings(item.stateIds, `scene target components[${componentIndex}].stateIds`, 64),
      derivedFromSceneTargetSha256: hash(item.derivedFromSceneTargetSha256, `scene target components[${componentIndex}].derivedFromSceneTargetSha256`),
      ...(production ? { production } : {})
    };
  });
  uniqueIds(components, "scene target components");

  let experience: SceneTargetExperienceContract | undefined;
  if (record.experience !== undefined) {
    const rawExperience = object(record.experience, "scene target experience");
    const rawComposition = object(rawExperience.composition, "scene target experience.composition");
    if (!Array.isArray(rawComposition.regions) || rawComposition.regions.length === 0 || rawComposition.regions.length > 128) throw new Error("scene target experience.composition.regions must contain from 1 to 128 entries");
    const regions = rawComposition.regions.map((raw, index) => {
      const item = object(raw, `scene target experience.composition.regions[${index}]`);
      return {
        id: id(item.id, `scene target experience.composition.regions[${index}].id`),
        label: text(item.label, `scene target experience.composition.regions[${index}].label`, 512),
        stateIds: strings(item.stateIds, `scene target experience.composition.regions[${index}].stateIds`, 64),
        rect: rect(item.rect, `scene target experience.composition.regions[${index}].rect`),
        allowsOverlapWith: strings(item.allowsOverlapWith ?? [], `scene target experience.composition.regions[${index}].allowsOverlapWith`, 128)
      };
    });
    uniqueIds(regions, "scene target experience composition regions");
    const compositionRules = strings(rawComposition.rules, "scene target experience.composition.rules", 64);
    if (compositionRules.length === 0) throw new Error("scene target experience.composition.rules must contain at least one rule");

    const rawTypography = object(rawExperience.typography, "scene target experience.typography");
    const typographyMode = rawTypography.mode;
    if (typographyMode !== "pixel" && typographyMode !== "hybrid" && typographyMode !== "non-pixel") throw new Error("scene target experience.typography.mode is unsupported");
    if (!Array.isArray(rawTypography.roles) || rawTypography.roles.length === 0 || rawTypography.roles.length > 32) throw new Error("scene target experience.typography.roles must contain from 1 to 32 entries");
    const roles = rawTypography.roles.map((raw, index) => {
      const item = object(raw, `scene target experience.typography.roles[${index}]`);
      return {
        id: id(item.id, `scene target experience.typography.roles[${index}].id`),
        label: text(item.label, `scene target experience.typography.roles[${index}].label`, 512),
        purpose: text(item.purpose, `scene target experience.typography.roles[${index}].purpose`),
        treatment: text(item.treatment, `scene target experience.typography.roles[${index}].treatment`)
      };
    });
    uniqueIds(roles, "scene target experience typography roles");
    const typographyRules = strings(rawTypography.rules, "scene target experience.typography.rules", 64);
    if (typographyRules.length === 0) throw new Error("scene target experience.typography.rules must contain at least one rule");

    const rawMotion = object(rawExperience.motion, "scene target experience.motion");
    if (!Array.isArray(rawMotion.beats) || rawMotion.beats.length === 0 || rawMotion.beats.length > 64) throw new Error("scene target experience.motion.beats must contain from 1 to 64 entries");
    const beats = rawMotion.beats.map((raw, index) => {
      const item = object(raw, `scene target experience.motion.beats[${index}]`);
      const kind = item.kind;
      if (kind !== "ambient" && kind !== "interaction" && kind !== "gameplay" && kind !== "transition") throw new Error(`scene target experience.motion.beats[${index}].kind is unsupported`);
      return {
        id: id(item.id, `scene target experience.motion.beats[${index}].id`),
        label: text(item.label, `scene target experience.motion.beats[${index}].label`, 512),
        kind: kind as SceneTargetMotionKind,
        stateIds: strings(item.stateIds, `scene target experience.motion.beats[${index}].stateIds`, 64),
        trigger: text(item.trigger, `scene target experience.motion.beats[${index}].trigger`),
        visibleResponse: text(item.visibleResponse, `scene target experience.motion.beats[${index}].visibleResponse`),
        ...(item.startViewId !== undefined ? { startViewId: id(item.startViewId, `scene target experience.motion.beats[${index}].startViewId`) } : {}),
        ...(item.endViewId !== undefined ? { endViewId: id(item.endViewId, `scene target experience.motion.beats[${index}].endViewId`) } : {})
      };
    });
    uniqueIds(beats, "scene target experience motion beats");
    const continuityRules = strings(rawMotion.continuityRules, "scene target experience.motion.continuityRules", 64);
    if (continuityRules.length === 0) throw new Error("scene target experience.motion.continuityRules must contain at least one rule");
    experience = {
      composition: { regions, rules: compositionRules },
      typography: { mode: typographyMode, roles, rules: typographyRules },
      motion: { beats, continuityRules }
    };
  }

  const approvalRecord = object(record.approval, "scene target approval");
  const status = approvalRecord.status;
  if (status !== "approved" && status !== "needs-revision" && status !== "rejected") throw new Error("scene target approval.status is unsupported");
  const manifest: SceneTargetManifest = {
    apiVersion: SCENE_TARGET_API_VERSION,
    id: id(record.id, "scene target id"),
    version: text(record.version, "scene target version", 128),
    selectedCandidateId: id(record.selectedCandidateId, "scene target selectedCandidateId"),
    nativeGeometry: {
      viewport,
      baseUnitPx: positiveInteger(geometry.baseUnitPx, "scene target nativeGeometry.baseUnitPx"),
      borderWidthsPx,
      typographyPx,
      scalingRules: strings(geometry.scalingRules, "scene target nativeGeometry.scalingRules", 64)
    },
    candidates,
    components,
    ...(experience ? { experience } : {}),
    approval: {
      status,
      reviewer: text(approvalRecord.reviewer, "scene target approval.reviewer", 512),
      selectedTargetSha256: hash(approvalRecord.selectedTargetSha256, "scene target approval.selectedTargetSha256"),
      findings: strings(approvalRecord.findings, "scene target approval.findings", 128),
      ...(approvalRecord.approvedAt !== undefined ? { approvedAt: text(approvalRecord.approvedAt, "scene target approval.approvedAt", 128) } : {})
    },
    ...(record.metadata !== undefined ? { metadata: jsonValue(record.metadata, "scene target metadata") as Record<string, unknown> } : {})
  };

  const selected = selectedSceneTarget(manifest);
  if (manifest.approval.selectedTargetSha256 !== selected.view.sha256) throw new Error("scene target approval hash does not match the selected primary view");
  const selectedViews = new Map(selected.candidate.views.map((view) => [view.id, view]));
  const selectedStates = new Set(selected.candidate.views.map((view) => view.state));
  for (const component of components) {
    if (!selectedViews.has(component.sourceViewId)) throw new Error(`scene target component ${component.id} cites unknown selected-candidate view ${component.sourceViewId}`);
    if (component.derivedFromSceneTargetSha256 !== selected.view.sha256) throw new Error(`scene target component ${component.id} lineage does not match the selected primary view`);
    if (component.crop.x + component.crop.width > viewport.width || component.crop.y + component.crop.height > viewport.height) throw new Error(`scene target component ${component.id} crop exceeds the native viewport`);
    if (component.stateIds.length === 0) throw new Error(`scene target component ${component.id} must apply to at least one state`);
    for (const stateId of component.stateIds) if (!selectedStates.has(stateId)) throw new Error(`scene target component ${component.id} cites unknown selected-candidate state ${stateId}`);
  }
  if (experience) {
    const viewportRect = manifest.nativeGeometry.viewport;
    const viewIds = new Set(selected.candidate.views.map((view) => view.id));
    const regionIds = new Set(experience.composition.regions.map((region) => region.id));
    for (const region of experience.composition.regions) {
      if (region.stateIds.length === 0) throw new Error(`scene target composition region ${region.id} must apply to at least one state`);
      for (const stateId of region.stateIds) if (!selectedStates.has(stateId)) throw new Error(`scene target composition region ${region.id} cites unknown selected-candidate state ${stateId}`);
      if (region.rect.x + region.rect.width > viewportRect.width || region.rect.y + region.rect.height > viewportRect.height) throw new Error(`scene target composition region ${region.id} exceeds the native viewport`);
      for (const allowedId of region.allowsOverlapWith) if (!regionIds.has(allowedId)) throw new Error(`scene target composition region ${region.id} allows overlap with unknown region ${allowedId}`);
    }
    const intersects = (left: SceneTargetRect, right: SceneTargetRect) => left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
    for (let leftIndex = 0; leftIndex < experience.composition.regions.length; leftIndex += 1) {
      const left = experience.composition.regions[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < experience.composition.regions.length; rightIndex += 1) {
        const right = experience.composition.regions[rightIndex]!;
        const sharesState = left.stateIds.some((stateId) => right.stateIds.includes(stateId));
        if (!sharesState || !intersects(left.rect, right.rect)) continue;
        if (!left.allowsOverlapWith.includes(right.id) || !right.allowsOverlapWith.includes(left.id)) throw new Error(`scene target composition regions ${left.id} and ${right.id} overlap in a shared state without mutual allowsOverlapWith declarations`);
      }
    }
    for (const beat of experience.motion.beats) {
      if (beat.stateIds.length === 0) throw new Error(`scene target motion beat ${beat.id} must apply to at least one state`);
      for (const stateId of beat.stateIds) if (!selectedStates.has(stateId)) throw new Error(`scene target motion beat ${beat.id} cites unknown selected-candidate state ${stateId}`);
      if (beat.startViewId && !viewIds.has(beat.startViewId)) throw new Error(`scene target motion beat ${beat.id} cites unknown start view ${beat.startViewId}`);
      if (beat.endViewId && !viewIds.has(beat.endViewId)) throw new Error(`scene target motion beat ${beat.id} cites unknown end view ${beat.endViewId}`);
    }
  }
  return manifest;
}

export function assertSceneTargetReady(manifest: SceneTargetManifest, options: SceneTargetReadinessOptions = {}): void {
  const selected = selectedSceneTarget(manifest);
  if (manifest.approval.status !== "approved") throw new Error(`Scene target is not approved: ${manifest.approval.status}`);
  if (manifest.approval.selectedTargetSha256 !== selected.view.sha256) throw new Error("Scene target approval no longer matches the selected primary view");
  const missingRequiredViews = selected.candidate.views.filter((view) => view.required && !view.path);
  if (missingRequiredViews.length > 0) throw new Error(`Scene target is missing required views: ${missingRequiredViews.map((view) => view.id).join(", ")}`);
  if (options.requireExperienceContract && !manifest.experience) throw new Error("Scene target lacks a composition, typography, and motion experience contract");
  if (options.requiredMotionKinds && options.requiredMotionKinds.length > 0) {
    if (!manifest.experience) throw new Error("Scene target lacks the experience contract required to validate motion kinds");
    const present = new Set(manifest.experience.motion.beats.map((beat) => beat.kind));
    const missing = options.requiredMotionKinds.filter((kind) => !present.has(kind));
    if (missing.length > 0) throw new Error(`Scene target lacks required motion kinds: ${missing.join(", ")}`);
  }
  if (options.requireProducedComponents) {
    const missing = manifest.components.filter((component) => !component.production);
    if (missing.length > 0) throw new Error(`Scene target components lack production lineage: ${missing.map((component) => component.id).join(", ")}`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function sceneTargetSha256(manifest: SceneTargetManifest): string {
  return createHash("sha256").update(JSON.stringify(canonical(manifest))).digest("hex");
}
