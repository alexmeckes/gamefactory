import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const external = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist-desktop/main",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        main: resolve(root, "desktop/main.ts"),
        session: resolve(root, "desktop/session.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external,
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
