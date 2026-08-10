import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { discoverExtension, ExtensionManager } from "./extension-manager.js";
import { MemoryLogger } from "./logger.js";
import { CapabilityRegistry } from "./registry.js";

async function extension(directory: string, name: string, capability: string, requires: string[] = [], entry = "export default () => undefined;\n"): Promise<string> {
  const root = resolve(directory, name);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "entry.mjs"), entry, "utf8");
  await writeFile(resolve(root, "factory.extension.json"), JSON.stringify({
    name,
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "entry.mjs",
    activation: [capability],
    contributes: { evaluator: [capability.split(":")[1]] },
    requires
  }), "utf8");
  return root;
}

test("parallel capability activation executes an extension exactly once", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gamefactory-activation-"));
  const counter = `__gamefactory_activation_${Date.now()}`;
  const manager = new ExtensionManager(new CapabilityRegistry(), new MemoryLogger());
  try {
    const root = await extension(directory, "singleflight", "evaluator:slow", [], `export default async (api) => { globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1; await new Promise((resolve) => setTimeout(resolve, 20)); return api.register("evaluator", "slow", { id: "slow" }); };\n`);
    manager.addDescriptor(await discoverExtension(root));
    await Promise.all(Array.from({ length: 100 }, () => manager.activateFor("evaluator:slow")));
    assert.equal((globalThis as Record<string, unknown>)[counter], 1);
    assert.equal(manager.registry.get<{ id: string }>("evaluator", "slow").id, "slow");
  } finally {
    await manager.dispose();
    delete (globalThis as Record<string, unknown>)[counter];
    await rm(directory, { recursive: true, force: true });
  }
});

test("extension dependency cycles fail with a useful path", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gamefactory-cycle-"));
  const manager = new ExtensionManager(new CapabilityRegistry(), new MemoryLogger());
  try {
    manager.addDescriptor(await discoverExtension(await extension(directory, "cycle-a", "evaluator:a", ["evaluator:b"])));
    manager.addDescriptor(await discoverExtension(await extension(directory, "cycle-b", "evaluator:b", ["evaluator:a"])));
    await assert.rejects(() => manager.activateFor("evaluator:a"), /cycle-a -> cycle-b -> cycle-a/);
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
