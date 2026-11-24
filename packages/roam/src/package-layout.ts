import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Module URLs identify an installed package, not necessarily an executable entry. */
export function roamingCliEntry(moduleUrl: URL): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    let name: unknown;
    try { name = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name; }
    catch { /* Bundles may be nested beneath the package manifest. */ }
    if (name === "@guru-irl/spider") return join(directory, "dist", "roam", "cli.mjs");
    const parent = dirname(directory);
    if (parent === directory) throw new Error("installed-cli-entry-unavailable");
    directory = parent;
  }
}
