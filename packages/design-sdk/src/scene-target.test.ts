import assert from "node:assert/strict";
import test from "node:test";
import { assertSceneTargetReady, parseSceneTarget, sceneTargetSha256 } from "./scene-target.js";

const targetHash = "a".repeat(64);

function fixture() {
  return {
    apiVersion: "gamefactory.scene-target/v1",
    id: "fixture-scene",
    version: "1.0.0",
    selectedCandidateId: "candidate-a",
    nativeGeometry: {
      viewport: { width: 320, height: 180 },
      baseUnitPx: 4,
      borderWidthsPx: [1, 2],
      typographyPx: { body: 8, heading: 16 },
      scalingRules: ["Raster components use native dimensions or declared integer scaling."]
    },
    candidates: [{
      id: "candidate-a",
      label: "Approved gameplay language",
      primaryViewId: "planning",
      views: [
        { id: "planning", label: "Planning", state: "planning", path: "design/targets/planning.png", sha256: targetHash, prompt: "A complete readable planning screen", required: true },
        { id: "action", label: "Action", state: "action", path: "design/targets/action.png", sha256: "b".repeat(64), prompt: "The same screen during action", required: true }
      ]
    }],
    components: [{
      id: "action-button",
      label: "Action button",
      sourceViewId: "planning",
      crop: { x: 240, y: 140, width: 64, height: 24 },
      stateIds: ["planning", "action"],
      derivedFromSceneTargetSha256: targetHash
    }],
    approval: { status: "approved", reviewer: "fixture-director", selectedTargetSha256: targetHash, findings: [] }
  };
}

test("scene target contract validates an approved pre-production target", () => {
  const manifest = parseSceneTarget(fixture());
  assert.doesNotThrow(() => assertSceneTargetReady(manifest));
  assert.throws(() => assertSceneTargetReady(manifest, { requireProducedComponents: true }), /lack production lineage/);
  assert.equal(sceneTargetSha256(manifest), sceneTargetSha256(parseSceneTarget(JSON.parse(JSON.stringify(fixture())))));

  const pending = fixture();
  pending.approval.status = "needs-revision";
  assert.throws(() => assertSceneTargetReady(parseSceneTarget(pending)), /not approved/);
});

test("scene target contract validates production lineage and native scaling", () => {
  const base = fixture();
  const raw = { ...base, components: base.components.map((component) => ({
    ...component,
    production: {
      method: "regenerate",
      sourcePath: "design/components/action-button-source.png",
      sourceSha256: "c".repeat(64),
      runtimePath: "assets/ui/action-button.png",
      runtimeSha256: "d".repeat(64),
      nativeSize: { width: 64, height: 24 },
      renderSize: { width: 64, height: 24 },
      scaling: "native-1:1",
      matchEvidence: [{ kind: "composite", path: "design/evidence/action-button-composite.png", sha256: "e".repeat(64) }]
    }
  })) };
  const manifest = parseSceneTarget(raw);
  assert.doesNotThrow(() => assertSceneTargetReady(manifest, { requireProducedComponents: true }));

  raw.components[0]!.production.renderSize.width = 63;
  assert.throws(() => parseSceneTarget(raw), /native-1:1 scaling/);
});

test("scene target contract rejects broken target selection and component geometry", () => {
  const badApproval = fixture();
  badApproval.approval.selectedTargetSha256 = "f".repeat(64);
  assert.throws(() => parseSceneTarget(badApproval), /approval hash/);

  const badCrop = fixture();
  badCrop.components[0]!.crop.width = 100;
  assert.throws(() => parseSceneTarget(badCrop), /crop exceeds/);

  const badLineage = fixture();
  badLineage.components[0]!.derivedFromSceneTargetSha256 = "f".repeat(64);
  assert.throws(() => parseSceneTarget(badLineage), /lineage/);

  const badState = fixture();
  badState.components[0]!.stateIds = ["missing"];
  assert.throws(() => parseSceneTarget(badState), /unknown selected-candidate state/);
});

