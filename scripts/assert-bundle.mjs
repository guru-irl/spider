// scripts/assert-bundle.mjs — post-bundle invariants.
import { existsSync, readFileSync, readdirSync } from "node:fs";

const OUT = "dist/extension.js";
if (!existsSync(OUT)) {
  console.error(`assert-bundle: ${OUT} missing — run the bundle first`);
  process.exit(1);
}

// vite.config.mjs sets rollupOptions.output.codeSplitting: false so this is a
// genuine single-file bundle: no dist/assets/*.js chunk from a local dynamic
// import (e.g. host/src/extension.ts's `await import("./control-bind")`). The
// packaging gates downstream (release.yml's tarball-contents check, this
// package's `files` allowlist) only ever look for dist/extension.js, so a
// second file here would ship silently broken. Assert the invariant directly
// instead of assuming it from codeSplitting's presence in the config.
const distEntries = readdirSync("dist").sort();
if (distEntries.length !== 1 || distEntries[0] !== "extension.js") {
  const found = distEntries.join(", ") || "(empty)";
  console.error(
    `assert-bundle: expected dist/ to contain exactly one file (extension.js) for a single-file bundle, found: ${found}. ` +
    "If a local dynamic import was added, either inline it or update this assertion and the release/CI packaging gates to account for the extra chunk."
  );
  process.exit(1);
}

const src = readFileSync(OUT, "utf-8");

// Two classes must be require()'d at runtime, not inlined:
//  - native modules (better-sqlite3 etc) — a prebuild loader string would leak in.
//  - pi host-provided peers (pi-coding-agent/pi-tui/typebox/...) — pi provides these
//    at runtime; inlining them bloats the bundle (~6.5mb) and risks duplicate modules.
const mustBeExternal = [
  "better-sqlite3", "sqlite-vec", "onnxruntime-node", "onnxruntime-web", "fastembed", "@xenova/transformers", "turndown",
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
