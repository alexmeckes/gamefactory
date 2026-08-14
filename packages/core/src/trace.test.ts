import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { JsonlTraceStore } from "./trace.js";

test("trace store serializes concurrent semantic events and tolerates a partial tail", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-trace-"));
  const path = resolve(root, "trace.jsonl");
  try {
    const store = new JsonlTraceStore(path);
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) => store.append(
      { runId: "run-1", campaignId: "campaign-1" },
      { type: "node:progress", nodeId: "agent-1", message: `step-${index}`, progress: { current: index, total: 20, unit: "steps" } }
    )));
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.equal((await store.read()).length, 20);
    await appendFile(path, "{\"version\":1", "utf8");
    assert.equal((await new JsonlTraceStore(path).read()).length, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
