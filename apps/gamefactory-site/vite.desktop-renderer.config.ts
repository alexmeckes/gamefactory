import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(root, "desktop/renderer"),
  base: "./",
  resolve: { alias: { "@": root } },
  plugins: [react()],
  build: {
    target: "chrome142",
    outDir: resolve(root, "dist-desktop/renderer"),
    emptyOutDir: true,
    minify: true,
  },
});
