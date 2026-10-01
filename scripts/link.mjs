// scripts/link.mjs — install/remove the STABLE pi extension shim for a fixed
// (non-dev) install (`npm run link` / `npm run unlink`).
//
// Writes spider.ts pointing at this checkout's dist. Both stable and dev shims
// use Node's native import with a bundle-metadata cache key for /reload.
// Removes any dev shim to avoid a double load.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionShim } from "./extension-shim.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = join(repoRoot, "dist", "extension.js");
const extDir = join(homedir(), ".pi", "agent", "extensions");
const shim = join(extDir, "spider.ts");
const devShim = join(extDir, "spider-dev.ts");

if (process.argv.includes("--unlink")) {
  if (existsSync(shim)) { rmSync(shim); console.log(`unlink — removed ${shim}`); }
  else console.log(`unlink — nothing to remove (${shim} absent)`);
} else {
  mkdirSync(extDir, { recursive: true });
  // A dev shim + a stable shim would double-load spider; drop the dev one.
  if (existsSync(devShim)) { rmSync(devShim); console.log(`link — removed stale dev shim ${devShim}`); }
  writeFileSync(shim, extensionShim(bundle));
  console.log(`link — wrote ${shim}\n  → ${bundle}\nNext: \`/reload\` in an interactive pi, or relaunch.`);
}
