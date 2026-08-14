import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Campaign, Candidate } from "@gamefactory/core";
import { GitWorktreeWorkspace, removeWorktreeTransactionally } from "./index.js";

const exec = promisify(execFile);

test("transactional cleanup leaves a candidate intact when quarantine cannot be acquired", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-cleanup-"));
  const candidate = resolve(root, "candidate");
  await mkdir(candidate);
  await writeFile(resolve(candidate, "evidence.txt"), "keep me\n", "utf8");
  let attempts = 0;
  try {
    await assert.rejects(() => removeWorktreeTransactionally(root, candidate, {
      rename: async () => { attempts += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      remove: async () => undefined
    }, [0, 0, 0, 0]), /busy/);
    assert.equal(attempts, 4);
    assert.equal(await readFile(resolve(candidate, "evidence.txt"), "utf8"), "keep me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transactional cleanup survives a worktree that remains briefly busy", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-cleanup-retry-"));
  const candidate = resolve(root, "candidate");
  await mkdir(candidate);
  let attempts = 0;
  let quarantined = false;
  try {
    await removeWorktreeTransactionally(root, candidate, {
      rename: async () => {
        attempts += 1;
        if (attempts < 5) throw Object.assign(new Error("busy"), { code: "EPERM" });
        quarantined = true;
      },
      remove: async () => undefined
    }, [0, 0, 0, 0, 0]);
    assert.equal(attempts, 5);
    assert.equal(quarantined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git workspace maps a subproject, enforces paths, and cherry-picks accepted work", async () => {
  const repository = await mkdtemp(resolve(tmpdir(), "gamefactory-git-"));
  const projectRoot = resolve(repository, "game");
  const signal = new AbortController().signal;
  const workspace = new GitWorktreeWorkspace();
  const openCandidates: Candidate[] = [];
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "git-contract",
    objective: "change value",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["value.txt", "assets/enemies/drone.png"],
    immutablePaths: ["locked.txt"],
    acceptance: { primaryMetric: "score", direction: "maximize" }
  };
  try {
    await mkdir(projectRoot);
    await writeFile(resolve(projectRoot, "value.txt"), "old\n", "utf8");
    await writeFile(resolve(projectRoot, "locked.txt"), "locked\n", "utf8");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: repository });

    const accepted = await workspace.createCandidate({ campaign, experimentId: "accept", signal });
    openCandidates.push(accepted);
    assert.equal(accepted.root, resolve(String(accepted.metadata.worktreeRoot), "game"));
    await writeFile(resolve(accepted.root, "value.txt"), "new\n", "utf8");
    const result = await workspace.acceptCandidate({ campaign, candidate: accepted, signal });
    openCandidates.splice(openCandidates.indexOf(accepted), 1);
    assert.ok(result.revision);
    assert.equal((await readFile(resolve(projectRoot, "value.txt"), "utf8")).trim(), "new");

    const nested = await workspace.createCandidate({ campaign, experimentId: "nested", signal });
    openCandidates.push(nested);
    await mkdir(resolve(nested.root, "assets", "enemies"), { recursive: true });
    await writeFile(resolve(nested.root, "assets", "enemies", "drone.png"), "nested asset\n", "utf8");
    await workspace.acceptCandidate({ campaign, candidate: nested, signal });
    openCandidates.splice(openCandidates.indexOf(nested), 1);
    assert.equal((await readFile(resolve(projectRoot, "assets", "enemies", "drone.png"), "utf8")).trim(), "nested asset");

    const rejected = await workspace.createCandidate({ campaign, experimentId: "reject", signal });
    openCandidates.push(rejected);
    await writeFile(resolve(rejected.root, "locked.txt"), "changed\n", "utf8");
    await assert.rejects(() => workspace.acceptCandidate({ campaign, candidate: rejected, signal }), /immutable path/);
    await workspace.discardCandidate({ campaign, candidate: rejected, signal });
    openCandidates.splice(openCandidates.indexOf(rejected), 1);

    const stale = await workspace.createCandidate({ campaign, experimentId: "stale", signal });
    openCandidates.push(stale);
    await writeFile(resolve(stale.root, "value.txt"), "candidate\n", "utf8");
    await writeFile(resolve(projectRoot, "locked.txt"), "advanced baseline\n", "utf8");
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "advance baseline"], { cwd: repository });
    await assert.rejects(() => workspace.acceptCandidate({ campaign, candidate: stale, signal }), /is stale/);
    const staleRoot = String(stale.metadata.worktreeRoot);
    const cancelled = new AbortController();
    cancelled.abort();
    await workspace.discardCandidate({ campaign, candidate: stale, signal: cancelled.signal });
    openCandidates.splice(openCandidates.indexOf(stale), 1);
    await assert.rejects(() => access(staleRoot));

    const raceA = await workspace.createCandidate({ campaign, experimentId: "race", signal });
    const raceB = await workspace.createCandidate({ campaign, experimentId: "race", signal });
    openCandidates.push(raceA, raceB);
    assert.notEqual(raceA.metadata.worktreeRoot, raceB.metadata.worktreeRoot);
    await writeFile(resolve(raceA.root, "value.txt"), "race-a\n", "utf8");
    await writeFile(resolve(raceB.root, "value.txt"), "race-b\n", "utf8");
    const raced = await Promise.allSettled([
      workspace.acceptCandidate({ campaign, candidate: raceA, signal }),
      workspace.acceptCandidate({ campaign, candidate: raceB, signal })
    ]);
    assert.equal(raced.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(raced.filter((item) => item.status === "rejected").length, 1);
    for (const [index, outcome] of raced.entries()) {
      const candidate = index === 0 ? raceA : raceB;
      if (outcome.status === "rejected") await workspace.discardCandidate({ campaign, candidate, signal });
      openCandidates.splice(openCandidates.indexOf(candidate), 1);
    }
  } finally {
    for (const candidate of openCandidates) await workspace.discardCandidate({ campaign, candidate, signal }).catch(() => undefined);
    await rm(repository, { recursive: true, force: true });
  }
});
