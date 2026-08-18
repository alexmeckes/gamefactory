#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { configuredFactoryRuntimeSettings, ConsoleLogger, FactoryRunner, LocalCredentialStore, loadCampaign, loadFactoryConfig, type IntakeDriver } from "@gamefactory/core";
import { gameSpecFingerprint, loadGameSpec, loadProject, ProjectRunner } from "@gamefactory/project-sdk";
import { SqliteProjectJourneyIndex } from "@gamefactory/project-sdk/sqlite";
import { startFactoryViewer } from "@gamefactory/viewer";
import { chooseIntakeOption } from "./intake.js";
import { migrateStorage, refreshStorageIndex, storageDoctor, storageGc, storageStatus } from "./storage.js";

function usage(): never {
  console.error(`GameFactory\n\nUsage:\n  gamefactory credentials set <name>\n  gamefactory credentials list\n  gamefactory credentials remove <name>\n  gamefactory credentials path\n  gamefactory storage doctor\n  gamefactory storage status\n  gamefactory storage migrate\n  gamefactory storage gc [--apply]\n  gamefactory intake "<game idea>" [--provider game.design] [--output game.brief.json] [--force] [--config factory.config.json]\n  gamefactory spec validate <GAME_SPEC.json> [--project-id <id>]\n  gamefactory run <campaign.json> [--config factory.config.json]\n  gamefactory project doctor <gamefactory.project.json>\n  gamefactory project run <gamefactory.project.json>\n  gamefactory project approve <gamefactory.project.json> --phase <phase-id> --approver <identity>\n  gamefactory project status <gamefactory.project.json>\n  gamefactory view <campaign.json> [--config factory.config.json] [--port 4317] [--host 127.0.0.1]\n  gamefactory bridge <campaign.json> [--config factory.config.json] [--port 4317] [--observatory https://gamefactory-observatory.ameckes.chatgpt.site]\n  gamefactory doctor <campaign.json> [--config factory.config.json]\n  gamefactory list [--config factory.config.json]\n  gamefactory explain <capability> [--config factory.config.json]`);
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

function observatoryOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("The Observatory URL must use HTTPS");
  return url.origin;
}

async function hiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/[\r\n]+$/, "");
  }
  process.stdout.write(prompt);
  const input = process.stdin;
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of input) {
      for (const character of chunk) {
        if (character === "\u0003") throw new Error("Interrupted");
        if (character === "\r" || character === "\n") {
          process.stdout.write("\n");
          return value;
        }
        if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
  } finally {
    input.setRawMode?.(false);
    input.pause();
  }
  return value;
}

async function credentialsCommand(action: string | undefined, name: string | undefined): Promise<void> {
  const store = new LocalCredentialStore();
  if (action === "path") {
    console.log(store.root);
    return;
  }
  if (action === "list") {
    for (const credential of await store.list()) console.log(credential);
    return;
  }
  if (!name) usage();
  if (action === "set") {
    const value = await hiddenSecret(`Credential ${name}: `);
    if (!value) throw new Error("Credential was empty; nothing was stored");
    await store.set(name, value);
    console.log(`Stored ${name} in the OS-protected GameFactory credential store.`);
    return;
  }
  if (action === "remove") {
    console.log(await store.remove(name) ? `Removed ${name}.` : `${name} was not stored.`);
    return;
  }
  usage();
}

