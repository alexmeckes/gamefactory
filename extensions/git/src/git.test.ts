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

test("Git workspace can isolate candidates in a configured external root", async () => {
  const repository = await mkdtemp(resolve(tmpdir(), "gamefactory-git-external-repo-"));
  const externalRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-git-external-worktrees-"));
  const projectRoot = resolve(repository, "game");
  const signal = new AbortController().signal;
  const workspace = new GitWorktreeWorkspace();
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "external-worktree-contract",
    objective: "change value",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["value.txt"],
    acceptance: { primaryMetric: "score", direction: "maximize" },
    parameters: { git: { worktreeRoot: externalRoot } }
  };
  let candidate: Candidate | undefined;
  try {
    await mkdir(projectRoot);
    await writeFile(resolve(projectRoot, "value.txt"), "old\n", "utf8");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: repository });

    candidate = await workspace.createCandidate({ campaign, experimentId: "external", signal });
    assert.equal(resolve(String(candidate.metadata.managedParent)), resolve(externalRoot));
    assert.equal(resolve(String(candidate.metadata.worktreeRoot), ".."), resolve(externalRoot));
    await writeFile(resolve(candidate.root, "value.txt"), "new\n", "utf8");
    await workspace.acceptCandidate({ campaign, candidate, signal });
    candidate = undefined;
    assert.equal((await readFile(resolve(projectRoot, "value.txt"), "utf8")).trim(), "new");
  } finally {
    if (candidate) await workspace.discardCandidate({ campaign, candidate, signal }).catch(() => undefined);
    await rm(repository, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("runtime worktree settings are portable and explicit campaign settings take precedence", async () => {
  const repository = await mkdtemp(resolve(tmpdir(), "gamefactory-git-runtime-repo-"));
  const runtimeRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-git-runtime-worktrees-"));
  const explicitRoot = await mkdtemp(resolve(tmpdir(), "gamefactory-git-explicit-worktrees-"));
  const projectRoot = resolve(repository, "game");
  const signal = new AbortController().signal;
  const workspace = new GitWorktreeWorkspace();
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "runtime-worktree-contract",
    objective: "change value",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    acceptance: { primaryMetric: "score", direction: "maximize" }
  };
  const candidates: Candidate[] = [];
  try {
    await mkdir(projectRoot);
    await writeFile(resolve(projectRoot, "value.txt"), "old\n", "utf8");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: repository });

    const runtimeCandidate = await workspace.createCandidate({ campaign, experimentId: "runtime", signal, runtime: { worktreeRoot: runtimeRoot } });
    candidates.push(runtimeCandidate);
    assert.equal(resolve(String(runtimeCandidate.metadata.managedParent)), resolve(runtimeRoot));

    campaign.parameters = { git: { worktreeRoot: explicitRoot } };
    const explicitCandidate = await workspace.createCandidate({ campaign, experimentId: "explicit", signal, runtime: { worktreeRoot: runtimeRoot } });
    candidates.push(explicitCandidate);
    assert.equal(resolve(String(explicitCandidate.metadata.managedParent)), resolve(explicitRoot));
  } finally {
    await Promise.all(candidates.map((candidate) => workspace.discardCandidate({ campaign, candidate, signal }).catch(() => undefined)));
    await rm(repository, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(explicitRoot, { recursive: true, force: true });
  }
});

