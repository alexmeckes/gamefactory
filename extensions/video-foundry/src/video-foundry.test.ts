import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { LocalCredentialStore, type Campaign, type CredentialCipher } from "@gamefactory/core";
import { GoogleOmniVideoAgent } from "./index.js";

class FixtureCipher implements CredentialCipher {
  async seal(value: string): Promise<string> { return Buffer.from(value).toString("base64"); }
  async unseal(value: string): Promise<string> { return Buffer.from(value, "base64").toString(); }
}

function campaign(root: string): Campaign {
  return { apiVersion: "gamefactory.dev/v1", id: "video-foundry-test", objective: "make a motion study", projectRoot: root, workflow: "autoresearch", requires: [], acceptance: { primaryMetric: "score", direction: "maximize" }, parameters: { googleOmni: { requestPath: "video.request.json", credentialName: "google.gemini", apiKeyEnvironment: "GAMEFACTORY_MISSING_TEST_KEY", pollIntervalMilliseconds: 250 } } };
}

test("Google Omni video agent uses a runtime-only credential and records sanitized provenance", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-video-"));
  const credentialRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-credentials-"));
  const store = new LocalCredentialStore({ root: credentialRoot, cipher: new FixtureCipher() });
  const secret = "fixture-api-key-never-persist";
  const bodies: Array<Record<string, unknown>> = [];
  const headers: string[] = [];
  let call = 0;
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
  try {
    await store.set("google.gemini", secret);
    await writeFile(resolve(root, "video.request.json"), JSON.stringify({ apiVersion: "gamefactory.video/v1", jobs: [
      { id: "first", prompt: "A paper bird unfolds", outputPath: "assets/first.mp4", task: "text_to_video" },
      { id: "polish", prompt: "Keep the silhouette and improve anticipation", outputPath: "assets/polish.mp4", task: "edit", previousJobId: "first" }
    ] }));
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1; headers.push(new Headers(init?.headers).get("x-goog-api-key") ?? ""); bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `interaction-${call}`, steps: [{ content: [{ type: "video", mime_type: "video/mp4", data: mp4.toString("base64") }] }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await new GoogleOmniVideoAgent({ fetchImpl, credentialStore: store }).run({ campaign: campaign(root), candidate: { id: "candidate", root, metadata: {} }, experimentId: "exp-video", history: [], signal: new AbortController().signal });
    assert.equal(result.artifacts?.filter((item) => item.kind === "video").length, 2);
    assert.deepEqual(headers, [secret, secret]);
    assert.equal(bodies[1]?.previous_interaction_id, "interaction-1");
    const report = await readFile(resolve(root, ".factory", "video-foundry", "exp-video", "video-result.json"), "utf8");
    assert.doesNotMatch(report, new RegExp(secret));
    assert.match(report, /local-store/);
    for (const file of await readdir(resolve(root, "assets"))) assert.match(file, /\.mp4$/);
  } finally {
    await rm(root, { recursive: true, force: true }); await rm(credentialRoot, { recursive: true, force: true });
  }
});
