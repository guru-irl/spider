// scripts/assert-bundle.mjs — post-bundle invariants.
import { existsSync, readFileSync } from "node:fs";

const OUT = "dist/extension.js";
if (!existsSync(OUT)) {
  console.error(`assert-bundle: ${OUT} missing — run the bundle first`);
  process.exit(1);
}
const src = readFileSync(OUT, "utf-8");

// Native modules must be require()'d at runtime, not inlined. If esbuild
// inlined better-sqlite3's JS, the bindings.gyp/prebuild loader string leaks in.
const mustBeExternal = ["better-sqlite3", "sqlite-vec", "onnxruntime-node", "onnxruntime-web", "fastembed", "@xenova/transformers"];
const leaks = mustBeExternal.filter((m) => src.includes(`node_modules/${m}/`));
if (leaks.length) {
  console.error(`assert-bundle: native module(s) inlined (should be external): ${leaks.join(", ")}`);
  process.exit(1);
}
// The extension must default-export a function.
if (!/export\s*\{[^}]*\bas default\b|export default/.test(src) && !src.includes("spiderExtension")) {
  console.error("assert-bundle: no default export found in bundle");
  process.exit(1);
}
console.log("assert-bundle: OK (bundle present, natives external, default export present)");
