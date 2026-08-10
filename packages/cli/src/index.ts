#!/usr/bin/env node
import { resolve } from "node:path";
import { ConsoleLogger, FactoryRunner, loadCampaign, loadFactoryConfig } from "@gamefactory/core";

function usage(): never {
  console.error(`GameFactory\n\nUsage:\n  gamefactory run <campaign.json> [--config factory.config.json]\n  gamefactory doctor <campaign.json> [--config factory.config.json]\n  gamefactory list [--config factory.config.json]\n  gamefactory explain <capability> [--config factory.config.json]`);
  process.exit(2);
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
