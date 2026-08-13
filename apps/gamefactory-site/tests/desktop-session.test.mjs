import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.doesNotMatch(html, /unsafe-eval/);
});
