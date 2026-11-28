import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import entries from "./roam-entries.json" with { type: "json" };

export async function buildRoamEntries(outDir = resolve("dist/roam")) {
  const configFile = fileURLToPath(new URL("../vite.roam.config.mjs", import.meta.url));
  // Build cli first: its Vite mode clears outDir before the other entries.
  for (const mode of ["cli", ...Object.keys(entries).filter(mode => mode !== "cli")]) {
    await build({ configFile, mode, build: { outDir } });
    chmodSync(join(outDir, `${mode}.mjs`), 0o700);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRoamEntries();
}
