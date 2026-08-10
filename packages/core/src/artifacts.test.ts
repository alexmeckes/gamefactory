import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ContentAddressedArtifactStore } from "./artifacts.js";
import { MemoryLogger } from "./logger.js";

test("artifact store preserves candidate-local evidence by content hash", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gamefactory-artifacts-"));
  try {
    const source = resolve(directory, "candidate", "telemetry.jsonl");
    await mkdir(resolve(directory, "candidate"), { recursive: true });
    await writeFile(source, "{\"tick\":1}\n", "utf8");
    const store = new ContentAddressedArtifactStore(resolve(directory, "store"), new MemoryLogger());
    const [preserved] = await store.preserve([{ kind: "telemetry", path: source }], "campaign/experiment");
    assert.ok(preserved?.sha256);
    assert.notEqual(preserved?.path, source);
    assert.equal(await readFile(preserved!.path, "utf8"), "{\"tick\":1}\n");
    await rm(resolve(directory, "candidate"), { recursive: true, force: true });
    assert.equal(await readFile(preserved!.path, "utf8"), "{\"tick\":1}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
