import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { LocalCredentialStore, type ArtifactReference, type Campaign, type CredentialCipher, type Evaluation } from "@gamefactory/core";
import { GeminiVisualEvaluator, GeminiVisualReviewAgent } from "./index.js";

class FixtureCipher implements CredentialCipher {
  async seal(value: string): Promise<string> { return Buffer.from(value).toString("base64"); }
  async unseal(value: string): Promise<string> { return Buffer.from(value, "base64").toString(); }
}

function campaign(root: string, overrides: Record<string, unknown> = {}): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "gemini-visual-test",
    objective: "A readable moving actor delivers an item in a coherent world",
    projectRoot: root,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["**"],
    acceptance: { primaryMetric: "gemini_visual_score", direction: "maximize" },
    parameters: { geminiVisualReview: {
      checkpoint: "production",
      credentialName: "google.gemini",
      apiKeyEnvironment: "GAMEFACTORY_MISSING_GEMINI_TEST_KEY",
      minimumImages: 3,
      maximumImages: 6,
      minimumScore: 70,
      maximumReviews: 4,
      requireEmbodiedTrace: true,
      ...overrides
    } }
  };
}

function png(marker: number): Buffer {
  const bytes = Buffer.alloc(32, marker);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(32, 16);
  bytes.writeUInt32BE(32, 20);
  return bytes;
}

async function evidence(root: string): Promise<{ artifacts: ArtifactReference[]; evaluation: Evaluation }> {
  const directory = resolve(root, "engine-evidence");
  await mkdir(directory, { recursive: true });
  const tracePath = resolve(directory, "trace.json");
  await writeFile(tracePath, JSON.stringify({ apiVersion: "gamefactory.embodied-trace/v1", producer: "factory-owned-godot-probe", samples: [{ time: 0 }, { time: 2 }] }));
  const artifacts: ArtifactReference[] = [{ kind: "replay", path: tracePath, mediaType: "application/json", label: "Verified trace", metadata: { protocol: "gamefactory.embodied-trace/v1", evidenceClass: "embodied-gameplay", verified: true } }];
  for (let index = 0; index < 3; index += 1) {
    const path = resolve(directory, `frame-${index}.png`);
    await writeFile(path, png(index + 1));
    artifacts.push({ kind: "image", path, mediaType: "image/png", label: `Engine frame ${index}`, metadata: { producer: "factory-owned-godot-probe", evidenceRole: "continuous-frame", frame: index } });
  }
  return { artifacts, evaluation: { evaluator: "godot.scenario", version: "test", status: "pass", metrics: { embodied_proof: 1 }, violations: [], artifacts } };
}

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "pass",
    confidence: 0.86,
    summary: "The actor, route, interaction, and consequence remain readable across the sequence.",
    scores: {
      gameplayLegibility: 82,
      focalHierarchy: 80,
      layoutIntegrity: 84,
      typography: 76,
      scaleConsistency: 79,
      authoredSpecificity: 78,
      targetFidelity: 0,
      motionFeedback: 81,
      sceneLife: 75
    },
    notApplicable: ["targetFidelity"],
    strengths: ["The moving actor stays visually dominant."],
    findings: [],
    ...overrides
  };
}

async function credentialStore(): Promise<{ root: string; store: LocalCredentialStore; secret: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-credentials-"));
  const store = new LocalCredentialStore({ root, cipher: new FixtureCipher() });
  const secret = "fixture-gemini-key-never-persist";
  await store.set("google.gemini", secret);
  return { root, store, secret };
}

