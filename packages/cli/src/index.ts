#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ConsoleLogger, FactoryRunner, loadCampaign, loadFactoryConfig, type IntakeDriver } from "@gamefactory/core";
import { startFactoryViewer } from "@gamefactory/viewer";
import { chooseIntakeOption } from "./intake.js";

function usage(): never {
  console.error(`GameFactory\n\nUsage:\n  gamefactory intake "<game idea>" [--provider game.design] [--output game.brief.json] [--force] [--config factory.config.json]\n  gamefactory run <campaign.json> [--config factory.config.json]\n  gamefactory view <campaign.json> [--config factory.config.json] [--port 4317] [--host 127.0.0.1]\n  gamefactory doctor <campaign.json> [--config factory.config.json]\n  gamefactory list [--config factory.config.json]\n  gamefactory explain <capability> [--config factory.config.json]`);
  process.exit(2);
}

function outputPath(cwd: string, value: string): string {
  const target = resolve(cwd, value);
  const traversal = relative(cwd, target);
  if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error("Intake output must stay inside the current project");
  return target;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? usage()) : fallback;
}

async function main(): Promise<void> {
  const [, , command, subject] = process.argv;
  if (!command) usage();
  const cwd = process.cwd();
  const configPath = resolve(cwd, option("--config", "factory.config.json"));
  const config = await loadFactoryConfig(configPath);
  const logger = new ConsoleLogger(process.env.FACTORY_LOG_LEVEL === "debug");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
  if (command === "view") {
    if (!subject) usage();
    const campaign = await loadCampaign(resolve(cwd, subject));
    const portValue = option("--port", "4317");
    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid viewer port: ${portValue}`);
    const viewer = await startFactoryViewer({ cwd, campaign, config, host: option("--host", "127.0.0.1"), port });
    console.log(`GameFactory viewer: ${viewer.url}`);
    console.log(`Watching ${campaign.id}. Press Ctrl+C to stop.`);
    try {
      if (!controller.signal.aborted) await new Promise<void>((resolveStop) => controller.signal.addEventListener("abort", () => resolveStop(), { once: true }));
    } finally {
      await viewer.close();
    }
    return;
  }
  const runner = new FactoryRunner({ cwd, config, logger, signal: controller.signal });
  await runner.initialize();

  try {
    if (command === "list") {
      for (const descriptor of runner.extensions.listDescriptors()) {
        console.log(`${descriptor.manifest.name}@${descriptor.manifest.version}\t${descriptor.manifest.description ?? ""}`);
      }
      return;
    }
    if (command === "explain") {
      if (!subject) usage();
      console.log(JSON.stringify(runner.extensions.explain([subject]), null, 2));
      return;
    }
    if (command === "intake") {
      if (!subject || subject.startsWith("--")) usage();
      const providerId = option("--provider", "game.design");
      await runner.extensions.activateFor(`intake:${providerId}`);
      const provider = runner.registry.get<IntakeDriver>("intake", providerId);
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const result = await provider.run({
          brief: subject,
          projectRoot: cwd,
          signal: controller.signal,
          ask: (question) => chooseIntakeOption(question, readline, process.stdout, controller.signal)
        });
        const target = outputPath(cwd, option("--output", "game.brief.json"));
        await mkdir(dirname(target), { recursive: true });
        try {
          await writeFile(target, `${JSON.stringify(result.document, null, 2)}\n`, { encoding: "utf8", flag: process.argv.includes("--force") ? "w" : "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${relative(cwd, target)} already exists; pass --force to replace it`);
          throw error;
        }
        console.log(JSON.stringify({ output: relative(cwd, target), provider: result.provider, summary: result.summary }, null, 2));
      } finally {
        readline.close();
      }
      return;
    }
    if (command !== "run" && command !== "doctor") usage();
    if (!subject) usage();
    const campaign = await loadCampaign(resolve(cwd, subject));
    if (command === "doctor") {
      const checks = await runner.doctor(campaign);
      console.log(JSON.stringify(checks, null, 2));
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
      return;
    }
    const result = await runner.run(campaign);
    console.log(JSON.stringify(result, null, 2));
    if (!["complete", "budget-exhausted"].includes(result.status)) process.exitCode = 1;
  } finally {
    await runner.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
