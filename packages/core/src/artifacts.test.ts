import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ArtifactPreservationError, ContentAddressedArtifactStore } from "./artifacts.js";
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
    assert.equal(preserved?.metadata?.sizeBytes, Buffer.byteLength("{\"tick\":1}\n"));
    assert.notEqual(preserved?.path, source);
    assert.equal(await readFile(preserved!.path, "utf8"), "{\"tick\":1}\n");
    await rm(resolve(directory, "candidate"), { recursive: true, force: true });
    assert.equal(await readFile(preserved!.path, "utf8"), "{\"tick\":1}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact store fails closed when its content store cannot be written", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gamefactory-artifacts-write-failure-"));
  try {
    const source = resolve(directory, "candidate", "telemetry.jsonl");
    const blockedStore = resolve(directory, "store-is-a-file");
    await mkdir(resolve(directory, "candidate"), { recursive: true });
    await writeFile(source, "evidence\n", "utf8");
    await writeFile(blockedStore, "not a directory\n", "utf8");
    const store = new ContentAddressedArtifactStore(blockedStore, new MemoryLogger());

    await assert.rejects(
      () => store.preserve([{ kind: "telemetry", path: source }], "campaign/experiment"),
      (error: unknown) => error instanceof ArtifactPreservationError && error.code === "write-failed"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact store rejects dangling and out-of-scope local artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gamefactory-artifacts-origin-"));
  try {
    const allowed = resolve(directory, "candidate");
    const outside = resolve(directory, "outside.log");
    await mkdir(allowed, { recursive: true });
    await writeFile(outside, "outside\n", "utf8");
    const store = new ContentAddressedArtifactStore(
      resolve(directory, "store"),
      new MemoryLogger(),
      { allowedRoots: [allowed] }
    );

    await assert.rejects(
      () => store.preserve([{ kind: "log", path: outside }], "campaign/outside"),
      (error: unknown) => error instanceof ArtifactPreservationError && error.code === "outside-allowed-roots"
    );
    await assert.rejects(
      () => store.preserve([{ kind: "log", path: resolve(allowed, "missing.log") }], "campaign/missing"),
      (error: unknown) => error instanceof ArtifactPreservationError && error.code === "not-found"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
