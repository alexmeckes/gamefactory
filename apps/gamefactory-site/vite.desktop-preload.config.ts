import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist-desktop/preload",
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(root, "desktop/preload.ts"), formats: ["cjs"], fileName: () => "preload.cjs" },
    rollupOptions: { external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
  },
});