test("scene target experience contract makes layout, typography, and motion reviewable", () => {
  const raw: any = fixture();
  raw.experience = {
    composition: {
      regions: [
        { id: "playfield", label: "Playfield", stateIds: ["planning", "action"], rect: { x: 0, y: 0, width: 220, height: 180 }, allowsOverlapWith: [] },
        { id: "command-rail", label: "Command rail", stateIds: ["planning", "action"], rect: { x: 220, y: 0, width: 100, height: 180 }, allowsOverlapWith: [] }
      ],
      rules: ["Peer regions do not collide; overlays must be declared intentionally."]
    },
    typography: {
      mode: "hybrid",
      roles: [
        { id: "display", label: "Display", purpose: "Short identity labels", treatment: "Authored pixel display face" },
        { id: "body", label: "Body", purpose: "Dense gameplay explanation", treatment: "Readable non-pixel text face" }
      ],
      rules: ["Pixel display type is an accent, not the default for dense copy."]
    },
    motion: {
      beats: [
        { id: "camp-life", label: "Camp life", kind: "ambient", stateIds: ["planning"], trigger: "Planning is idle", visibleResponse: "A restrained environmental loop prevents a frozen tableau", startViewId: "planning", endViewId: "planning" },
        { id: "selection", label: "Selection", kind: "interaction", stateIds: ["planning"], trigger: "The player changes a choice", visibleResponse: "The selected control and affected formation respond", startViewId: "planning", endViewId: "planning" },
        { id: "impact", label: "Impact", kind: "gameplay", stateIds: ["action"], trigger: "An attack resolves", visibleResponse: "The acting and receiving units complete a readable causal phrase", startViewId: "action", endViewId: "action" },
        { id: "result", label: "Result", kind: "transition", stateIds: ["action"], trigger: "The encounter resolves", visibleResponse: "The scene settles into its result without an abrupt cut", startViewId: "action", endViewId: "action" }
      ],
      continuityRules: ["Characters, scale, and spatial anchors remain continuous across every beat."]
    }
  };
  const manifest = parseSceneTarget(raw);
  assert.doesNotThrow(() => assertSceneTargetReady(manifest, {
    requireExperienceContract: true,
    requiredMotionKinds: ["ambient", "interaction", "gameplay", "transition"]
  }));
  assert.equal(manifest.experience?.typography.mode, "hybrid");

  const missing = parseSceneTarget(fixture());
  assert.throws(() => assertSceneTargetReady(missing, { requireExperienceContract: true }), /lacks a composition, typography, and motion experience contract/);
  const incompleteRaw: any = JSON.parse(JSON.stringify(raw));
  incompleteRaw.experience.motion.beats = incompleteRaw.experience.motion.beats.filter((beat: { kind: string }) => beat.kind !== "ambient");
  const incomplete = parseSceneTarget(incompleteRaw);
  assert.throws(() => assertSceneTargetReady(incomplete, { requiredMotionKinds: ["ambient", "interaction", "gameplay", "transition"] }), /lacks required motion kinds: ambient/);
});

test("scene target experience contract rejects accidental peer-region overlap", () => {
  const raw: any = fixture();
  raw.experience = {
    composition: {
      regions: [
        { id: "playfield", label: "Playfield", stateIds: ["planning"], rect: { x: 0, y: 0, width: 240, height: 180 }, allowsOverlapWith: [] },
        { id: "command-rail", label: "Command rail", stateIds: ["planning"], rect: { x: 220, y: 0, width: 100, height: 180 }, allowsOverlapWith: [] }
      ],
      rules: ["Overlays are explicit."]
    },
    typography: { mode: "non-pixel", roles: [{ id: "body", label: "Body", purpose: "Gameplay copy", treatment: "Readable UI face" }], rules: ["Prioritize legibility."] },
    motion: { beats: [{ id: "selection", label: "Selection", kind: "interaction", stateIds: ["planning"], trigger: "Select", visibleResponse: "Respond" }], continuityRules: ["Preserve anchors."] }
  };
  assert.throws(() => parseSceneTarget(raw), /overlap in a shared state without mutual/);
});