test("Gemini visual evaluator sends ordered multimodal evidence, enforces structured output, and reports usage", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-visual-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  let requestBody: Record<string, unknown> | undefined;
  let apiKey = "";
  let apiRevision = "";
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    apiKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
    apiRevision = new Headers(init?.headers).get("api-revision") ?? "";
    return new Response(JSON.stringify({ output_text: JSON.stringify(review()), usage: { input_tokens: 1200, output_tokens: 240, total_tokens: 1440 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }).evaluate({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-review", priorEvaluations: [prior.evaluation], signal: new AbortController().signal });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.gemini_visual_review, 1);
    assert.equal(result.usage?.model, "gemini-3.7-flash");
    assert.equal(result.usage?.totalTokens, 1440);
    assert.equal(apiKey, credentials.secret);
    assert.equal(apiRevision, "2026-05-20");
    assert.equal(requestBody?.model, "gemini-3.7-flash");
    assert.equal("generation_config" in (requestBody ?? {}), false);
    const inputs = requestBody?.input as Array<Record<string, unknown>>;
    assert.equal(inputs.filter((item) => item.type === "image").length, 3);
    assert.ok(inputs.filter((item) => item.type === "image").every((item) => item.resolution === "high"));
    assert.deepEqual((requestBody?.response_format as Record<string, unknown>).mime_type, "application/json");
    const stored = await readFile(resolve(root, ".factory", "runs", "exp-review", "gemini-visual-review", "review.json"), "utf8");
    assert.doesNotMatch(stored, new RegExp(credentials.secret));
    assert.match(stored, /runtime-image-001/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini production review turns evidence-cited major defects into bounded repair findings", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-revise-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const major = {
    id: "ui-overlap",
    severity: "major",
    owner: "implementation",
    affectedState: "delivery impact",
    evidenceIds: ["runtime-image-002"],
    timestampSeconds: null,
    violatedContract: "layout integrity",
    playerImpact: "The confirmation panel obscures the recipient and consequence.",
    repair: "Move the confirmation panel below the interaction plane and preserve the actor silhouette.",
    regressionEvidence: "Recapture the impact frame at the shipping viewport."
  };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(review({ verdict: "revise", findings: [major] })) }), { status: 200 });
  try {
    const result = await new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }).evaluate({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-revise", priorEvaluations: [prior.evaluation], signal: new AbortController().signal });
    assert.equal(result.status, "fail");
    assert.ok(result.violations.some((violation) => violation.code === "gemini.visual.ui-overlap" && violation.severity === "error"));
    assert.match(result.violations[0]?.message ?? "", /runtime-image-002/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini production review reserves evidence capacity for the hash-pinned approved target", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-target-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const targetPath = resolve(root, "target.png");
  const targetBytes = png(42);
  await writeFile(targetPath, targetBytes);
  await writeFile(resolve(root, "scene-target.json"), JSON.stringify({
    selectedCandidateId: "direction-a",
    candidates: [{ id: "direction-a", primaryViewId: "primary", views: [{ id: "primary", path: "target.png", sha256: createHash("sha256").update(targetBytes).digest("hex") }] }]
  }));
  let inputs: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    inputs = body.input as Array<Record<string, unknown>>;
    return new Response(JSON.stringify({ output_text: JSON.stringify(review({ notApplicable: [], scores: { ...(review().scores as Record<string, number>), targetFidelity: 84 } })) }), { status: 200 });
  };
  try {
    const configured = campaign(root, { contractPaths: ["scene-target.json"], minimumImages: 2, maximumImages: 3 });
    const result = await new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }).evaluate({ campaign: configured, candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-target", priorEvaluations: [prior.evaluation], signal: new AbortController().signal });
    assert.equal(result.status, "pass", JSON.stringify(result.violations));
    assert.equal(inputs.filter((item) => item.type === "image").length, 3);
    assert.match(String(inputs[1]?.text), /Evidence target-image-001/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini visual review fails before network I/O without evaluator-verified embodied evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-untrusted-"));
  const credentials = await credentialStore();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return new Response("{}"); };
  try {
    const result = await new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }).evaluate({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-untrusted", priorEvaluations: [], signal: new AbortController().signal });
    assert.equal(result.status, "fail");
    assert.equal(calls, 0);
    assert.match(result.violations[0]?.message ?? "", /evaluator-verified embodied gameplay trace/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini graph driver makes provider failures retryable and preserves bounded diagnostics", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-provider-failure-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const experimentId = "exp-provider-failure";
  const manifestDirectory = resolve(root, ".factory", "runs", experimentId, "godot-evidence");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(resolve(manifestDirectory, "result.json"), JSON.stringify({ status: "pass", artifacts: prior.artifacts }));
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "temperature is not supported for this model" } }), { status: 400 });
  try {
    const driver = new GeminiVisualReviewAgent("embodied", new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }));
    await assert.rejects(
      driver.run({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId, history: [], signal: new AbortController().signal }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 400: INVALID_ARGUMENT: temperature is not supported/);
        const artifacts = (error as Error & { artifacts?: ArtifactReference[] }).artifacts ?? [];
        assert.ok(artifacts.some((artifact) => artifact.label === "Gemini multimodal visual review"));
        return true;
      }
    );
    const report = await readFile(resolve(root, ".factory", "runs", experimentId, "gemini-visual-review", "review.json"), "utf8");
    assert.match(report, /INVALID_ARGUMENT/);
    assert.ok(report.length < 4096);
    assert.doesNotMatch(report, new RegExp(credentials.secret));
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini visual evaluator falls back to locally validated JSON on a structured-request 400", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-compatibility-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { code: 400, message: "Request contains an invalid argument." } }), { status: 400 });
    return new Response(JSON.stringify({ output_text: `\`\`\`json\n${JSON.stringify(review())}\n\`\`\`` }), { status: 200 });
  };
  try {
    const result = await new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store }).evaluate({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-compatibility", priorEvaluations: [prior.evaluation], signal: new AbortController().signal });
    assert.equal(result.status, "pass", JSON.stringify(result.violations));
    assert.equal(bodies.length, 2);
    assert.ok("response_format" in bodies[0]!);
    assert.equal("response_format" in bodies[1]!, false);
    assert.ok((bodies[1]!.input as Array<Record<string, unknown>>).filter((item) => item.type === "image").every((item) => !("resolution" in item)));
    const report = JSON.parse(await readFile(resolve(root, ".factory", "runs", "exp-compatibility", "gemini-visual-review", "review.json"), "utf8")) as Record<string, unknown>;
    assert.equal(report.compatibilityFallback, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini graph driver reads factory Godot evidence and exposes structured findings to repair orchestration", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-driver-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const manifestDirectory = resolve(root, ".factory", "runs", "exp-driver", "godot-evidence");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(resolve(manifestDirectory, "result.json"), JSON.stringify({ status: "pass", artifacts: prior.artifacts }));
  const finding = {
    id: "static-impact",
    severity: "blocker",
    owner: "implementation",
    affectedState: "interaction",
    evidenceIds: ["runtime-image-003"],
    timestampSeconds: null,
    violatedContract: "visible consequence",
    playerImpact: "The state changes but the rendered scene does not communicate it.",
    repair: "Add state-linked recipient and item feedback without changing the mechanic.",
    regressionEvidence: "Recapture pre-input, impact, and recovery frames."
  };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(review({ verdict: "revise", findings: [finding] })) }), { status: 200 });
  try {
    const evaluator = new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store });
    const result = await new GeminiVisualReviewAgent("production", evaluator).run({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-driver", history: [], signal: new AbortController().signal });
    assert.equal(result.metadata?.outcome, "revise");
    const structured = result.metadata?.structured as Record<string, unknown>;
    const canonicalFinding = (structured.findings as Array<Record<string, unknown>>)[0];
    assert.equal(canonicalFinding?.owner, "implementation");
    assert.equal(canonicalFinding?.findingClass, "blocker");
    assert.deepEqual(canonicalFinding?.claimIds, ["visual.production-fidelity"]);
    assert.deepEqual(canonicalFinding?.evidence, ["runtime-image-003"]);
    assert.ok(Array.isArray(structured.evidence));
    assert.equal((structured.findings as unknown[]).length, 1);
    assert.equal(result.contributors?.[0]?.usage?.model, "gemini-3.7-flash");
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials.root, { recursive: true, force: true }); }
});

