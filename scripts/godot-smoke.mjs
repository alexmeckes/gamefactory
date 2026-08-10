import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConsoleLogger, FactoryRunner, loadCampaign } from "../packages/core/dist/index.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "examples", "godot");
const campaignName = process.argv[2] ?? "campaign.json";
const sandboxRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-godot-smoke-"));
let runner;
let succeeded = false;

if (!process.env.GODOT_BINARY) {
  throw new Error("Set GODOT_BINARY to the Godot console/editor executable before running this smoke test.");
}

try {
  await cp(fixtureRoot, sandboxRoot, { recursive: true });
  await exec(process.env.GODOT_BINARY, ["--headless", "--editor", "--quit", "--path", sandboxRoot], { cwd: sandboxRoot });
  await exec("git", ["init", "-q"], { cwd: sandboxRoot });
  await exec("git", ["add", "--all"], { cwd: sandboxRoot });
  await exec("git", ["-c", "user.name=GameFactory", "-c", "user.email=gamefactory@localhost", "commit", "-qm", "Godot smoke baseline"], { cwd: sandboxRoot });

  const campaign = await loadCampaign(resolve(sandboxRoot, campaignName));
  runner = new FactoryRunner({
    cwd: sandboxRoot,
    config: {
      apiVersion: "gamefactory.dev/v1",
      extensions: [
        resolve(repositoryRoot, "extensions", "autoresearch"),
        resolve(repositoryRoot, "extensions", "git"),
        resolve(repositoryRoot, "extensions", "command-agent"),
        resolve(repositoryRoot, "extensions", "agent-team"),
        resolve(repositoryRoot, "extensions", "tournament"),
        resolve(repositoryRoot, "extensions", "godot")
      ],
      resultLog: ".factory/results/godot-smoke.jsonl"
    },
    logger: new ConsoleLogger(process.env.FACTORY_LOG_LEVEL === "debug")
  });
  await runner.initialize();
  const checks = await runner.doctor(campaign);
  console.log(JSON.stringify({ doctor: checks }, null, 2));
  if (checks.some((check) => !check.ok)) throw new Error("Godot smoke doctor failed.");
  const result = await runner.run(campaign);
  const summary = {
    campaignId: result.campaignId,
    status: result.status,
    summary: result.summary,
    bestMetrics: result.bestMetrics,
    experiments: result.experiments.map((experiment) => ({
      id: experiment.experimentId,
      status: experiment.status,
      score: experiment.metrics[campaign.acceptance.primaryMetric],
      revision: experiment.revision,
      contributors: experiment.agent?.contributors.map((contributor) => ({
        id: contributor.agentId,
        role: contributor.role,
        status: contributor.status
      })) ?? []
    }))
  };
  console.log(JSON.stringify({ result: summary }, null, 2));
  if (process.env.FACTORY_SMOKE_VERBOSE === "true") console.log(JSON.stringify({ fullResult: result }, null, 2));
  if (result.status !== "budget-exhausted" || !result.experiments.some((item) => item.status === "keep")) {
    throw new Error(`Unexpected Godot smoke result: ${result.status}`);
  }
  succeeded = true;
} finally {
  await runner?.dispose();
  if (succeeded) await rm(sandboxRoot, { recursive: true, force: true });
  else console.error(`Preserved failing Godot sandbox: ${sandboxRoot}`);
}
