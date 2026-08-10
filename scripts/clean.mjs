import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist") await rm(path, { recursive: true, force: true });
      else await walk(path);
    } else if (entry.name.endsWith(".tsbuildinfo")) {
      await rm(path, { force: true });
    }
  }
}

await walk(process.cwd());