async function main(): Promise<void> {
  const [, , command, subject] = process.argv;
  if (!command) usage();
  if (command === "credentials") {
    await credentialsCommand(subject, process.argv[4]);
    return;
  }
  const cwd = process.cwd();
  const runtime = configuredFactoryRuntimeSettings();
  const dataRoot = runtime.dataRoot;
  const logger = new ConsoleLogger(process.env.FACTORY_LOG_LEVEL === "debug");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
  if (command === "storage") {
    if (!dataRoot) throw new Error("Set GAMEFACTORY_DATA_ROOT before using storage commands");
    if (!subject || !["doctor", "status", "migrate", "gc"].includes(subject)) usage();
    const index = await SqliteProjectJourneyIndex.open(resolve(dataRoot, "factory.sqlite"));
    try {
      if (subject === "doctor") {
        const checks = await storageDoctor(cwd, dataRoot, runtime.worktreeRoot, index);
        console.log(JSON.stringify(checks, null, 2));
        if (checks.some((check) => !check.ok)) process.exitCode = 1;
      } else if (subject === "status") console.log(JSON.stringify(await storageStatus(dataRoot, index), null, 2));
      else if (subject === "migrate") console.log(JSON.stringify(await migrateStorage(cwd, dataRoot, index), null, 2));
      else {
        const result = await storageGc(dataRoot, process.argv.includes("--apply"));
        if (result.applied) index.checkpointAndVacuum();
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    } finally { index.close(); }
  }
  if (command === "spec") {
    if (subject !== "validate" || !process.argv[4]) usage();
    const projectIdIndex = process.argv.indexOf("--project-id");
    const projectId = projectIdIndex >= 0 ? process.argv[projectIdIndex + 1] ?? usage() : undefined;
    const spec = await loadGameSpec(resolve(cwd, process.argv[4]), projectId);
    console.log(JSON.stringify({ valid: true, projectId: spec.projectId, revision: spec.revision, status: spec.status, claims: spec.claims.length, slices: spec.slices.length, sha256: gameSpecFingerprint(spec) }, null, 2));
    return;
  }
  if (command === "project") {
    const action = subject;
    const projectPath = process.argv[4];
    if (!projectPath || !["doctor", "run", "status", "approve"].includes(action ?? "")) usage();
    const project = await loadProject(resolve(cwd, projectPath));
    const journeyIndex = dataRoot ? await SqliteProjectJourneyIndex.open(resolve(dataRoot, "factory.sqlite")) : undefined;
    const projectRunner = new ProjectRunner(project, { cwd, ...runtime, ...(journeyIndex ? { journeyIndex } : {}), logger, signal: controller.signal });
    try {
      await journeyIndex?.sync(await projectRunner.readJourney());
      if (action === "status") {
        const events = journeyIndex ? await journeyIndex.read(project.id) : await projectRunner.readJourney();
        console.log(JSON.stringify({ project: { id: project.id, title: project.title }, storage: journeyIndex ? { kind: "sqlite", path: journeyIndex.path } : { kind: "jsonl", path: projectRunner.journal.path }, events }, null, 2));
        return;
      }
      if (action === "doctor") {
        const checks = await projectRunner.doctor();
        console.log(JSON.stringify(checks, null, 2));
        if (checks.some((check) => !check.ok)) process.exitCode = 1;
        return;
      }
      if (action === "approve") {
        const phaseId = option("--phase", "");
        const approver = option("--approver", "");
        if (!phaseId || !approver) usage();
        const event = await projectRunner.approve(phaseId, approver);
        if (dataRoot && journeyIndex) await refreshStorageIndex(dataRoot, journeyIndex);
        console.log(JSON.stringify(event, null, 2));
        return;
      }
      const result = await projectRunner.run();
      if (dataRoot && journeyIndex) await refreshStorageIndex(dataRoot, journeyIndex);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "complete") process.exitCode = 1;
      return;
    } finally {
      journeyIndex?.close();
    }
  }
  const configPath = resolve(cwd, option("--config", "factory.config.json"));
  const config = await loadFactoryConfig(configPath);
  if (command === "view" || command === "bridge") {
    if (!subject) usage();
    const campaign = await loadCampaign(resolve(cwd, subject));
    const portValue = option("--port", "4317");
    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid viewer port: ${portValue}`);
    const bridge = command === "bridge" ? {
      token: randomBytes(24).toString("base64url"),
      allowedOrigins: [observatoryOrigin(option("--observatory", "https://gamefactory-observatory.ameckes.chatgpt.site"))]
    } : undefined;
    const viewer = await startFactoryViewer({
      cwd,
      ...(dataRoot ? { dataRoot } : {}),
      campaign,
      config,
      host: bridge ? "127.0.0.1" : option("--host", "127.0.0.1"),
      port,
      ...(bridge ? { bridge } : {})
    });
    if (bridge) {
      console.log("GameFactory Observatory bridge is ready.");
      console.log(`Endpoint: ${viewer.url}`);
      console.log(`Bridge key: ${bridge.token}`);
      console.log(`Observatory: ${bridge.allowedOrigins[0]}`);
      console.log("Open Live bridge in the Observatory and paste the endpoint and key. The key expires when this command stops.");
    } else {
      console.log(`GameFactory viewer: ${viewer.url}`);
    }
    console.log(`Watching ${campaign.id}. Press Ctrl+C to stop.`);
    try {
      if (!controller.signal.aborted) await new Promise<void>((resolveStop) => controller.signal.addEventListener("abort", () => resolveStop(), { once: true }));
    } finally {
      await viewer.close();
    }
    return;
  }
  const runner = new FactoryRunner({ cwd, ...runtime, config, logger, signal: controller.signal });
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
    if (dataRoot) {
      const index = await SqliteProjectJourneyIndex.open(resolve(dataRoot, "factory.sqlite"));
      try { await refreshStorageIndex(dataRoot, index); }
      finally { index.close(); }
    }
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
