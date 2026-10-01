// scripts/dev-link.mjs — install/remove the DEV-ONLY pi extension shim for the
// realtime dev loop (`npm run dev:link` / `npm run dev:unlink`).
//
// The shim lives in pi's GLOBAL auto-discovery dir (~/.pi/agent/extensions/*.ts, no
// project-trust prompt). Its native import bypasses jiti's import rewrite and keys
// the cache on bundle mtime and size, so /reload picks up a completed watch rebuild.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionShim } from "./extension-shim.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = join(repoRoot, "dist", "extension.js");
const extDir = join(homedir(), ".pi", "agent", "extensions");
const shim = join(extDir, "spider-dev.ts");

if (process.argv.includes("--unlink")) {
  if (existsSync(shim)) { rmSync(shim); console.log(`dev:unlink — removed ${shim}`); }
  else console.log(`dev:unlink — nothing to remove (${shim} absent)`);
} else {
  mkdirSync(extDir, { recursive: true });
  // A stable shim + a dev shim would double-load spider; drop the stable one.
  const stableShim = join(extDir, "spider.ts");
  if (existsSync(stableShim)) { rmSync(stableShim); console.log(`dev:link — removed stable shim ${stableShim}`); }
  writeFileSync(shim, extensionShim(bundle, true));
  console.log(`dev:link — wrote ${shim}\n  → ${bundle}\nNext: run \`npm run dev\` (rebuild-on-save), then \`/reload\` in an interactive pi.`);
}
