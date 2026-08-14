import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("CLI intake can delegate every multiple-choice decision and write a brief", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-intake-cli-"));
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const configPath = resolve(projectRoot, "factory.config.json");
  const outputPath = resolve(projectRoot, "game.brief.json");
  await writeFile(configPath, `${JSON.stringify({
    apiVersion: "gamefactory.dev/v1",
    extensions: [resolve(repositoryRoot, "extensions", "design-intake")]
  }, null, 2)}\n`, "utf8");
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        resolve(repositoryRoot, "packages", "cli", "dist", "index.js"),
        "intake",
        "A game about a city that dreams",
        "--config",
        configPath,
        "--output",
        "game.brief.json"
      ], { cwd: projectRoot, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let answered = 0;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        const prompts = stdout.match(/Choose 1-6:/g)?.length ?? 0;
        while (answered < prompts && answered < 5) {
          child.stdin.write("6\n");
          answered += 1;
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Figure it out/);
    const brief = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(brief.idea, "A game about a city that dreams");
    assert.equal((brief.delegatedDecisions as string[]).length, 5);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
