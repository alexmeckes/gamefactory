import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import {
  EMBODIED_TRACE_PROTOCOL,
  DEFAULT_UNITY_BRIDGE_ROOT,
  ENGINE_EVIDENCE_AUTHORITY,
  UNITY_EVIDENCE_PRODUCER,
  UnityEvidenceAgent,
  UnityEngine,
  UnityScenarioRunner,
  type UnityProcessRunner,
  redactUnitySecrets,
  unityEditorPid,
  unityImportArgs,
  unityLogHasErrors,
  unityOpenArgs,
  unityPrepareArgs,
  unityScenarioArgs,
  unityStatusArgs,
  unityCandidateSnapshot,
  verifyUnityEmbodiedArtifacts
} from "./index.js";

test("Unity evidence driver does not claim agent-team control files", () => {
  const driver = new UnityEvidenceAgent(null as never, null as never);
  assert.deepEqual([...driver.writePaths], ["evidence/**"]);
});

test("Unity candidate snapshots bind dirty authored content without including evidence output", async () => {
  const root = await fixtureProject();
  try {
    const candidate = { id: "candidate", root, baseRevision: "a".repeat(40), metadata: {} };
    const before = await unityCandidateSnapshot(candidate);
    await writeFile(resolve(root, "Assets", "GameFactory", "runtime.cs"), "first\n", "utf8");
    const after = await unityCandidateSnapshot(candidate);
    assert.notEqual(after.sha256, before.sha256);
    assert.equal(after.baseRevision, candidate.baseRevision);
    await mkdir(resolve(root, ".factory", "runs"), { recursive: true });
    await writeFile(resolve(root, ".factory", "runs", "evidence.json"), "volatile\n", "utf8");
    assert.equal((await unityCandidateSnapshot(candidate)).sha256, after.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
  await mkdir(resolve(root, "Packages"), { recursive: true });
  await mkdir(resolve(root, "Assets", "GameFactory"), { recursive: true });
  await writeFile(resolve(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.11f1\n");
  await writeFile(resolve(root, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.unity.pipeline": "0.3.0-exp.1", "com.unity.inputsystem": "1.11.2", "com.gamefactory.bridge": `file:${DEFAULT_UNITY_BRIDGE_ROOT}` } }));
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
  assert.deepEqual(unityOpenArgs("C:\\Game"), ["--non-interactive", "--format", "json", "open", "C:\\Game"]);
  assert.deepEqual(unityStatusArgs("C:\\Game"), ["--non-interactive", "--format", "json", "status", "--project-path", "C:\\Game"]);
  assert.equal(unityEditorPid(JSON.stringify({ success: true, data: { instances: [{ pid: 4242 }] } })), 4242);
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

test("Unity doctor rejects a candidate-owned bridge even when its package name matches", async () => {
  const root = await fixtureProject();
  const embedded = resolve(root, "Packages", "com.gamefactory.bridge");
  const fake: UnityProcessRunner = async () => ({ exitCode: 0, stdout: "1.0.0-beta.6\n", stderr: "", timedOut: false });
  try {
    await mkdir(embedded, { recursive: true });
    await writeFile(resolve(embedded, "package.json"), JSON.stringify({ name: "com.gamefactory.bridge", version: "0.1.0" }));
    await writeFile(resolve(root, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.unity.pipeline": "0.3.0-exp.1", "com.unity.inputsystem": "1.11.2", "com.gamefactory.bridge": "file:com.gamefactory.bridge" } }));
    const result = await new UnityEngine(fake).doctor({ campaign: campaign(root), projectRoot: root, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "unity.bridge")?.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity import rejects compiler errors hidden behind a zero launcher exit", async () => {
  const root = await fixtureProject();
  const fake: UnityProcessRunner = async (_binary, args) => {
    const logPath = args[args.lastIndexOf("-logFile") + 1]!;
    await writeFile(logPath, "Assets/Broken.cs(1,1): error CS1002: ; expected\n", "utf8");
    return { exitCode: 0, stdout: "launcher completed", stderr: "", timedOut: false };
  };
  try {
    assert.equal(unityLogHasErrors("error CS1002: ; expected"), true);
    const result = await new UnityEngine(fake).build({ campaign: campaign(root), projectRoot: root, candidate: { id: "candidate", root, metadata: {} }, experimentId: "import", signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(result.metrics?.import_ok, 0);
    assert.match(result.stderr, /compiler or batch-mode errors/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity import removes Hub access tokens from returned and preserved logs", async () => {
  const root = await fixtureProject();
  const secret = "unity-hub-secret-token";
  const fake: UnityProcessRunner = async (_binary, args) => {
    const rawLogPath = args[args.lastIndexOf("-logFile") + 1]!;
    await writeFile(rawLogPath, `Unity command line\n-accessToken\n${secret}\nImport complete\n`, "utf8");
    return { exitCode: 0, stdout: `launcher --access-token ${secret} completed`, stderr: `-accessToken=${secret}`, timedOut: false };
  };
  try {
    assert.doesNotMatch(redactUnitySecrets(`-accessToken\n${secret}`), new RegExp(secret));
    const result = await new UnityEngine(fake).build({ campaign: campaign(root), projectRoot: root, candidate: { id: "candidate", root, metadata: {} }, experimentId: "import-secret", signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    const importArtifact = result.artifacts?.find((artifact) => artifact.label === "Unity import log");
    assert.ok(importArtifact);
    assert.doesNotMatch(await readFile(importArtifact.path, "utf8"), new RegExp(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity evidence returns a repairable revision with import diagnostics for candidate compile failures", async () => {
  const root = await fixtureProject();
  const fake: UnityProcessRunner = async (_binary, args) => {
    const logPath = args[args.lastIndexOf("-logFile") + 1]!;
    await writeFile(logPath, "Assets/Broken.cs(1,1): error CS1002: ; expected\n", "utf8");
    return { exitCode: 0, stdout: "launcher completed", stderr: "", timedOut: false };
  };
  try {
    const result = await new UnityEvidenceAgent(new UnityEngine(fake), null as never).run({
      campaign: campaign(root, { importCheck: true }),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "import-repair",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(result.metadata?.outcome, "revise");
    assert.equal((result.metadata?.structured as { status?: string }).status, "fail");
    assert.ok(result.artifacts?.some((artifact) => artifact.label === "Unity import log"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity evidence marks import timeouts as infrastructure and carries durable logs", async () => {
  const root = await fixtureProject();
  const fake: UnityProcessRunner = async () => ({ exitCode: 1, stdout: "", stderr: "licensing IPC unavailable", timedOut: true });
  try {
    await assert.rejects(
      new UnityEvidenceAgent(new UnityEngine(fake), null as never).run({
        campaign: campaign(root, { importCheck: true }),
        candidate: { id: "candidate", root, metadata: {} },
        experimentId: "import-infrastructure",
        history: [],
        signal: new AbortController().signal
      }),
      (error: unknown) => {
        assert.equal((error as { failureClass?: string }).failureClass, "infrastructure");
        assert.ok(((error as { artifacts?: unknown[] }).artifacts?.length ?? 0) >= 2);
        return true;
      }
    );
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
    const authority = { root: DEFAULT_UNITY_BRIDGE_ROOT, sha256: "trusted-test-bridge" };
    const verified = await verifyUnityEmbodiedArtifacts([
      { kind: "replay", path: tracePath, metadata: { protocol: EMBODIED_TRACE_PROTOCOL, producer: UNITY_EVIDENCE_PRODUCER, trustedBridgeSha256: authority.sha256 } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } },
      { kind: "image", path: frameB, metadata: { evidenceRole: "continuous-frame" } }
    ], { minimumDurationSeconds: 1, minimumShippingInputEvents: 2, minimumDisplacementUnits: 1, minimumSpatialInteractions: 1, minimumStateConsequences: 1, minimumDistinctFrames: 2 }, authority);
    assert.equal(verified.verified, true);
    assert.equal(verified.metrics.embodied_proof, 1);
    const staticResult = await verifyUnityEmbodiedArtifacts([
      { kind: "replay", path: tracePath, metadata: { protocol: EMBODIED_TRACE_PROTOCOL, producer: UNITY_EVIDENCE_PRODUCER, trustedBridgeSha256: authority.sha256 } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } },
      { kind: "image", path: frameA, metadata: { evidenceRole: "continuous-frame" } }
    ], { minimumDurationSeconds: 1, minimumShippingInputEvents: 2, minimumDisplacementUnits: 1, minimumSpatialInteractions: 1, minimumStateConsequences: 1, minimumDistinctFrames: 2 }, authority);
    assert.equal(staticResult.verified, false);
    assert.ok(staticResult.violations.some((violation) => violation.code === "unity.embodied.visible-motion"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity scenario runner preserves engine-authoritative evidence from the bridge", async () => {
  const root = await fixtureProject();
  const calls: string[][] = [];
  const fake: UnityProcessRunner = async (_binary, args) => {
    calls.push(args);
    if (args.includes("open")) return { exitCode: 0, stdout: "opened", stderr: "", timedOut: false };
    if (args.includes("status")) return { exitCode: 0, stdout: JSON.stringify({ success: true, data: { instances: [{ pid: 4242 }] } }), stderr: "", timedOut: false };
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
    const result = await new UnityScenarioRunner(fake, async () => {}, async () => {}).run({
      campaign: campaign(root, { embodiedProof: { minimumDistinctFrames: 2, minimumDisplacementUnits: 1 } }),
      projectRoot: root,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "scenario",
      scenario: { provider: "unity.pipeline/v1", version: "1", path: "Assets/GameFactory/scenario.json" },
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(calls.length, 4);
    assert.ok(calls[0]!.includes("open"));
    assert.ok(calls[1]!.includes("status"));
    assert.ok(calls[2]!.includes("gamefactory_prepare_playmode"));
    assert.ok(calls[2]!.includes("command"));
    assert.equal(result.metrics.embodied_proof, 1);
    assert.ok(result.artifacts.some((artifact) => artifact.metadata?.evidenceAuthority === ENGINE_EVIDENCE_AUTHORITY));
    assert.ok(result.artifacts.some((artifact) => artifact.metadata?.evidenceClass === "embodied-gameplay" && artifact.metadata?.verified === true));
    assert.ok(result.artifacts.filter((artifact) => artifact.kind === "image" || artifact.kind === "replay").every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity evidence publishes the revision-bound manifest first with complete scenario frame mapping", async () => {
  const root = await fixtureProject();
  const tracePath = resolve(root, "trace.json");
  const framePath = resolve(root, "frame.png");
  await writeFile(tracePath, "{}", "utf8");
  await writeFile(framePath, "frame", "utf8");
  const runner = {
    id: "fixture",
    async run() {
      return {
        status: "pass" as const,
        metrics: { embodied_proof: 1 },
        violations: [],
        artifacts: [
          { kind: "replay" as const, path: tracePath, sha256: "b".repeat(64), metadata: { evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY } },
          { kind: "image" as const, path: framePath, sha256: "c".repeat(64), metadata: { evidenceRole: "continuous-frame", frame: 7, evidenceAuthority: ENGINE_EVIDENCE_AUTHORITY } }
        ]
      };
    }
  };
  try {
    const candidate = { id: "candidate", root, baseRevision: "a".repeat(40), metadata: {} };
    const result = await new UnityEvidenceAgent(null as never, runner).run({
      campaign: campaign(root, { importCheck: false, scenarios: [{ id: "harvest", path: "Assets/GameFactory/scenario.json" }] }),
      candidate,
      experimentId: "manifest-test",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(result.artifacts?.[0]?.label, "Fresh Unity evidence manifest");
    const manifest = JSON.parse(await readFile(result.artifacts![0]!.path, "utf8")) as { candidateSnapshot: { sha256: string; baseRevision: string }; scenarioBundles: Array<{ id: string; trace: { sha256: string }; frames: Array<{ sha256: string; frame: number; sampleIndex: number }> }> };
    assert.match(manifest.candidateSnapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.candidateSnapshot.baseRevision, candidate.baseRevision);
    assert.equal(manifest.scenarioBundles[0]!.id, "harvest");
    assert.equal(manifest.scenarioBundles[0]!.trace.sha256, "b".repeat(64));
    assert.deepEqual(manifest.scenarioBundles[0]!.frames[0], { path: framePath, sha256: "c".repeat(64), frame: 7, sampleIndex: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unity scenario runner launches one Editor, polls readiness, and retries attached commands", async () => {
  const root = await fixtureProject();
  const calls: string[][] = [];
  const waits: number[] = [];
  let preparationAttempts = 0;
  let statusAttempts = 0;
  const fake: UnityProcessRunner = async (_binary, args) => {
    calls.push(args);
    if (args.includes("open")) return { exitCode: 0, stdout: "opened", stderr: "", timedOut: false };
    if (args.includes("status")) {
      statusAttempts += 1;
      if (statusAttempts === 1) return { exitCode: 1, stdout: JSON.stringify({ success: false, errors: [{ code: "STATUS_NO_INSTANCES" }] }), stderr: "", timedOut: false };
      return { exitCode: 0, stdout: JSON.stringify({ success: true, data: { instances: [{ processId: "5151" }] } }), stderr: "", timedOut: false };
    }
    if (args.includes("gamefactory_prepare_playmode")) {
      preparationAttempts += 1;
      if (preparationAttempts === 1) {
        return {
          exitCode: 6,
          stdout: "Pipeline server returned 503 Service Unavailable: Server Busy. The Editor is still settling after startup.",
          stderr: "",
          timedOut: false
        };
      }
      return { exitCode: 0, stdout: "play mode prepared", stderr: "", timedOut: false };
    }
    const outputFlag = args.lastIndexOf("--output");
    const resultPath = args[outputFlag + 1]!;
    await writeFile(resultPath, JSON.stringify({ status: "pass", metrics: {}, artifacts: [], violations: [] }));
    return { exitCode: 0, stdout: "scenario complete", stderr: "", timedOut: false };
  };
  const terminated: number[] = [];
  try {
    const runner = new UnityScenarioRunner(fake, async (milliseconds) => { waits.push(milliseconds); }, async (pid) => { terminated.push(pid); });
    const result = await runner.run({
      campaign: campaign(root),
      projectRoot: root,
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "scenario-ready-retry",
      scenario: { provider: "unity.pipeline/v1", version: "1", path: "Assets/GameFactory/scenario.json" },
      signal: new AbortController().signal
    });
    assert.equal(result.status, "pass");
    assert.equal(preparationAttempts, 2);
    assert.equal(statusAttempts, 2);
    assert.deepEqual(waits, [2_000, 1_000]);
    assert.equal(calls.filter((args) => args.includes("open")).length, 1);
    assert.equal(calls.filter((args) => args.includes("run")).length, 0);
    assert.ok(calls.filter((args) => args.includes("command")).length >= 3);
    await runner.releaseProject(root);
    assert.deepEqual(terminated, [5151]);
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