test("Gemini driver synthesizes a claim-linked blocker when the evaluator rejects without blocker-severity findings", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-evaluator-rejection-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  const experimentId = "exp-evaluator-rejection";
  const manifestDirectory = resolve(root, ".factory", "runs", experimentId, "godot-evidence");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(resolve(manifestDirectory, "result.json"), JSON.stringify({ status: "pass", artifacts: prior.artifacts }));
  const opportunity = {
    id: "minor-hierarchy-note",
    severity: "minor",
    owner: "implementation",
    affectedState: "interaction",
    evidenceIds: ["runtime-image-002"],
    timestampSeconds: null,
    violatedContract: "secondary hierarchy",
    playerImpact: "A secondary label could be quieter.",
    repair: "Reduce the secondary label emphasis.",
    regressionEvidence: "Recapture the interaction frame."
  };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(review({ verdict: "revise", findings: [opportunity] })) }), { status: 200 });
  try {
    const result = await new GeminiVisualReviewAgent("production", new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store })).run({
      campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId, history: [], signal: new AbortController().signal
    });
    assert.equal(result.metadata?.outcome, "revise");
    const findings = ((result.metadata?.structured as Record<string, unknown>).findings as Array<Record<string, unknown>>);
    assert.ok(findings.some((finding) => finding.id === "gemini-evaluator-rejection" && finding.findingClass === "blocker"));
    assert.deepEqual(findings.find((finding) => finding.id === "gemini-evaluator-rejection")?.claimIds, ["visual.production-fidelity"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials.root, { recursive: true, force: true });
  }
});

