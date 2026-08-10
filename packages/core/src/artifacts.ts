import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import type { ArtifactReference, Logger } from "./types.js";

export class ContentAddressedArtifactStore {
  constructor(readonly root: string, private readonly logger: Logger) {}

  async preserve(artifacts: ArtifactReference[], namespace: string): Promise<ArtifactReference[]> {
    return Promise.all(artifacts.map((artifact) => this.preserveOne(artifact, namespace)));
  }

  private async preserveOne(artifact: ArtifactReference, namespace: string): Promise<ArtifactReference> {
    const source = resolve(artifact.path);
    try {
      const info = await stat(source);
      if (!info.isFile()) throw new Error("artifact is not a regular file");
      const content = await readFile(source);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const extension = extname(source).slice(0, 16);
      const destination = resolve(this.root, sha256.slice(0, 2), `${sha256}${extension}`);
      await mkdir(resolve(this.root, sha256.slice(0, 2)), { recursive: true });
      if (source.toLowerCase() !== destination.toLowerCase()) {
        await copyFile(source, destination, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      return {
        ...artifact,
        path: destination,
        sha256,
        metadata: { ...artifact.metadata, sourcePath: source, sourceName: basename(source), namespace }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Unable to preserve artifact", { path: source, namespace, error: message });
      return { ...artifact, metadata: { ...artifact.metadata, preservationError: message, namespace } };
    }
  }
}
