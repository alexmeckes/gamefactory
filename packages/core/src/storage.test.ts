import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { configuredFactoryDataRoot, resolveFactoryStatePath } from "./storage.js";

test("factory state paths preserve their portable layout under a machine-local data root", () => {
  const cwd = resolve("C:/workspace/gamefactory");
  const dataRoot = resolve("D:/GameFactoryData");
  assert.equal(
    resolveFactoryStatePath({ cwd, dataRoot }, "games/example/.factory/results/run.jsonl", ".factory/results/fallback.jsonl", "resultLog"),
    resolve(dataRoot, "games/example/.factory/results/run.jsonl"),
  );
  assert.throws(() => resolveFactoryStatePath({ cwd, dataRoot }, "../escape", ".factory/fallback", "resultLog"), /working directory/);
  assert.equal(configuredFactoryDataRoot({ GAMEFACTORY_DATA_ROOT: " D:/GameFactoryData " }), dataRoot);
});
