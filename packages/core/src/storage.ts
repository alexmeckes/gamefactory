import { isAbsolute, relative, resolve } from "node:path";

export interface FactoryStorageOptions {
  cwd: string;
  dataRoot?: string;
}

/**
 * Resolves a portable, repository-relative state path. When a machine-local
 * data root is configured the same relative layout is rooted there instead,
 * keeping generated state out of synced source trees without changing the
 * checked-in campaign configuration.
 */
export function resolveFactoryStatePath(
  options: FactoryStorageOptions,
  configured: string | undefined,
  fallback: string,
  label: string,
): string {
  const cwd = resolve(options.cwd);
  const logical = configured ?? fallback;
  if (!logical || logical.includes("\0") || isAbsolute(logical)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const repositoryTarget = resolve(cwd, logical);
  const repositoryTraversal = relative(cwd, repositoryTarget);
  if (!repositoryTraversal || repositoryTraversal.startsWith("..") || isAbsolute(repositoryTraversal)) {
    throw new Error(`${label} must stay inside the runner working directory`);
  }
  if (!options.dataRoot) return repositoryTarget;
  const dataRoot = resolve(options.dataRoot);
  const target = resolve(dataRoot, repositoryTraversal);
  const dataTraversal = relative(dataRoot, target);
  if (!dataTraversal || dataTraversal.startsWith("..") || isAbsolute(dataTraversal)) {
    throw new Error(`${label} must stay inside the GameFactory data root`);
  }
  return target;
}

export function configuredFactoryDataRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.GAMEFACTORY_DATA_ROOT?.trim();
  return value ? resolve(value) : undefined;
}
