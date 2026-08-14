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
    if (message.params.sandbox !== "read-only") return send({ id: message.id, error: { message: "wrong legacy sandbox value" } });
    if (message.params.model !== "gpt-5.6-luna" || message.params.reasoningEffort !== undefined) return send({ id: message.id, error: { message: "wrong thread routing fields" } });
    thread += 1;
    send({ id: message.id, result: { thread: { id: "thread-" + thread, modelProvider: "openai" }, model: message.params.model, modelProvider: "openai", reasoningEffort: message.params.reasoningEffort, instructionSources: [message.params.cwd + "/AGENTS.md"] } });
    return;
  }
  if (message.method === "turn/start") {
    if (message.params.model !== "gpt-5.6-luna" || message.params.effort !== "high" || message.params.reasoningEffort !== undefined) return send({ id: message.id, error: { message: "turn lost requested model routing" } });
    if (message.params.outputSchema?.additionalProperties !== false || message.params.outputSchema?.properties?.outcome?.pattern === undefined) {
      return send({ id: message.id, error: { message: "missing strict output envelope" } });
    }
    const threadId = message.params.threadId;
    const turnId = "turn-" + thread;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "thread/settings/updated", params: { threadId, threadSettings: { model: message.params.model, effort: message.params.effort } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    if (message.params.input?.[0]?.text?.includes("rerouted")) {
      send({ method: "model/rerouted", params: { threadId, turnId, fromModel: "gpt-5.6-luna", toModel: "gpt-5.6-terra", reason: "highRiskCyberActivity" } });
    }
    for (let index = 0; index < 200; index += 1) send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "x" } });
    send({ method: "item/started", params: { threadId, turnId, item: { id: "cmd-1", type: "commandExecution", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { id: "msg-1", type: "agentMessage", phase: "final_answer", text: JSON.stringify({ summary: "real adapter result", outcome: "pass", payload: JSON.stringify({ context: { source: "fixture" } }) }) } } });
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
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.method)
    });
    assert.deepEqual(JSON.parse(result.output), { context: { source: "fixture" }, summary: "real adapter result", outcome: "pass" });
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.modelProvider, "openai");
    assert.equal(result.requestedModel, "gpt-5.6-luna");
    assert.equal(result.actualModel, "gpt-5.6-luna");
    assert.equal(result.requestedReasoningEffort, "high");
    assert.equal(result.reasoningEffort, "high");
    assert.deepEqual(result.instructionSources.map((value) => value.replaceAll("\\", "/")), [resolve(root, "AGENTS.md").replaceAll("\\", "/")]);
    assert.equal(result.usage?.totalTokens, 150);
    assert.equal(result.usage?.model, "gpt-5.6-luna");
    assert.equal(result.usage?.reasoningEffort, "high");
    assert.equal(result.usage?.billingMode, "subscription");
    assert.ok(events.includes("item/started"));
    assert.ok(events.includes("thread/tokenUsage/updated"));
    assert.ok(events.includes("turn/completed"));
    assert.ok(!events.includes("item/agentMessage/delta"));
    assert.ok(!result.eventLog.includes("item/agentMessage/delta"));
    const rerouted = await pool.run({
      launcher: [process.execPath, serverPath],
      cwd: root,
      prompt: "Perform a rerouted task",
      readOnly: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      signal: new AbortController().signal,
    });
    assert.equal(rerouted.actualModel, "gpt-5.6-terra");
    assert.equal(rerouted.usage?.model, "gpt-5.6-terra");
    assert.equal(rerouted.usage?.reasoningEffort, "high");
  } finally {
    await pool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
