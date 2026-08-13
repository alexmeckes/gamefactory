import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DesktopFactorySession } from "../dist-desktop/main/session.js";

test("desktop session opens a campaign and produces an empty local snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-observatory-"));
  const campaignPath = join(root, "campaign.json");
  const configPath = join(root, "factory.config.json");
  await writeFile(campaignPath, JSON.stringify({
    apiVersion: "gamefactory.dev/v1",
    id: "desktop-fixture",
    objective: "Verify the desktop viewer contract",
    projectRoot: ".",
    workflow: "fixture",
    requires: [],
    acceptance: { primaryMetric: "score", direction: "maximize" },
  }), "utf8");
  await writeFile(configPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", extensions: [] }), "utf8");
  const snapshots = [];
  const session = new DesktopFactorySession(() => undefined, (snapshot) => snapshots.push(snapshot), 10_000);
  try {
    const state = await session.open({ campaignPath, configPath, factoryRoot: root });
    assert.equal(state.status, "watching");
    assert.equal(state.selection.campaignId, "desktop-fixture");
    assert.equal(snapshots.at(-1).campaign.id, "desktop-fixture");
    assert.equal(snapshots.at(-1).runId, "desktop-fixture-empty");
    assert.equal(snapshots.at(-1).sequence, 0);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged renderer has a restrictive desktop CSP", async () => {
  const html = await readFile(new URL("../dist-desktop/package/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src[^;]+gamefactory-artifact:/);
  assert.match(html, /media-src gamefactory-artifact:/);
  assert.doesNotMatch(html, /unsafe-eval/);
});

test("desktop session reads only content-addressed textual evidence inside the artifact store", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamefactory-observatory-artifact-"));
  const campaignPath = join(root, "campaign.json");
  const configPath = join(root, "factory.config.json");
  const hash = "a".repeat(64);
  const artifact = join(root, ".factory", "artifacts", "aa", `${hash}.txt`);
  await mkdir(join(root, ".factory", "artifacts", "aa"), { recursive: true });
  await mkdir(join(root, ".factory", "results"), { recursive: true });
  await writeFile(artifact, "private preserved evidence", "utf8");
  await writeFile(campaignPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", id: "artifact-fixture", objective: "Inspect evidence", projectRoot: ".", workflow: "fixture", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" } }), "utf8");
  await writeFile(configPath, JSON.stringify({ apiVersion: "gamefactory.dev/v1", extensions: [] }), "utf8");
  await writeFile(join(root, ".factory", "results", "artifact-fixture.jsonl"), `${JSON.stringify({
    campaignId: "artifact-fixture",
    runId: "artifact-run",
    experimentId: "artifact-experiment",
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:00:01.000Z",
    status: "discard",
    summary: "fixture",
    metrics: { score: 0 },
    evaluations: [{ evaluator: "fixture", version: "1", status: "pass", metrics: { score: 0 }, violations: [], artifacts: [{ kind: "log", path: artifact, mediaType: "text/plain", label: "Fixture notes", sha256: hash }] }]
  })}\n`, "utf8");
  const session = new DesktopFactorySession(() => undefined, () => undefined, 10_000);
  try {
    await session.open({ campaignPath, configPath, factoryRoot: root });
    const result = await session.getArtifactText(hash);
    assert.equal(result.text, "private preserved evidence");
    assert.equal(result.label, "Fixture notes");
    await assert.rejects(() => session.getArtifactText("b".repeat(64)), /unavailable|outside/);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
