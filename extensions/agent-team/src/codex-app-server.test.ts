import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CodexAppServerPool } from "./codex-app-server.js";

const fakeServer = `
import { createInterface } from "node:readline";
let thread = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start") {
    thread += 1;
    send({ id: message.id, result: { thread: { id: "thread-" + thread, modelProvider: "openai" }, instructionSources: [message.params.cwd + "/AGENTS.md"] } });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "turn-" + thread;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "item/started", params: { threadId, turnId, item: { id: "cmd-1", type: "commandExecution", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { id: "msg-1", type: "agentMessage", phase: "final_answer", text: JSON.stringify({ summary: "real adapter result", outcome: "pass" }) } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 10, totalTokens: 150 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
});
`;

test("Codex App Server pool streams a turn and records instruction, lineage, and usage metadata", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-app-server-"));
  const serverPath = resolve(root, "fake-app-server.mjs");
  await writeFile(serverPath, fakeServer, "utf8");
  const pool = new CodexAppServerPool();
  const events: string[] = [];
  try {
    const result = await pool.run({
      launcher: [process.execPath, serverPath],
      cwd: root,
      prompt: "Perform the bounded task",
      readOnly: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.method)
    });
    assert.deepEqual(JSON.parse(result.output), { summary: "real adapter result", outcome: "pass" });
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.modelProvider, "openai");
    assert.deepEqual(result.instructionSources.map((value) => value.replaceAll("\\", "/")), [resolve(root, "AGENTS.md").replaceAll("\\", "/")]);
    assert.equal(result.usage?.totalTokens, 150);
    assert.equal(result.usage?.billingMode, "subscription");
    assert.ok(events.includes("item/started"));
    assert.ok(events.includes("thread/tokenUsage/updated"));
    assert.ok(events.includes("turn/completed"));
  } finally {
    await pool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
