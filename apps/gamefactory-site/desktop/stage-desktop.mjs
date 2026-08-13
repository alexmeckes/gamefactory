import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(appRoot, "dist-desktop");
const packageRoot = resolve(buildRoot, "package");
if (!packageRoot.startsWith(`${buildRoot}\\`) && !packageRoot.startsWith(`${buildRoot}/`)) throw new Error("Unsafe desktop package path");
await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await Promise.all([
  cp(resolve(buildRoot, "main"), resolve(packageRoot, "main"), { recursive: true }),
  cp(resolve(buildRoot, "preload"), resolve(packageRoot, "preload"), { recursive: true }),
  cp(resolve(buildRoot, "renderer"), resolve(packageRoot, "renderer"), { recursive: true }),
]);
await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify({
  name: "gamefactory-observatory",
  productName: "GameFactory Observatory",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "main/main.js",
}, null, 2)}\n`, "utf8");
