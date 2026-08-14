import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function findTests(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await findTests(path, output);
    else if (entry.name.endsWith(".test.js") && path.includes(`${join("", "dist")}`)) output.push(path);
  }
  return output;
}

const tests = await findTests(process.cwd());
if (tests.length === 0) throw new Error("No compiled tests found");

const requestedConcurrency = Number.parseInt(process.env.GAMEFACTORY_TEST_CONCURRENCY ?? "1", 10);
const testConcurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
  ? requestedConcurrency
  : 1;

const child = spawn(
  process.execPath,
  ["--test", `--test-concurrency=${testConcurrency}`, ...tests],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
