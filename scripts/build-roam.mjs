import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export async function buildRoamEntries(outDir = resolve("dist/roam")) {
  const configFile = fileURLToPath(new URL("../vite.roam.config.mjs", import.meta.url));
  for (const mode of ["cli", "cli-main", "intercom-helper", "supervisor"]) {
    await build({ configFile, mode, build: { outDir } });
    chmodSync(join(outDir, `${mode}.mjs`), 0o700);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRoamEntries();
}
