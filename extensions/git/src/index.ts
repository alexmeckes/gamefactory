import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Campaign, Candidate, WorkspaceDriver } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

interface CommandResult { stdout: string; stderr: string; }
const repositoryAcceptanceQueues = new Map<string, Promise<void>>();

async function withRepositoryAcceptanceLock<T>(repositoryRoot: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(repositoryRoot).toLowerCase();
  const previous = repositoryAcceptanceQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const tail = previous.then(() => current);
  repositoryAcceptanceQueues.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (repositoryAcceptanceQueues.get(key) === tail) repositoryAcceptanceQueues.delete(key);
  }
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matches(path: string, pattern: string): boolean {
  const escaped = normalized(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(normalized(path));
}

function changedFiles(status: string): string[] {
  return status.split(/\r?\n/).filter(Boolean).map((line) => {
    const pathStart = line[2] === " " ? 3 : 2;
    return normalized(line.slice(pathStart).split(" -> ").at(-1) ?? "");
  });
}

function isFactoryArtifact(path: string): boolean {
  return path.startsWith(".factory/") || path.includes("/.factory/");
}

function enforcePaths(campaign: Campaign, candidate: Candidate, files: string[]): void {
  const projectRelative = typeof candidate.metadata.projectRelative === "string" ? normalized(candidate.metadata.projectRelative) : "";
  for (const repositoryPath of files.filter((path) => !isFactoryArtifact(path))) {
    if (projectRelative && repositoryPath !== projectRelative && !repositoryPath.startsWith(`${projectRelative}/`)) {
      throw new Error(`Candidate changed a path outside the campaign project: ${repositoryPath}`);
    }
    const projectPath = projectRelative ? repositoryPath.slice(projectRelative.length + 1) : repositoryPath;
    if ((campaign.immutablePaths ?? []).some((pattern) => matches(projectPath, pattern))) {
      throw new Error(`Candidate changed immutable path: ${projectPath}`);
    }
    if ((campaign.mutablePaths?.length ?? 0) > 0 && !campaign.mutablePaths!.some((pattern) => matches(projectPath, pattern))) {
      throw new Error(`Candidate changed undeclared path: ${projectPath}`);
    }
  }
}

function run(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolveResult({ stdout: stdout.trim(), stderr: stderr.trim() })
      : reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`)));
  });
}

function worktreeParent(repositoryRoot: string, campaign: Campaign, runtimeWorktreeRoot?: string): string {
  const parameters = campaign.parameters as Record<string, unknown> | undefined;
  const git = parameters?.git && typeof parameters.git === "object" && !Array.isArray(parameters.git)
    ? parameters.git as Record<string, unknown>
    : undefined;
  const configured = typeof git?.worktreeRoot === "string" && git.worktreeRoot.trim() ? git.worktreeRoot : undefined;
  const parent = configured ? resolve(configured) : runtimeWorktreeRoot ? resolve(runtimeWorktreeRoot) : resolve(repositoryRoot, "..", ".gamefactory-worktrees");
  const insideRepository = relative(repositoryRoot, parent);
  if (!insideRepository || (!insideRepository.startsWith("..") && !isAbsolute(insideRepository))) {
    throw new Error("Git worktreeRoot must be outside the repository");
  }
  return parent;
}

function worktreeRoot(repositoryRoot: string, campaign: Campaign, experimentId: string, runtimeWorktreeRoot?: string): { parent: string; root: string } {
  const parent = worktreeParent(repositoryRoot, campaign, runtimeWorktreeRoot);
  const readable = `${campaign.id}-${experimentId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  const identity = createHash("sha256").update(`${resolve(repositoryRoot)}\0${campaign.id}\0${experimentId}`).digest("hex").slice(0, 16);
  const root = resolve(parent, `${basename(repositoryRoot)}-${readable}-${identity}`);
  const traversal = relative(parent, root);
  if (traversal.startsWith("..") || traversal === "") throw new Error("Unsafe worktree path");
  return { parent, root };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function claimWorktree(ownerPath: string): Promise<void> {
  await mkdir(dirname(ownerPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number((JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown }).pid);
      } catch {
        ownerPid = 0;
      }
      if (processIsAlive(ownerPid)) throw new Error(`Candidate worktree is already owned by live process ${ownerPid}`);
      await rm(ownerPath, { force: true });
    }
  }
  throw new Error(`Unable to claim candidate worktree lease: ${ownerPath}`);
}

interface CleanupFileSystem {
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const cleanupFileSystem: CleanupFileSystem = {
  rename,
  remove: (path) => rm(path, { recursive: true, force: true })
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function renameWithTransientRetries(
  fileSystem: CleanupFileSystem,
  source: string,
  destination: string,
  delays: readonly number[]
): Promise<void> {
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
    try {
      await fileSystem.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw lastError;
}

/**
 * Removes a managed worktree without ever recursively deleting the live path.
 * The rename is the transaction boundary: failure leaves the candidate intact;
 * success makes any later deletion failure harmless, recoverable trash.
 */
export async function removeWorktreeTransactionally(
  projectRoot: string,
  root: string,
  fileSystem: CleanupFileSystem = cleanupFileSystem,
  retryDelays: readonly number[] = [0, 250, 750, 1_500, 3_000, 6_000]
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Worktree cleanup timed out")), 20_000);
  try {
    if (!(await pathExists(root))) {
      await run("git", ["worktree", "prune"], projectRoot, controller.signal).catch(() => undefined);
      return;
    }
    const managedParent = dirname(root);
    const trashParent = resolve(managedParent, ".gamefactory-trash");
    const trashRoot = resolve(trashParent, `${basename(root)}-${process.pid}-${randomUUID().slice(0, 8)}`);
    const traversal = relative(trashParent, trashRoot);
    if (!traversal || traversal.startsWith("..")) throw new Error("Unsafe worktree quarantine path");
    await mkdir(trashParent, { recursive: true });
    await renameWithTransientRetries(fileSystem, root, trashRoot, retryDelays);
    await run("git", ["worktree", "prune"], projectRoot, controller.signal).catch(() => undefined);
    await fileSystem.remove(trashRoot).catch(() => undefined);
  } finally {
    clearTimeout(timeout);
  }
}

function managedWorktree(campaign: Campaign, candidate: Candidate): { repositoryRoot: string; worktree: string; ownerPath: string } {
  if (candidate.metadata.provider !== "git.worktree") throw new Error(`Refusing Git operation for candidate not owned by git.worktree: ${candidate.id}`);
  if (typeof candidate.metadata.worktreeRoot !== "string" || typeof candidate.metadata.repositoryRoot !== "string") {
    throw new Error(`Candidate ${candidate.id} is missing managed worktree metadata`);
  }
  const repositoryRoot = resolve(candidate.metadata.repositoryRoot);
  const worktree = resolve(candidate.metadata.worktreeRoot);
  const managedParent = typeof candidate.metadata.managedParent === "string"
    ? resolve(candidate.metadata.managedParent)
    : worktreeParent(repositoryRoot, campaign);
  const traversal = relative(managedParent, worktree);
  const campaignTraversal = relative(repositoryRoot, resolve(campaign.projectRoot));
  const candidateTraversal = relative(worktree, resolve(candidate.root));
  const ownerPath = typeof candidate.metadata.ownerPath === "string" ? resolve(candidate.metadata.ownerPath) : `${worktree}.owner.json`;
  const ownerTraversal = relative(managedParent, ownerPath);
  if (!traversal || traversal.startsWith("..") || !ownerTraversal || ownerTraversal.startsWith("..") || campaignTraversal.startsWith("..") || candidateTraversal.startsWith("..") || resolve(campaign.projectRoot).toLowerCase() === worktree.toLowerCase()) {
    throw new Error(`Candidate ${candidate.id} has an unsafe managed worktree path`);
  }
  return { repositoryRoot, worktree, ownerPath };
}

function operationToken(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

async function acceptedOperationRevision(repositoryRoot: string, token: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await run("git", ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=GameFactory-Operation: ${token}`, "HEAD"], repositoryRoot, signal);
  return result.stdout || undefined;
}

async function hasCherryPickInProgress(repositoryRoot: string, signal: AbortSignal): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "CHERRY_PICK_HEAD"], repositoryRoot, signal);
    return true;
  } catch {
    return false;
  }
}

export class GitWorktreeWorkspace implements WorkspaceDriver {
  readonly id = "git.worktree";

  async createCandidate({ campaign, experimentId, signal, runtime }: Parameters<WorkspaceDriver["createCandidate"]>[0]): Promise<Candidate> {
    const repositoryRoot = (await run("git", ["rev-parse", "--show-toplevel"], campaign.projectRoot, signal)).stdout;
    const baseRevision = (await run("git", ["rev-parse", "HEAD"], campaign.projectRoot, signal)).stdout;
    const managed = worktreeRoot(repositoryRoot, campaign, experimentId, runtime?.worktreeRoot);
    const worktree = managed.root;
    const ownerPath = `${worktree}.owner.json`;
    await mkdir(dirname(worktree), { recursive: true });
    await claimWorktree(ownerPath);
    try {
      await removeWorktreeTransactionally(repositoryRoot, worktree);
      await run("git", ["worktree", "add", "--detach", worktree, baseRevision], repositoryRoot, signal);
    } catch (error) {
      await rm(ownerPath, { force: true });
      throw error;
    }
    const projectRelative = relative(repositoryRoot, campaign.projectRoot);
    const root = resolve(worktree, projectRelative);
    return { id: experimentId, root, baseRevision, metadata: { isolated: true, provider: this.id, worktreeRoot: worktree, ownerPath, managedParent: managed.parent, repositoryRoot, projectRelative } };
  }

  async acceptCandidate({ campaign, candidate, signal, operationId }: Parameters<WorkspaceDriver["acceptCandidate"]>[0]): Promise<{ revision?: string; candidateRevision?: string; changed?: boolean }> {
    const { worktree, repositoryRoot, ownerPath } = managedWorktree(campaign, candidate);
    const token = operationToken(operationId ?? `${campaign.id}/${candidate.id}/${worktree}`);
    const alreadyAccepted = await acceptedOperationRevision(repositoryRoot, token, signal);
    if (alreadyAccepted) {
      await removeWorktreeTransactionally(repositoryRoot, worktree);
      await rm(ownerPath, { force: true });
      return { revision: alreadyAccepted, changed: true };
    }
    if (!(await pathExists(worktree))) {
      throw new Error(`Candidate ${candidate.id} is missing and acceptance operation ${token} is not present in repository history`);
    }
    const status = (await run("git", ["status", "--porcelain", "--untracked-files=all"], worktree, signal)).stdout;
    const headRevision = (await run("git", ["rev-parse", "HEAD"], worktree, signal)).stdout;
    const committed = candidate.baseRevision && headRevision !== candidate.baseRevision
      ? (await run("git", ["diff", "--name-only", candidate.baseRevision, headRevision], worktree, signal)).stdout.split(/\r?\n/).filter(Boolean).map(normalized)
      : [];
    const files = [...new Set([...changedFiles(status), ...committed])].filter((path) => !isFactoryArtifact(path));
    enforcePaths(campaign, candidate, files);
    if (files.length === 0) {
      return { changed: false };
    }
    const currentMessage = headRevision !== candidate.baseRevision
      ? (await run("git", ["log", "-1", "--format=%B"], worktree, signal)).stdout
      : "";
    let revision = headRevision;
    if (!currentMessage.includes(`GameFactory-Operation: ${token}`)) {
      if (!candidate.baseRevision) throw new Error(`Candidate ${candidate.id} cannot be accepted idempotently without a base revision`);
      if (headRevision !== candidate.baseRevision) await run("git", ["reset", "--soft", candidate.baseRevision], worktree, signal);
      await run("git", ["add", "--all", "--", ".", ":(exclude)**/.factory/**"], worktree, signal);
      await run("git", ["reset", "--", ":(glob)**/.factory/**"], worktree, signal);
      await run("git", ["-c", "user.name=GameFactory", "-c", "user.email=gamefactory@localhost", "commit", "-m", `gamefactory: accept ${campaign.id}/${candidate.id}\n\nGameFactory-Operation: ${token}`], worktree, signal);
      revision = (await run("git", ["rev-parse", "HEAD"], worktree, signal)).stdout;
    }
    const acceptedRevision = await withRepositoryAcceptanceLock(repositoryRoot, async () => {
      const completed = await acceptedOperationRevision(repositoryRoot, token, signal);
      if (completed) return completed;
      if (await hasCherryPickInProgress(repositoryRoot, signal)) {
        await run("git", ["cherry-pick", "--abort"], repositoryRoot, signal);
      }
      const mainStatus = (await run("git", ["status", "--porcelain"], repositoryRoot, signal)).stdout;
      if (mainStatus) throw new Error("Main worktree is dirty; refusing to cherry-pick an accepted candidate");
      const mainRevision = (await run("git", ["rev-parse", "HEAD"], repositoryRoot, signal)).stdout;
      if (candidate.baseRevision && mainRevision !== candidate.baseRevision) {
        throw new Error(`Candidate base ${candidate.baseRevision} is stale; main worktree is now ${mainRevision}`);
      }
      try {
        await run("git", ["cherry-pick", revision], repositoryRoot, signal);
      } catch (error) {
        const cleanup = new AbortController();
        const timeout = setTimeout(() => cleanup.abort(), 20_000);
        await run("git", ["cherry-pick", "--abort"], repositoryRoot, cleanup.signal).catch(() => undefined);
        clearTimeout(timeout);
        throw error;
      }
      return (await run("git", ["rev-parse", "HEAD"], repositoryRoot, signal)).stdout;
    });
    await removeWorktreeTransactionally(repositoryRoot, worktree);
    await rm(ownerPath, { force: true });
    return { revision: acceptedRevision, candidateRevision: revision, changed: true };
  }

  async discardCandidate({ campaign, candidate, signal }: Parameters<WorkspaceDriver["discardCandidate"]>[0]): Promise<void> {
    void signal;
    const { worktree, repositoryRoot, ownerPath } = managedWorktree(campaign, candidate);
    await removeWorktreeTransactionally(repositoryRoot, worktree);
    await rm(ownerPath, { force: true });
  }
}

export default defineExtension((api) => api.register("workspace", "git.worktree", new GitWorktreeWorkspace()));
