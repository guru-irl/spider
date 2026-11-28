import { defineConfig } from "vite";
import { builtinModules } from "node:module";
import entries from "./scripts/roam-entries.json" with { type: "json" };

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const native = ["better-sqlite3", "sqlite-vec"];

export default defineConfig(({ mode }) => {
  if (!Object.hasOwn(entries, mode)) throw new Error("Unknown roaming build entry");
  const entry = entries[mode];
  return {
    define: { "import.meta.spiderIntercomBrokerRelative": JSON.stringify("../intercom/broker.mjs") },
    plugins: [{
      name: "roam-no-pi-imports",
      enforce: "pre",
      resolveId(source, importer) {
        if (source.startsWith("@earendil-works/pi-")) throw new Error(`Roaming cannot import pi packages: ${source} from ${importer}`);
      },
    }],
    ssr: { target: "node", noExternal: true },
    build: {
      target: "node22", outDir: "dist/roam", emptyOutDir: mode === "cli",
      minify: false, sourcemap: false, ssr: entry,
      rollupOptions: {
        external: id => builtins.has(id) || native.some(name => id === name || id.startsWith(`${name}/`)) ||
          mode === "cli" && (id === "./cli-main.mjs" || id === "./intercom-helper.mjs"),
        output: {
          format: "es", entryFileNames: `${mode}.mjs`, codeSplitting: false,
          banner: "#!/usr/bin/env node",
        },
      },
    },
  };
});
