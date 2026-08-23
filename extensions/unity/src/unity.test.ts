import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import {
  EMBODIED_TRACE_PROTOCOL,
  ENGINE_EVIDENCE_AUTHORITY,
  UNITY_EVIDENCE_PRODUCER,
  UnityEngine,
  UnityScenarioRunner,
  type UnityProcessRunner,
  unityImportArgs,
  unityPrepareArgs,
  unityScenarioArgs,
  verifyUnityEmbodiedArtifacts
} from "./index.js";

function campaign(root: string, overrides: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "unity-test",
    objective: "prove a Unity interaction",
    projectRoot: root,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["**"],
    acceptance: { primaryMetric: "embodied_proof", direction: "maximize" },
    parameters: { unity: overrides }
  };
}

async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-unity-"));
  await mkdir(resolve(root, "ProjectSettings"), { recursive: true });
  await mkdir(resolve(root, "Packages", "com.gamefactory.bridge"), { recursive: true });
  await mkdir(resolve(root, "Assets", "GameFactory"), { recursive: true });
  await writeFile(resolve(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.11f1\n");
  await writeFile(resolve(root, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.unity.pipeline": "0.3.0-exp.1", "com.unity.inputsystem": "1.11.2", "com.gamefactory.bridge": "file:com.gamefactory.bridge" } }));
  await writeFile(resolve(root, "Packages", "com.gamefactory.bridge", "package.json"), JSON.stringify({ name: "com.gamefactory.bridge", version: "0.1.0" }));
  await writeFile(resolve(root, "Assets", "GameFactory", "scenario.json"), JSON.stringify({ apiVersion: "gamefactory.unity-scenario/v1" }));
  return root;
}

test("Unity CLI argument builders use non-interactive one-shot project commands", () => {
  assert.deepEqual(unityImportArgs("C:\\Game", 120, "C:\\out\\import.log"), [
    "--non-interactive", "--format", "ndjson", "run", "C:\\Game", "--timeout", "120", "--", "-logFile", "C:\\out\\import.log"
  ]);
  assert.deepEqual(unityScenarioArgs("C:\\Game", "gamefactory_run_scenario", 180, "request.json", "result.json"), [
    "--non-interactive", "--format", "ndjson", "run", "C:\\Game", "--command", "gamefactory_run_scenario", "--timeout", "180", "--", "--request", "request.json", "--output", "result.json"
  ]);
  assert.deepEqual(unityPrepareArgs("C:\\Game", "gamefactory_prepare_playmode", 180, "state.json", true), [
    "--non-interactive", "--format", "ndjson", "command", "gamefactory_prepare_playmode", "--project-path", "C:\\Game", "--timeout", "180", "--", "--state", "state.json"
  ]);
});

test("Unity doctor requires Unity 6, Pipeline, Input System, and the factory bridge", async () => {
  const root = await fixtureProject();
  const fake: UnityProcessRunner = async () => ({ exitCode: 0, stdout: "1.0.0-beta.6\n", stderr: "", timedOut: false });
  try {
    const result = await new UnityEngine(fake).doctor({ campaign: campaign(root), projectRoot: root, signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.deepEqual(result.checks.filter((check) => !check.ok), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity embodied verification rejects static proxy evidence and accepts factory input evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-unity-proof-"));
  try {
    const tracePath = resolve(root, "trace.json");
    const frameA = resolve(root, "a.png");
    const frameB = resolve(root, "b.png");
    await writeFile(frameA, Buffer.from("frame-a"));
    await writeFile(frameB, Buffer.from("frame-b"));
    await writeFile(tracePath, JSON.stringify({
      apiVersion: EMBODIED_TRACE_PROTOCOL,
      producer: UNITY_EVIDENCE_PRODUCER,
      samples: [
        { time: 0, input: { delivery: "unity-input-system", control: "<Keyboard>/d" }, actor: { visible: true, position: { x: 0, y: 0, z: 0 } }, events: [] },
        { time: 1.5, input: { delivery: "unity-input-system", control: "<Keyboard>/e" }, actor: { visible: true, position: { x: 2, y: 0, z: 0 } }, events: [
          { kind: "spatial-interaction", outcome: "applied" },
          { kind: "state-change", cause: "player-input", state: "delivered" }
        ] }
      ]
    }));
    const verified = await verifyUnityEmbodiedArtifacts([
      { kind: "replay", path: tracePath, metadata: { protocol: EMBODIED_TRACE_PROTOCOL, producer: UNITY_EVIDENCE_PRODUCER } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } },
      { kind: "image", path: frameB, metadata: { evidenceRole: "continuous-frame" } }
    ], { minimumDurationSeconds: 1, minimumShippingInputEvents: 2, minimumDisplacementUnits: 1, minimumSpatialInteractions: 1, minimumStateConsequences: 1, minimumDistinctFrames: 2 });
    assert.equal(verified.verified, true);
    assert.equal(verified.metrics.embodied_proof, 1);
    const staticResult = await verifyUnityEmbodiedArtifacts([
      { kind: "replay", path: tracePath, metadata: { protocol: EMBODIED_TRACE_PROTOCOL, producer: UNITY_EVIDENCE_PRODUCER } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } }
    ], { minimumDurationSeconds: 1, minimumShippingInputEvents: 2, minimumDisplacementUnits: 1, minimumSpatialInteractions: 1, minimumStateConsequences: 1, minimumDistinctFrames: 2 });
    assert.equal(staticResult.verified, false);
    assert.ok(staticResult.violations.some((violation) => violation.code === "unity.embodied.visible-motion"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity scenario runner preserves engine-authoritative evidence from the bridge", async () => {
  const root = await fixtureProject();
  const calls: string[][] = [];
  const fake: UnityProcessRunner = async (_binary, args) => {
    calls.push(args);
    if (args.includes("gamefactory_prepare_playmode")) return { exitCode: 0, stdout: "play mode prepared", stderr: "", timedOut: false };
    const outputFlag = args.lastIndexOf("--output");
    const resultPath = args[outputFlag + 1]!;
    const output = resolve(resultPath, "..");
    const tracePath = resolve(output, "embodied-trace.json");
    const frameA = resolve(output, "frame-0000.png");
    const frameB = resolve(output, "frame-0001.png");
    await writeFile(frameA, Buffer.from("unity-frame-a"));
    await writeFile(frameB, Buffer.from("unity-frame-b"));
    await writeFile(tracePath, JSON.stringify({
      apiVersion: EMBODIED_TRACE_PROTOCOL,
      producer: UNITY_EVIDENCE_PRODUCER,
      samples: [
        { time: 0, input: { delivery: "unity-input-system", control: "<Keyboard>/d" }, actor: { visible: true, position: { x: 0, y: 0, z: 0 } }, events: [] },
        { time: 2, input: { delivery: "unity-input-system", control: "<Keyboard>/e" }, actor: { visible: true, position: { x: 3, y: 0, z: 0 } }, events: [
          { kind: "spatial-interaction", outcome: "applied" },
          { kind: "state-change", cause: "player-input", state: "activated" }
        ] }
      ]
    }));
    await writeFile(resultPath, JSON.stringify({ status: "pass", metrics: { scenario_ok: 1 }, artifacts: [
      { kind: "replay", path: tracePath, mediaType: "application/json", metadata: { protocol: EMBODIED_TRACE_PROTOCOL, producer: UNITY_EVIDENCE_PRODUCER } },
      { kind: "image", path: frameA, mediaType: "image/png", metadata: { evidenceRole: "continuous-frame", producer: UNITY_EVIDENCE_PRODUCER } },
      { kind: "image", path: frameB, mediaType: "image/png", metadata: { evidenceRole: "continuous-frame", producer: UNITY_EVIDENCE_PRODUCER } }
    ], violations: [] }));
    return { exitCode: 0, stdout: "scenario complete", stderr: "", timedOut: false };
  };
  try {
    const result = await new UnityScenarioRunner(fake).run({
      campaign: campaign(root, { embodiedProof: { minimumDistinctFrames: 2, minimumDisplacementUnits: 1 } }),
      projectRoot: root,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "scenario",
      scenario: { provider: "unity.pipeline/v1", version: "1", path: "Assets/GameFactory/scenario.json" },
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.includes("gamefactory_prepare_playmode"));
    assert.equal(result.metrics.embodied_proof, 1);
    assert.ok(result.artifacts.some((artifact) => artifact.metadata?.evidenceAuthority === ENGINE_EVIDENCE_AUTHORITY));
    assert.ok(result.artifacts.some((artifact) => artifact.metadata?.evidenceClass === "embodied-gameplay" && artifact.metadata?.verified === true));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity bridge registers a Pipeline command and injects Input System controls", async () => {
  const source = await readFile(resolve(process.cwd(), "bridges", "unity", "com.gamefactory.bridge", "Editor", "GameFactoryScenarioCommand.cs"), "utf8");
  assert.match(source, /CliCommand\("gamefactory_prepare_playmode"/);
  assert.match(source, /CliCommand\("gamefactory_run_scenario"/);
  assert.match(source, /InputSystem\.FindControl/);
  assert.match(source, /QueueDeltaStateEvent/);
  assert.match(source, /QueueStateEvent/);
  assert.match(source, /factory-owned-unity-bridge/);
  assert.match(source, /CaptureScreenshot|RenderFrame/);
});