test("Gemini graph driver reads generic Unity engine-evidence manifests", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-gemini-unity-driver-"));
  const credentials = await credentialStore();
  const prior = await evidence(root);
  for (const artifact of prior.artifacts) artifact.metadata = { ...(artifact.metadata ?? {}), evidenceAuthority: "factory-engine", engine: "unity" };
  const manifestDirectory = resolve(root, ".factory", "runs", "exp-unity-driver", "engine-evidence");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(resolve(manifestDirectory, "result.json"), JSON.stringify({ evaluator: "unity.scenario", engine: "unity", status: "pass", artifacts: prior.artifacts }));
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(review()) }), { status: 200 });
  try {
    const result = await new GeminiVisualReviewAgent("embodied", new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store })).run({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-unity-driver",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(result.metadata?.outcome, "pass");
    assert.equal((result.metadata?.structured as Record<string, unknown>).verdict, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials.root, { recursive: true, force: true });
  }
});

test("Gemini graph driver routes target and spec contradictions away from implementation repair", async () => {
  for (const [owner, expected] of [["target", "target_revision"], ["spec", "spec_amendment"]] as const) {
    const root = await mkdtemp(resolve(tmpdir(), `gamefactory-gemini-${owner}-`));
    const credentials = await credentialStore();
    try {
      const prior = await evidence(root);
      const experimentId = `exp-${owner}`;
      const manifestDirectory = resolve(root, ".factory", "runs", experimentId, "godot-evidence");
      await mkdir(manifestDirectory, { recursive: true });
      await writeFile(resolve(manifestDirectory, "result.json"), JSON.stringify({ status: "pass", artifacts: prior.artifacts }));
      const finding = {
        id: `${owner}-contradiction`,
        severity: "blocker",
        owner,
        affectedState: "interaction",
        evidenceIds: ["runtime-image-001"],
        timestampSeconds: null,
        violatedContract: `${owner} contract`,
        playerImpact: "The current implementation cannot coherently satisfy the controlling contract.",
        repair: `Return to the ${owner} owner instead of repeatedly changing runtime code.`,
        regressionEvidence: "Recapture the same state after the controlling contract is revised."
      };
      const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(review({ verdict: "revise", findings: [finding] })) }), { status: 200 });
      const result = await new GeminiVisualReviewAgent("production", new GeminiVisualEvaluator({ fetchImpl, credentialStore: credentials.store })).run({
        campaign: campaign(root),
        candidate: { id: "candidate", root, metadata: {} },
        experimentId,
        history: [],
        signal: new AbortController().signal
      });
      assert.equal(result.metadata?.outcome, expected);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(credentials.root, { recursive: true, force: true });
    }
  }
});
