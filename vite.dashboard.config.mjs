import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { usageBrowserBoundary } from "./scripts/usage-dashboard-browser-boundary.mjs";
import { fixtureApiMiddleware } from "./scripts/usage-dashboard-fixtures.mjs";
const checkout = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(checkout, "packages/host/src/usage/web");
const scratch = resolve(checkout, ".spider/scratch");
export default defineConfig(({ mode }) => ({
  root, publicDir: false,
  server: { fs: { strict: true, allow: [root, resolve(checkout, "packages/host/src/usage/__tests__/fixtures/redesign-contract.ts")] } },
  plugins: [usageBrowserBoundary(root), fixtureApiMiddleware(), {
    name: "spider-dashboard-output",
    configResolved(config) {
      if (config.command !== "build") return;
      const output = resolve(root, config.build.outDir);
      if (mode === "production") {
        if (output !== resolve(checkout, "dist/dashboard")) throw new Error("dashboard production output must be dist/dashboard");
        return;
      }
      const path = relative(scratch, output);
      if (!isAbsolute(config.build.outDir) || !path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
        throw new Error("dashboard non-production builds require an explicit absolute output directory under owned scratch");
      }
    },
  }],
  build: {
    outDir: resolve(checkout, "dist/dashboard"), emptyOutDir: true,
    target: "es2022", sourcemap: false, modulePreload: { polyfill: false }, assetsInlineLimit: 0,
    rollupOptions: {
      input: { index: resolve(root, "index.html"), ...(["development", "e2e"].includes(mode) ? { states: resolve(root, "states.html") } : {}) },
      output: { entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
}));
