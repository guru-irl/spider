// scripts/assert-bundle.mjs — post-bundle invariants.
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import ts from "typescript";
import { parseBuildId } from "./build-id.mjs";
import { resolve, dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

// --package verifies the actual gzip/tar artifact, not npm's proposed file list.
// Extract only regular files and directories under package/; reject links and traversal.
const args = process.argv.slice(2);
const packageCommit = args.length === 4 && args[0] === '--package' && args[2] === '--commit' && /^[0-9a-f]{7,40}$/.test(args[3]);
if (args.length && !packageCommit && (args.length !== 2 || !['--root', '--package'].includes(args[0]))) {
  throw new Error('usage: assert-bundle.mjs [--root <directory> | --package <tarball> [--commit <sha>]]');
}
let extracted;
if (args[0] === '--package') {
  const scratch = resolve('.spider/scratch/packaging');
  mkdirSync(scratch, { recursive: true });
  extracted = mkdtempSync(join(scratch, 'verify-'));
  process.on('exit', () => rmSync(extracted, { recursive: true, force: true }));
  const tar = gunzipSync(readFileSync(resolve(args[1])));
  let extendedPath;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const size = parseInt(text(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('invalid tar size');
    const type = text(156, 1);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      // npm uses POSIX extended headers for long filenames.
      const pax = body.toString('utf8');
      extendedPath = [...pax.matchAll(/(?:^|\n)\d+ path=([^\n]*)/g)].at(-1)?.[1];
    } else {
      const prefix = text(345, 155);
      const name = extendedPath ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
      extendedPath = undefined;
      if (!name.startsWith('package/') || name.includes('\\') || name.split('/').includes('..') || posix.isAbsolute(name)) throw new Error('invalid tar path');
      const destination = join(extracted, name);
      if (type === '5') mkdirSync(destination, { recursive: true });
      else if (type === '0' || type === '') {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, body);
      } else throw new Error('tarball contains a link or unsupported entry');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  process.chdir(join(extracted, 'package'));
} else if (args[0] === '--root') process.chdir(resolve(args[1]));

const OUT = "dist/extension.js";
if (!existsSync(OUT)) {
  console.error(`assert-bundle: ${OUT} missing — run the bundle first`);
  process.exit(1);
}

// vite.config.mjs sets rollupOptions.output.codeSplitting: false so this is a
// genuine single-file bundle: no dist/assets/*.js chunk from a local dynamic
// import (e.g. host/src/extension.ts's `await import("./control-bind")`). The
// packaging gates also account for the separately built Herdr programs and
// dashboard, but never extension chunks. Assert the invariant directly
// instead of assuming it from codeSplitting's presence in the config.
const distEntries = readdirSync("dist").sort();
if (distEntries.join() !== "dashboard,extension.js,herdr") {
  const found = distEntries.join(", ") || "(empty)";
  console.error(
    `assert-bundle: expected dist/ to contain exactly dashboard/, extension.js and herdr/, found: ${found}. ` +
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
const buildId = parseBuildId(src.slice(0, 16 * 1024));
if (!buildId) {
  console.error("assert-bundle: build marker missing or malformed in bundle header (expected SPIDER_BUILD_ID=<sha>[-dirty]@<ISO timestamp>)");
  process.exit(1);
}

if (packageCommit && (buildId.sha !== args[3] || buildId.dirty)) {
  console.error(`assert-bundle: packed build identity does not match clean commit ${args[3]} (found ${buildId.sha}${buildId.dirty ? '-dirty' : ''})`);
  process.exit(1);
}

// Two classes must be require()'d at runtime, not inlined:
//  - native modules (better-sqlite3 etc) — a prebuild loader string would leak in.
//  - pi host-provided peers (pi-coding-agent/pi-tui/typebox/...) — pi provides these
//    at runtime; inlining them bloats the bundle (~6.5mb) and risks duplicate modules.
const mustBeExternal = [
  "better-sqlite3", "sqlite-vec", "onnxruntime-node", "onnxruntime-web", "fastembed", "@huggingface/transformers", "@xenova/transformers", "turndown",
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
];
const leaks = mustBeExternal.filter((m) => src.includes(`node_modules/${m}/`));
if (leaks.length) {
  console.error(`assert-bundle: module(s) inlined (should be external): ${leaks.join(", ")}`);
  process.exit(1);
}
try {
  const entries = ['cli.mjs', 'feed-reader.mjs', 'remote-runtime.mjs', 'subagent-supervisor.mjs', 'viewer-pi.mjs', 'viewer.mjs'];
  if (!lstatSync('dist/herdr').isDirectory() || readdirSync('dist/herdr').sort().join() !== entries.join()) throw new Error('Herdr entries missing or unexpected runtime chunk');
  const assets = [
    'agents/children.js', 'agents/move.js', 'agents/move-menu.js', 'agents/bot.svg', 'agents/list.svg', 'agents/bell.svg', 'agents/chevron-up.svg', 'agents/corner-up-left.svg', 'agents/space-pentagon.svg', 'agents/space-heptagon.svg', 'agents/space-octagon.svg', 'agents/space-triangle.svg', 'agents/space-diamond.svg', 'agents/space-hexagon.svg', 'agents/space-star.svg', 'tabs/spider.svg', 'tabs/autohide.js', 'shared/feed.js', 'shared/look.js', 'look/layout-edits.json', 'look/patches.json', 'look/NOTICE',
    'mods/spider/data.js', 'mods/spider/main.js', 'mods/spider/mod.json',
    'themes/dracula-plus-glass.json', 'themes/spider-glass.json', 'keys.json',
    'fonts/GlassLabel-Bold.ttf', 'fonts/GoogleSansFlex.ttf', 'fonts/GoogleSansFlex-OFL.txt', 'fonts/GoogleSansFlex-TRADEMARKS.md',
    'shell/resume.sh', 'templates/role.md', 'templates/role-instructions.md',
  ];
  const assetRoot = 'packages/herdr/assets';
  const required = ['packages/herdr/LICENSE', 'licenses/herdr-apache-2.0.txt', 'LICENSE', 'NOTICE.md', ...entries.map(name => `dist/herdr/${name}`), ...assets.map(name => `${assetRoot}/${name}`)];
  for (const path of required) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Herdr asset missing or invalid: ${path}`);
  }
  const walk = directory => readdirSync(directory).flatMap(name => {
    const path = `${directory}/${name}`;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`Herdr symbolic asset: ${path}`);
    return info.isDirectory() ? walk(path) : [path];
  });
  const shippedAssets = walk(assetRoot).filter(path => !path.endsWith('.d.ts') && !path.endsWith('/config.example.json'));
  if (shippedAssets.some(path => !assets.includes(path.slice(assetRoot.length + 1)))) throw new Error('Herdr unexpected asset or frozen built-in mod');
  for (const path of assets.filter(path => path.endsWith('.json'))) JSON.parse(readFileSync(`${assetRoot}/${path}`, 'utf8'));
  if (!readFileSync(`${assetRoot}/fonts/GoogleSansFlex-OFL.txt`, 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1') || !readFileSync('NOTICE.md', 'utf8').includes('Google Sans Flex')) throw new Error('Herdr font notices missing');
  if (createHash('sha256').update(readFileSync('licenses/herdr-apache-2.0.txt')).digest('hex') !== 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' || !readFileSync(`${assetRoot}/look/NOTICE`, 'utf8').includes('modified portions of Herdr')) throw new Error('Herdr Apache licence or modification notice missing');
  const nodeGlobals = new Set(['process', 'Buffer', 'require', '__dirname', '__filename', 'global', 'module', 'exports']);
  const appImports = new Set(['gpui-kit', 'gpui-base', 'herdr']);
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  function checkJavaScript(code, file, mod) {
    const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (tree.parseDiagnostics.length) throw new Error(`invalid Herdr JavaScript syntax in ${file}`);
    const checkImport = specifier => {
      if (!ts.isStringLiteralLike(specifier)) throw new Error(`${mod ? 'Node API' : 'non-builtin'} dynamic import in ${file}`);
      const id = specifier.text;
      if (mod ? !(appImports.has(id) || id.startsWith('./') || id.startsWith('../')) : !builtins.has(id)) throw new Error(`${mod ? 'Node API' : 'non-builtin'} import ${id} in ${file}`);
    };
    const visit = node => {
      if (mod && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis') {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
        if (name && nodeGlobals.has(name)) throw new Error(`Node API globalThis.${name} in ${file}`);
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) checkImport(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments.length !== 1) throw new Error(`non-builtin import in ${file}`);
        checkImport(node.arguments[0]);
      }
      if (mod && ts.isIdentifier(node) && nodeGlobals.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) throw new Error(`Node API ${node.text} in ${file}`);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const file of assets.filter(file => file.endsWith('.js'))) checkJavaScript(readFileSync(`${assetRoot}/${file}`, 'utf8'), file, true);
  if (src.includes('A runtime request file is required') || !src.includes('SPIDER_HERDR_RUNTIME_ENTRY=false') || src.includes('import.meta.spiderHerdrRuntimeEntry')) throw new Error('Herdr extension runtime-main boundary invalid');
  if (src.includes('A subagent supervisor request file is required.')) throw new Error('Subagent supervisor leaked into the extension entry');
  for (const entry of entries) {
    const code = readFileSync(`dist/herdr/${entry}`, 'utf8');
    if (ts.createSourceFile(entry, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length) throw new Error(`invalid Herdr JavaScript syntax in ${entry}`);
    if (mustBeExternal.some(id => code.includes(`node_modules/${id}/`))) throw new Error(`Herdr peer/native inlined in ${entry}`);
    const supervisorEntry = entry === 'subagent-supervisor.mjs';
    if (code.includes('A subagent supervisor request file is required.') !== supervisorEntry) throw new Error(`Subagent supervisor boundary invalid in ${entry}`);
    if (supervisorEntry) {
      if (code.includes('A runtime request file is required')) throw new Error('Remote runtime leaked into the subagent supervisor');
      continue;
    }
    const remoteEntry = entry === 'remote-runtime.mjs';
    if (remoteEntry || entry === 'feed-reader.mjs') checkJavaScript(code, entry, false);
    if (entry === 'feed-reader.mjs' && /SPIDER_GLOBAL_ROOT|better-sqlite3|sqlite-vec/.test(code)) throw new Error('Herdr feed reader imports global or database state');
    if (code.includes('A runtime request file is required') !== remoteEntry || !code.includes(`SPIDER_HERDR_RUNTIME_ENTRY=${remoteEntry}`) || code.includes('import.meta.spiderHerdrRuntimeEntry')) throw new Error(`Herdr runtime-main boundary invalid in ${entry}`);
  }
  if (extracted) {
    const files = walk('.').map(path => path.replace(/^\.\//, ''));
    const invalid = files.filter(path => path.startsWith('packages/herdr/') && (path.includes('/src/') || path.endsWith('.d.ts') || path.includes('recordings') || path.endsWith('config.example.json')));
    if (invalid.length) throw new Error(`Herdr development files in tarball: ${invalid.join(', ')}`);
    const skills = files.filter(path => /^packages\/(?:superpowers|pstack)\/skills\/.*\/SKILL\.md$/.test(path));
    for (const directory of ['superpowers', 'pstack']) if (!skills.some(path => path.startsWith(`packages/${directory}/`))) throw new Error(`missing ${directory} skills in tarball`);
    for (const file of ['README.md', 'scripts/postinstall.mjs', 'packages/context/LICENSE', 'packages/pstack/LICENSE']) if (!files.includes(file)) throw new Error(`missing package file: ${file}`);
  }
} catch (error) {
  console.error(`assert-bundle: ${error instanceof Error ? error.message : String(error)}`);
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
console.log(`assert-bundle: OK (single-file extension, dashboard, six explicit Herdr entries, valid mod assets and notices, self-contained remote runtime, build marker valid, natives/peers external, native import verified${extracted ? ', tarball verified' : ''})`);
