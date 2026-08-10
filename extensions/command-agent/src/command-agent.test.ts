import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { Campaign } from "@gamefactory/core";
import { CommandAgent } from "./index.js";

test("command agent receives an isolated request and captures its audit logs", async () => {
  const candidateRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-agent-"));
  const script = resolve(candidateRoot, "agent.mjs");
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "agent-contract",
    objective: "write a marker",
    projectRoot: candidateRoot,
    workflow: "autoresearch",
    requires: [],
    parameters: { agentCommand: [process.execPath, script] },
    acceptance: { primaryMetric: "score", direction: "maximize" }
  };
  try {
    await writeFile(script, `import { readFile, writeFile } from "node:fs/promises";\nconst request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));\nawait writeFile("marker.txt", request.objective);\nconsole.log("agent fixture complete");\n`, "utf8");
    const result = await new CommandAgent().run({
      campaign,
      candidate: { id: "candidate", root: candidateRoot, metadata: {} },
      experimentId: "exp-1",
      history: [],
      signal: new AbortController().signal
    });
    assert.equal(await readFile(resolve(candidateRoot, "marker.txt"), "utf8"), campaign.objective);
    assert.match(result.summary, /fixture complete/);
    assert.equal(result.artifacts?.length, 3);
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
});
