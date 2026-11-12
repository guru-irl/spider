import { defineConfig } from "vite";
import { builtinModules } from "node:module";

const entries = {
  cli: "packages/roam/src/cli.ts",
  supervisor: "packages/roam/src/supervisor-main.ts",
};
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const native = ["better-sqlite3", "sqlite-vec"];

export default defineConfig(({ mode }) => {
  const entry = entries[mode];
  if (!entry) throw new Error("Unknown roaming build entry");
  return {
    plugins: [{
      name: "roam-no-pi-imports",
      enforce: "pre",
      resolveId(source) {
        if (source.startsWith("@earendil-works/pi-")) throw new Error("Roaming cannot import pi packages");
      },
    }],
    ssr: { target: "node", noExternal: true },
    build: {
      target: "node22", outDir: "dist/roam", emptyOutDir: mode === "cli",
      minify: false, sourcemap: false, ssr: entry,
      rollupOptions: {
        external: id => builtins.has(id) || native.some(name => id === name || id.startsWith(`${name}/`)),
        output: {
          format: "es", entryFileNames: `${mode}.mjs`, codeSplitting: false,
          banner: "#!/usr/bin/env node",
        },
      },
    },
  };
});
