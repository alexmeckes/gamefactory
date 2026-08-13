import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CapabilityRegistry, ConsoleLogger, discoverExtension, ExtensionManager, type AgentDriver, type Campaign, type FactoryTraceEventInput } from "@gamefactory/core";
import { Sam3ExecutionError, Sam3Runtime, Sam3SegmentAgent } from "./index.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwK3WQAAAABJRU5ErkJggg==", "base64");

const fixture = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
if (process.argv.includes("--doctor")) {
  console.log(JSON.stringify({ ok: true, provider: "fixture", cudaAvailable: true }));
  process.exit(0);
}
const request = JSON.parse(await readFile(process.env.GAMEFACTORY_SAM3_REQUEST, "utf8"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwK3WQAAAABJRU5ErkJggg==", "base64");
const jobs = [];
for (const job of request.jobs) {
  await mkdir(job.outputDirectory, { recursive: true });
  const maskPath = job.prompt === "escape" ? job.sourcePath : resolve(job.outputDirectory, job.id + ".mask.png");
  const cutoutPath = job.prompt === "escape" ? job.sourcePath : resolve(job.outputDirectory, job.id + ".cutout.png");
  if (job.prompt !== "escape") {
    await writeFile(maskPath, png);
    await writeFile(cutoutPath, png);
  }
  jobs.push({ id: job.id, prompt: job.prompt, instances: [{ index: 1, score: 0.91, bbox: [0, 0, 1, 1], maskPath, cutoutPath }] });
}
await mkdir(dirname(process.env.GAMEFACTORY_SAM3_RESULT), { recursive: true });
await writeFile(process.env.GAMEFACTORY_SAM3_RESULT, JSON.stringify({ provider: "fixture", model: "sam3-test", checkpoint: "fixture-sha", jobs }));
console.log(JSON.stringify({ jobs: jobs.length }));
`;

function campaign(root: string, requestPath = "sam3.request.json"): Campaign {
  return {
    apiVersion: "gamefactory.dev/v1",
    id: "sam3-extension-test",
    objective: "extract a generated image into reusable layers",
    projectRoot: root,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["assets/**", "sam3.request.json"],
    acceptance: { primaryMetric: "score", direction: "maximize" },
    parameters: {
      sam3: {
        requestPath,
        command: [process.execPath, "sam3-fixture.mjs"],
        doctorCommand: [process.execPath, "sam3-fixture.mjs", "--doctor"],
        model: "sam3-test",
        timeoutSeconds: 10,
        maxOutputCharacters: 10_000,
        environmentAllowlist: []
      }
    }
  };
}

async function workspace(prompt = "brass fixture"): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-sam3-"));
  await mkdir(resolve(root, "art"), { recursive: true });
  await writeFile(resolve(root, "art", "source.png"), PNG);
  await writeFile(resolve(root, "sam3-fixture.mjs"), fixture, "utf8");
  await writeFile(resolve(root, "sam3.request.json"), `${JSON.stringify({
    apiVersion: "gamefactory.sam3/v1",
    jobs: [{
      id: "fixture",
      sourcePath: "art/source.png",
      prompt,
      outputDirectory: "assets/generated/fixture",
      threshold: 0.55,
      maxInstances: 4,
      cropPaddingPixels: 2,
      maskExpandPixels: 1,
      maskFeatherPixels: 1
    }]
  }, null, 2)}\n`, "utf8");
  return root;
}

test("SAM 3 extension produces verified, hashed mask and cutout artifacts", async () => {
  const root = await workspace();
  const events: FactoryTraceEventInput[] = [];
  try {
    const result = await new Sam3SegmentAgent().run({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-sam3",
      history: [],
      signal: new AbortController().signal,
      trace: { runId: "run-sam3", campaignId: "sam3-extension-test", emit: async (event) => { events.push(event); } }
    });
    assert.match(result.summary, /1 concept job.*1 instance/);
    const images = result.artifacts?.filter((item) => item.kind === "image") ?? [];
    assert.equal(images.length, 2);
    assert.ok(images.every((item) => /^[a-f0-9]{64}$/.test(item.sha256 ?? "")));
    assert.equal((result.metadata as { model?: string }).model, "sam3-test");
    assert.ok(events.some((event) => event.type === "node:completed" && event.role === "asset-processor"));
    const resultFile = JSON.parse(await readFile(resolve(root, ".factory", "sam3", "exp-sam3", "result.json"), "utf8")) as { jobs: unknown[] };
    assert.equal(resultFile.jobs.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SAM 3 extension doctor delegates to the isolated configured runtime", async () => {
  const root = await workspace();
  try {
    const result = await new Sam3Runtime().doctor({ campaign: campaign(root), projectRoot: root, signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.match(result.checks[0]?.message ?? "", /cudaAvailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SAM 3 manifest activates lazily and contributes its agent and doctor capabilities", async () => {
  const registry = new CapabilityRegistry();
  const manager = new ExtensionManager(registry, new ConsoleLogger(false));
  try {
    const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    manager.addDescriptor(await discoverExtension(extensionRoot));
    assert.equal(manager.listActiveExtensions().length, 0);
    await manager.activateFor("agent:sam3.segment");
    assert.equal(registry.get<AgentDriver>("agent", "sam3.segment").id, "sam3.segment");
    assert.ok(registry.getAll("engine").length === 1);
    assert.deepEqual(manager.listActiveExtensions()[0]?.capabilities, ["agent:sam3.segment"]);
  } finally {
    await manager.dispose();
  }
});

test("SAM 3 extension rejects provider outputs outside the declared output directory and preserves evidence", async () => {
  const root = await workspace("escape");
  try {
    await assert.rejects(() => new Sam3SegmentAgent().run({
      campaign: campaign(root),
      candidate: { id: "candidate", root, metadata: {} },
      experimentId: "exp-escape",
      history: [],
      signal: new AbortController().signal
    }), (error: unknown) => {
      assert.ok(error instanceof Sam3ExecutionError);
      assert.match(error.message, /outside its declared output directory/);
      assert.ok(error.artifacts.some((item) => item.label === "SAM 3 provider result"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
