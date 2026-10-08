// scripts/assert-bundle.mjs — post-bundle invariants.
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { parseBuildId } from "./build-id.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
if (distEntries.join() !== "dashboard,extension.js") {
  const found = distEntries.join(", ") || "(empty)";
  console.error(
    `assert-bundle: expected dist/ to contain exactly dashboard/ and extension.js, found: ${found}. ` +
    "If a local dynamic import was added, either inline it or update this assertion and the release/CI packaging gates to account for the extra chunk."
  );
  process.exit(1);
}

try {
  const dashboard = "dist/dashboard";
  if (!lstatSync(dashboard).isDirectory() || readdirSync(dashboard).sort().join() !== "assets,index.html" || !lstatSync(`${dashboard}/assets`).isDirectory()) throw new Error("invalid dashboard shape");
  const names = readdirSync(`${dashboard}/assets`);
  if (!names.some(name => name.endsWith(".js")) || !names.some(name => name.endsWith(".css")) || names.some(name => !/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(name))) throw new Error("invalid dashboard assets");
  const files = ["index.html", ...names.map(name => `assets/${name}`)];
  let total = 0;
  for (const file of files) {
    const info = lstatSync(`${dashboard}/${file}`);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid dashboard file");
    total += info.size;
  }
  if (total > 512 * 1024) throw new Error("dashboard exceeds 512 KiB");
  const html = readFileSync(`${dashboard}/index.html`, "utf8");
  if (/<style\b|\sstyle\s*=|\son\w+\s*=/i.test(html) || /<script\b(?![^>]*\bsrc\s*=)/i.test(html)) throw new Error("inline dashboard code");
  if (/\b(?:src|href)\s*=\s*[^"'\s]/i.test(html)) throw new Error("invalid dashboard HTML");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== (html.match(/<script\b/gi) ?? []).length || scripts.some(script => script[1].trim())) throw new Error("invalid dashboard HTML");
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (!names.some(name => match[1] === `/assets/${name}`)) throw new Error("missing or invalid dashboard reference");
  }
  if (!/<script\b[^>]*\bsrc\s*=\s*["']\/assets\/[A-Za-z0-9_-]+\.js["']/i.test(html) || !/<link\b[^>]*\bhref\s*=\s*["']\/assets\/[A-Za-z0-9_-]+\.css["']/i.test(html)) throw new Error("missing dashboard entries");
} catch (error) {
  console.error(`assert-bundle: dashboard missing or invalid (${error instanceof Error ? error.message : "invalid"})`);
  process.exit(1);
}

const src = readFileSync(OUT, "utf-8");
if (!parseBuildId(src.slice(0, 16 * 1024))) {
  console.error("assert-bundle: build marker missing or malformed in bundle header (expected SPIDER_BUILD_ID=<sha>[-dirty]@<ISO timestamp>)");
  process.exit(1);
}

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
// The bundle's top level only defines schemas, constants and lazy factories:
// no DB opens, model initialization, timers or activation. Keep it natively
// linkable, with no top-level await of optional modules (see docs/architecture/runtime-lifecycle.md).
try {
  const mod = await import(pathToFileURL(resolve(OUT)).href);
  if (typeof mod.default !== "function") throw new Error("default export is not a function");
} catch (error) {
  console.error(`assert-bundle: native import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log("assert-bundle: OK (single-file extension and packaged dashboard, build marker valid, natives external, native import and default export verified)");
