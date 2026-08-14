import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const phases = {
  gameplay: {
    campaign: "games/firefly-glassworks/campaign.gameplay.json",
    config: "games/firefly-glassworks/factory.gameplay.json"
  },
  "art-slice": {
    campaign: "games/firefly-glassworks/campaign.art-slice.json",
    config: "games/firefly-glassworks/factory.art-slice.json"
  },
  production: {
    campaign: "games/firefly-glassworks/campaign.production.json",
    config: "games/firefly-glassworks/factory.production.json"
  }
};

function git(...args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
}

function assertClean(label) {
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status) throw new Error(`${label} requires a clean repository. Commit or stash these paths first:\n${status}`);
}

function runFactory(command, phase) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["packages/cli/dist/index.js", command, phase.campaign, "--config", phase.config], {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`GameFactory ${command} exited ${code}`)));
  });
}

const requested = process.argv[2] ?? "gameplay";
const selected = requested === "all" ? Object.keys(phases) : [requested];
for (const name of selected) {
  const phase = phases[name];
  if (!phase) throw new Error(`Unknown Firefly phase ${name}. Choose gameplay, art-slice, production, or all.`);
  assertClean(`Firefly phase ${name}`);
  const before = git("rev-parse", "HEAD");
  process.stdout.write(`\n=== FIREFLY ${name.toUpperCase()} / DOCTOR ===\n`);
  await runFactory("doctor", phase);
  process.stdout.write(`\n=== FIREFLY ${name.toUpperCase()} / RUN ===\n`);
  await runFactory("run", phase);
  assertClean(`Completed Firefly phase ${name}`);
  const after = git("rev-parse", "HEAD");
  if (after === before) throw new Error(`Firefly phase ${name} completed without accepting a candidate commit; refusing to advance.`);
  process.stdout.write(`Accepted ${name}: ${before.slice(0, 12)} -> ${after.slice(0, 12)}\n`);
}