test("Git acceptance preserves a human-owned in-progress cherry-pick", async () => {
  const repository = await mkdtemp(resolve(tmpdir(), "gamefactory-git-human-cherry-pick-"));
  const projectRoot = resolve(repository, "game");
  const signal = new AbortController().signal;
  const workspace = new GitWorktreeWorkspace();
  const campaign: Campaign = {
    apiVersion: "gamefactory.dev/v1",
    id: "human-cherry-pick-contract",
    objective: "preserve developer work",
    projectRoot,
    workflow: "autoresearch",
    requires: [],
    mutablePaths: ["value.txt"],
    acceptance: { primaryMetric: "score", direction: "maximize" }
  };
  let candidate: Candidate | undefined;
  try {
    await mkdir(projectRoot);
    await writeFile(resolve(projectRoot, "value.txt"), "old\n", "utf8");
    await writeFile(resolve(projectRoot, "conflict.txt"), "base\n", "utf8");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial"], { cwd: repository });
    const branch = (await exec("git", ["branch", "--show-current"], { cwd: repository })).stdout.trim();
    candidate = await workspace.createCandidate({ campaign, experimentId: "candidate", signal });
    await writeFile(resolve(candidate.root, "value.txt"), "candidate\n", "utf8");

    await exec("git", ["switch", "-qc", "human-source"], { cwd: repository });
    await writeFile(resolve(projectRoot, "conflict.txt"), "theirs\n", "utf8");
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "human source"], { cwd: repository });
    const humanRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    await exec("git", ["switch", "-q", branch], { cwd: repository });
    await writeFile(resolve(projectRoot, "conflict.txt"), "ours\n", "utf8");
    await exec("git", ["add", "--all"], { cwd: repository });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "human target"], { cwd: repository });
    await assert.rejects(() => exec("git", ["cherry-pick", humanRevision], { cwd: repository }));
    await writeFile(resolve(projectRoot, "conflict.txt"), "human resolution in progress\n", "utf8");
    const cherryPickHead = (await exec("git", ["rev-parse", "CHERRY_PICK_HEAD"], { cwd: repository })).stdout.trim();

    await assert.rejects(() => workspace.acceptCandidate({ campaign, candidate: candidate!, signal }), /in-progress cherry-pick/);
    assert.equal((await exec("git", ["rev-parse", "CHERRY_PICK_HEAD"], { cwd: repository })).stdout.trim(), cherryPickHead);
    assert.equal(await readFile(resolve(projectRoot, "conflict.txt"), "utf8"), "human resolution in progress\n");
    await exec("git", ["cherry-pick", "--abort"], { cwd: repository });
  } finally {
    if (candidate) await workspace.discardCandidate({ campaign, candidate, signal }).catch(() => undefined);
    await exec("git", ["cherry-pick", "--abort"], { cwd: repository }).catch(() => undefined);
    await rm(repository, { recursive: true, force: true });
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
    const result = await workspace.acceptCandidate({ campaign, candidate: accepted, signal, operationId: "git-contract:accept" });
    openCandidates.splice(openCandidates.indexOf(accepted), 1);
    assert.ok(result.revision);
    assert.equal((await readFile(resolve(projectRoot, "value.txt"), "utf8")).trim(), "new");
    const retried = await workspace.acceptCandidate({ campaign, candidate: accepted, signal, operationId: "git-contract:accept" });
    assert.equal(retried.revision, result.revision);
    assert.equal(retried.changed, true);

    const noChange = await workspace.createCandidate({ campaign, experimentId: "no-change", signal });
    openCandidates.push(noChange);
    assert.deepEqual(await workspace.acceptCandidate({ campaign, candidate: noChange, signal, operationId: "git-contract:no-change" }), { changed: false });
    await access(String(noChange.metadata.worktreeRoot));
    await workspace.discardCandidate({ campaign, candidate: noChange, signal, operationId: "git-contract:no-change" });
    openCandidates.splice(openCandidates.indexOf(noChange), 1);

    const leased = await workspace.createCandidate({ campaign, experimentId: "leased", signal });
    openCandidates.push(leased);
    await assert.rejects(() => workspace.createCandidate({ campaign, experimentId: "leased", signal }), /already owned by live process/);
    await writeFile(String(leased.metadata.ownerPath), `${JSON.stringify({ pid: 2147483647 })}\n`, "utf8");
    const reclaimed = await workspace.createCandidate({ campaign, experimentId: "leased", signal });
    openCandidates.splice(openCandidates.indexOf(leased), 1, reclaimed);
    assert.equal(reclaimed.metadata.worktreeRoot, leased.metadata.worktreeRoot);
    await workspace.discardCandidate({ campaign, candidate: reclaimed, signal });
    openCandidates.splice(openCandidates.indexOf(reclaimed), 1);

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

    const raceA = await workspace.createCandidate({ campaign, experimentId: "race-a", signal });
    const raceB = await workspace.createCandidate({ campaign, experimentId: "race-b", signal });
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
