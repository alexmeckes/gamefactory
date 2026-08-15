import { cp, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadProject, ProjectJourneyJournal } from "@gamefactory/project-sdk";
import type { SqliteProjectJourneyIndex } from "@gamefactory/project-sdk/sqlite";

const ignoredDirectories = new Set([".git", "node_modules", ".godot", "dist", "dist-desktop", "out"]);

async function walk(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const path = resolve(directory, entry.name);
      if (predicate(entry.name)) output.push(path);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name) && entry.name !== ".factory") await visit(path);
    }
  };
  await visit(root);
  return output;
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  try { await visit(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return output;
}

function assertSeparateRoot(cwd: string, dataRoot: string): void {
  const source = resolve(cwd);
  const target = resolve(dataRoot);
  const targetFromSource = relative(source, target);
  const sourceFromTarget = relative(target, source);
  const targetInsideSource = !targetFromSource || (!targetFromSource.startsWith("..") && !isAbsolute(targetFromSource));
  const sourceInsideTarget = !sourceFromTarget || (!sourceFromTarget.startsWith("..") && !isAbsolute(sourceFromTarget));
  if (targetInsideSource || sourceInsideTarget) throw new Error("GAMEFACTORY_DATA_ROOT and the source repository must not contain one another");
}

export async function storageDoctor(cwd: string, dataRoot: string, worktreeRoot: string | undefined, index: SqliteProjectJourneyIndex): Promise<Array<{ check: string; ok: boolean; message: string }>> {
  const checks: Array<{ check: string; ok: boolean; message: string }> = [];
  try { assertSeparateRoot(cwd, dataRoot); checks.push({ check: "data-root:isolation", ok: true, message: resolve(dataRoot) }); }
  catch (error) { checks.push({ check: "data-root:isolation", ok: false, message: error instanceof Error ? error.message : String(error) }); }
  try {
    await mkdir(dataRoot, { recursive: true });
    const probe = resolve(dataRoot, `.write-probe-${process.pid}`);
    const handle = await open(probe, "wx");
    await handle.close();
    await rm(probe, { force: true });
    checks.push({ check: "data-root:writable", ok: true, message: resolve(dataRoot) });
  } catch (error) { checks.push({ check: "data-root:writable", ok: false, message: error instanceof Error ? error.message : String(error) }); }
  if (worktreeRoot) {
    const source = resolve(cwd);
    const target = resolve(worktreeRoot);
    const targetFromSource = relative(source, target);
    const sourceFromTarget = relative(target, source);
    const disjoint = Boolean(targetFromSource)
      && (targetFromSource.startsWith("..") || isAbsolute(targetFromSource))
      && Boolean(sourceFromTarget)
      && (sourceFromTarget.startsWith("..") || isAbsolute(sourceFromTarget));
    checks.push({ check: "worktree-root:isolation", ok: disjoint, message: disjoint ? target : "Worktree root and repository must not contain one another" });
  } else checks.push({ check: "worktree-root:configured", ok: false, message: "Set GAMEFACTORY_WORKTREE_ROOT or configure GAMEFACTORY_DATA_ROOT/worktrees" });
  const stats = index.stats();
  checks.push({ check: "sqlite:schema", ok: stats.schemaVersion >= 3, message: `schema ${stats.schemaVersion} at ${index.path}` });
  return checks;
}

export async function migrateStorage(cwd: string, dataRoot: string, index: SqliteProjectJourneyIndex): Promise<{ copiedRoots: number; indexedFiles: number; indexedRecords: number; importedProjects: number }> {
  assertSeparateRoot(cwd, dataRoot);
  await mkdir(dataRoot, { recursive: true });
  const factoryRoots = await walk(cwd, (name) => name === ".factory");
  for (const source of factoryRoots) {
    const destination = resolve(dataRoot, relative(cwd, source));
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, force: true, preserveTimestamps: true });
  }
  let importedProjects = 0;
  for (const manifestPath of await walk(cwd, (name) => name === "gamefactory.project.json")) {
    const project = await loadProject(manifestPath);
    if (!project.historyPath) continue;
    await index.sync(await new ProjectJourneyJournal(project.historyPath).read());
    importedProjects += 1;
  }
  const refreshed = await refreshStorageIndex(dataRoot, index);
  return { copiedRoots: factoryRoots.length, ...refreshed, importedProjects };
}

export async function storageStatus(dataRoot: string, index: SqliteProjectJourneyIndex): Promise<{ dataRoot: string; files: number; bytes: number; jsonlFiles: number; database: ReturnType<SqliteProjectJourneyIndex["stats"]> }> {
  const files = await filesUnder(dataRoot);
  await refreshStorageIndex(dataRoot, index);
  let bytes = 0;
  for (const path of files) bytes += (await stat(path)).size;
  return { dataRoot: resolve(dataRoot), files: files.length, bytes, jsonlFiles: files.filter((path) => path.toLowerCase().endsWith(".jsonl")).length, database: index.stats() };
}

export async function refreshStorageIndex(dataRoot: string, index: SqliteProjectJourneyIndex): Promise<{ indexedFiles: number; indexedRecords: number }> {
  const jsonl = (await filesUnder(dataRoot)).filter((path) => path.toLowerCase().endsWith(".jsonl"));
  let indexedRecords = 0;
  for (const path of jsonl) indexedRecords += await index.indexJsonl(path, dataRoot);
  index.pruneJsonlSources(jsonl, dataRoot);
  return { indexedFiles: jsonl.length, indexedRecords };
}

export async function storageGc(dataRoot: string, apply: boolean, now = Date.now()): Promise<{ applied: boolean; candidates: Array<{ path: string; bytes: number }>; reclaimedBytes: number; note: string }> {
  const candidates: Array<{ path: string; bytes: number }> = [];
  for (const path of await filesUnder(dataRoot)) {
    const traversal = relative(dataRoot, path).replaceAll("\\", "/");
    const disposable = traversal.split("/").some((part) => part === "cache" || part === "tmp");
    if (!disposable) continue;
    const info = await stat(path);
    if (now - info.mtimeMs < 7 * 24 * 60 * 60 * 1_000) continue;
    candidates.push({ path, bytes: info.size });
  }
  if (apply) for (const candidate of candidates) await rm(candidate.path, { force: true });
  return {
    applied: apply,
    candidates,
    reclaimedBytes: apply ? candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) : 0,
    note: "Only files older than seven days under explicitly disposable cache/tmp directories are eligible; content-addressed artifacts are never deleted.",
  };
}
