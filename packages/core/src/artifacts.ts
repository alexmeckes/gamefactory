import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { ArtifactReference, Logger } from "./types.js";

export type ArtifactPreservationErrorCode =
  | "invalid-source"
  | "not-found"
  | "not-file"
  | "outside-allowed-roots"
  | "read-failed"
  | "write-failed";

export interface ArtifactPreservationOptions {
  /**
   * Local roots artifacts may originate from. Omit this option to retain the
   * original allow-any-local-file behavior. An explicit empty list denies all
   * local artifact origins.
   */
  allowedRoots?: readonly string[];
}

export interface PreservedArtifactReference extends ArtifactReference {
  sha256: string;
  metadata: Record<string, unknown> & {
    sourcePath: string;
    sourceName: string;
    namespace: string;
    sizeBytes: number;
  };
}

export class ArtifactPreservationError extends Error {
  readonly name = "ArtifactPreservationError";

  constructor(
    readonly code: ArtifactPreservationErrorCode,
    message: string,
    readonly artifact: ArtifactReference,
    readonly source: string,
    readonly namespace: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

function isWithin(root: string, path: string): boolean {
  const traversal = relative(root, path);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export class ContentAddressedArtifactStore {
  constructor(
    readonly root: string,
    private readonly logger: Logger,
    private readonly options: ArtifactPreservationOptions = {}
  ) {}

  async preserve(
    artifacts: ArtifactReference[],
    namespace: string,
    options: ArtifactPreservationOptions = {}
  ): Promise<PreservedArtifactReference[]> {
    const allowedRoots = options.allowedRoots ?? this.options.allowedRoots;
    return Promise.all(artifacts.map((artifact) => this.preserveOne(artifact, namespace, allowedRoots)));
  }

  private async preserveOne(
    artifact: ArtifactReference,
    namespace: string,
    allowedRoots: readonly string[] | undefined
  ): Promise<PreservedArtifactReference> {
    if (typeof artifact.path !== "string" || artifact.path.trim().length === 0) {
      throw this.failure("invalid-source", artifact, artifact.path, namespace, "Artifact path must be a non-empty local path.");
    }

    const requestedSource = resolve(artifact.path);
    let source: string;
    try {
      source = await realpath(requestedSource);
    } catch (error) {
      const code: ArtifactPreservationErrorCode = errorCode(error) === "ENOENT" ? "not-found" : "read-failed";
      throw this.failure(code, artifact, requestedSource, namespace, `Unable to resolve artifact source ${requestedSource}.`, error);
    }

    if (allowedRoots !== undefined) {
      const canonicalRoots: string[] = [];
      for (const allowedRoot of allowedRoots) {
        try {
          canonicalRoots.push(await realpath(resolve(allowedRoot)));
        } catch (error) {
          throw this.failure(
            "invalid-source",
            artifact,
            source,
            namespace,
            `Unable to resolve allowed artifact root ${resolve(allowedRoot)}.`,
            error
          );
        }
      }
      if (!canonicalRoots.some((allowedRoot) => isWithin(allowedRoot, source))) {
        throw this.failure(
          "outside-allowed-roots",
          artifact,
          source,
          namespace,
          `Artifact source ${source} is outside the allowed artifact roots.`
        );
      }
    }

    let content: Buffer;
    try {
      const info = await stat(source);
      if (!info.isFile()) {
        throw this.failure("not-file", artifact, source, namespace, `Artifact source ${source} is not a regular file.`);
      }
      content = await readFile(source);
    } catch (error) {
      if (error instanceof ArtifactPreservationError) throw error;
      const code: ArtifactPreservationErrorCode = errorCode(error) === "ENOENT" ? "not-found" : "read-failed";
      throw this.failure(code, artifact, source, namespace, `Unable to read artifact source ${source}.`, error);
    }

    const sha256 = createHash("sha256").update(content).digest("hex");
    const extension = extname(source).slice(0, 16);
    const destinationDirectory = resolve(this.root, sha256.slice(0, 2));
    const destination = resolve(destinationDirectory, `${sha256}${extension}`);
    try {
      await mkdir(destinationDirectory, { recursive: true });
      if (source.toLowerCase() !== destination.toLowerCase()) {
        await copyFile(source, destination, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const stored = await readFile(destination);
        const storedSha256 = createHash("sha256").update(stored).digest("hex");
        if (storedSha256 !== sha256) {
          throw new Error(`Content-addressed destination failed verification: ${destination}`);
        }
      }
    } catch (error) {
      throw this.failure("write-failed", artifact, source, namespace, `Unable to store artifact ${source}.`, error);
    }

    return {
      ...artifact,
      path: destination,
      sha256,
      metadata: {
        ...artifact.metadata,
        sourcePath: source,
        sourceName: basename(source),
        namespace,
        sizeBytes: content.byteLength
      }
    };
  }

  private failure(
    code: ArtifactPreservationErrorCode,
    artifact: ArtifactReference,
    source: string,
    namespace: string,
    message: string,
    cause?: unknown
  ): ArtifactPreservationError {
    this.logger.warn("Unable to preserve artifact", { path: source, namespace, code, error: message });
    return new ArtifactPreservationError(code, message, artifact, source, namespace, cause === undefined ? {} : { cause });
  }
}
