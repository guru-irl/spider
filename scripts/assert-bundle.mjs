// scripts/assert-bundle.mjs — post-bundle invariants.
import { existsSync, readFileSync } from "node:fs";

const OUT = "dist/extension.js";
if (!existsSync(OUT)) {
  console.error(`assert-bundle: ${OUT} missing — run the bundle first`);
  process.exit(1);
}
const src = readFileSync(OUT, "utf-8");

// Two classes must be require()'d at runtime, not inlined:
//  - native modules (better-sqlite3 etc) — a prebuild loader string would leak in.
//  - pi host-provided peers (pi-coding-agent/pi-tui/typebox/...) — pi provides these
//    at runtime; inlining them bloats the bundle (~6.5mb) and risks duplicate modules.
const mustBeExternal = [
  "better-sqlite3", "sqlite-vec", "onnxruntime-node", "onnxruntime-web", "fastembed", "@xenova/transformers",
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
];
const leaks = mustBeExternal.filter((m) => src.includes(`node_modules/${m}/`));
if (leaks.length) {
  console.error(`assert-bundle: module(s) inlined (should be external): ${leaks.join(", ")}`);
  process.exit(1);
}
// The extension must default-export a function.
if (!/export\s*\{[^}]*\bas default\b|export default/.test(src) && !src.includes("spiderExtension")) {
  console.error("assert-bundle: no default export found in bundle");
  process.exit(1);
}
console.log("assert-bundle: OK (bundle present, natives external, default export present)");
