import { afterEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { runInNewContext, constants as vmConstants } from "node:vm";
import { isNativeError } from "node:util/types";
import ts from "typescript";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { extensionShim } = require("../../../../scripts/extension-shim.mjs");

function fixture(options: { dev?: boolean; missing?: boolean; compileThrows?: boolean; compileError?: Error; importThrows?: boolean; importRejects?: boolean; factoryThrows?: boolean; warnings?: unknown[][]; nativeError?: unknown; nativeImport?: (url: string) => Promise<unknown>; bundle?: string } = {}) {
  const forwarded: { receiver: unknown; args: unknown[] }[] = [];
  const original = function(this: unknown, ...args: unknown[]) { forwarded.push({ receiver: this, args }); };
  const process = { emitWarning: original };
  let wrapped = false;
  let deferredRestored = false;
  const namespace = { default: () => { if (options.factoryThrows) throw new Error("factory failed"); return "native"; } };
  const warn = () => {
    wrapped = process.emitWarning !== original;
    for (const args of options.warnings ?? []) process.emitWarning.apply(process, args);
  };
  const source = ts.transpile(extensionShim(options.bundle ?? "data:text/javascript,export default () => 'fallback'", options.dev), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
    .replace(/^import .*;$/gm, "")
    .replace("export default async function spider", "async function spider");
  const context = {
    process, URL, isNativeError, pathToFileURL: (path: string) => new URL(path),
    statSync: () => ({ mtimeNs: 1n, size: 2n }),
    constants: options.missing ? undefined : { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("loader") },
    runInThisContext: () => {
      warn();
      if (options.compileThrows) throw options.compileError ?? new Error("compile failed");
      return (url: string) => {
        warn();
        if (options.importThrows) throw options.nativeError ?? Object.assign(new Error("import failed"), { code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING" });
        if (options.nativeImport) return options.nativeImport(url);
        return Promise.resolve().then(() => {
          deferredRestored = process.emitWarning === original;
          if (options.importRejects) throw options.nativeError ?? Object.assign(new Error("import rejected"), { code: "ERR_MODULE_NOT_FOUND" });
          return namespace;
        });
      };
    },
  };
  runInNewContext(source + "\nglobalThis.load = spider;", context, { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { context: context as typeof context & { load: () => Promise<string> }, original, forwarded, isWrapped: () => wrapped, isDeferredRestored: () => deferredRestored, source };
}

it("drops only matching ExperimentalWarnings and forwards all other arguments and receivers", async () => {
  const error = Object.assign(new Error("vm dynamic import loader is experimental"), { name: "ExperimentalWarning" });
  const forwarded = [
    ["other experimental feature", "ExperimentalWarning", "OTHER"],
    ["USE_MAIN_CONTEXT_DEFAULT_LOADER", "Warning", "CODE", () => {}],
    ["ordinary warning", { type: "CustomWarning", code: "KEEP" }],
    [new Error("USE_MAIN_CONTEXT_DEFAULT_LOADER")],
    ["ordinary warning"],
    ["USE_MAIN_CONTEXT_DEFAULT_LOADER", { code: "KEEP" }],
  ];
  const f = fixture({ warnings: [
    ["vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is experimental", "ExperimentalWarning"],
    ["vm dynamic import loader is experimental", { type: "ExperimentalWarning" }],
    [error],
    ...forwarded,
  ] });
  expect(await f.context.load()).toBe("native");
  expect(f.forwarded.map(entry => entry.args)).toEqual([...forwarded, ...forwarded]);
  expect(f.forwarded.every(entry => entry.receiver === f.context.process)).toBe(true);
  expect(f.isWrapped()).toBe(true);
  expect(f.context.process.emitWarning).toBe(f.original);
  expect(f.isDeferredRestored()).toBe(true);
});

it("renders a guarded constant and plain bundle-path fallback", () => {
  const f = fixture();
  expect(f.source).toContain("constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER");
  expect(f.source).toMatch(/import\(.*bundle.*\)/);
});

it.each([
  ["missing constant", { missing: true }],
  ["compile throws", { compileThrows: true }],
  ["native call throws", { importThrows: true }],
  ["native promise rejects", { importRejects: true }],
] as const)("loads the plain import fallback when %s", async (_name, options) => {
  const f = fixture(options);
  expect(await f.context.load()).toBe("fallback");
  expect(f.context.process.emitWarning).toBe(f.original);
});

it("does not retry an extension factory failure via the fallback", async () => {
  const f = fixture({ factoryThrows: true });
  await expect(f.context.load()).rejects.toThrow("factory failed");
  expect(f.context.process.emitWarning).toBe(f.original);
});

it.each([false, true])("escapes a quoted path with U+2028 in the generated shim (dev=%s)", async dev => {
  const path = 'file:///fixture/a"b\u2028c.mjs';
  let observed = "";
  // The real generated code is parsed and executed, rather than testing a source substring.
  const f = fixture({ dev, bundle: path, nativeImport: async url => { observed = new URL(url).pathname; return { default: () => "ok" }; } });
  expect(ts.transpileModule(extensionShim(path, dev), { reportDiagnostics: true }).diagnostics).toEqual([]);
  expect(await f.context.load()).toBe("ok");
  expect(decodeURIComponent(observed)).toBe('/fixture/a"b\u2028c.mjs');
});

const loaderCodes = [
  "ERR_MODULE_NOT_FOUND", "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
  "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG", "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_UNKNOWN_FILE_EXTENSION", "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED", "ERR_UNSUPPORTED_DIR_IMPORT",
];
it.each(loaderCodes)("falls back only for the loader/resolution code %s", async code => {
  const f = fixture({ importRejects: true, nativeError: Object.assign(new Error("loader failed"), { code }) });
  expect(await f.context.load()).toBe("fallback");
});
it.each(["synchronous", "rejected"])("rethrows the original %s non-loader error without fallback", async mode => {
  const original = Object.assign(new Error("bundle initialization failed"), { code: "EACCES" });
  const f = fixture({ importThrows: mode === "synchronous", importRejects: mode === "rejected", nativeError: original });
  await expect(f.context.load()).rejects.toBe(original);
  expect(f.context.process.emitWarning).toBe(f.original);
});
it("does not retry errors without a code or primitive throws", async () => {
  for (const original of [new SyntaxError("bad bundle"), "bundle threw a string"]) {
    const f = fixture({ importRejects: true, nativeError: original });
    await expect(f.context.load()).rejects.toBe(original);
  }
});
it("names both the native loader and fallback failures in the visible message and retains both errors", async () => {
  const original = Object.assign(new Error("native resolution failed"), { code: "ERR_MODULE_NOT_FOUND" });
  const f = fixture({ importRejects: true, nativeError: original,
    bundle: "data:text/javascript,throw new Error('fallback failed');" });
  const error = await f.context.load().catch(error => error);
  expect(error.message).toBe("native resolution failed (fallback import also failed: fallback failed)");
  expect(error.errors[0]).toBe(original);
  expect(error.errors[1]).toMatchObject({ message: "fallback failed" });
});

it("names both compilation and fallback failures when native loading is unsupported", async () => {
  const original = new Error("compile unsupported");
  const f = fixture({ compileThrows: true, compileError: original,
    bundle: "data:text/javascript,throw new Error('compile fallback failed');" });
  const error = await f.context.load().catch(error => error);
  expect(error.message).toBe("compile unsupported (fallback import also failed: compile fallback failed)");
  expect(error.errors[0]).toBe(original);
  expect(error.errors[1]).toMatchObject({ message: "compile fallback failed" });
});

const globals = globalThis as typeof globalThis & { __shimThrowCount?: number; __shimOriginalError?: Error };
afterEach(() => { delete globals.__shimThrowCount; delete globals.__shimOriginalError; });
it("runs a throwing bundle's real top-level code exactly once and keeps its original error", async () => {
  const base = resolve(".spider/scratch/build-id");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "throwing-bundle-"));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, `
    globalThis.__shimThrowCount = (globalThis.__shimThrowCount || 0) + 1;
    throw (globalThis.__shimOriginalError = new Error('top-level failure'));
    export default () => 'must not run';
  `);
  try {
    const f = fixture({ bundle: pathToFileURL(file).href, nativeImport: url => import(/* @vite-ignore */ url) });
    let thrown: unknown;
    try { await f.context.load(); } catch (error) { thrown = error; }
    expect(globals.__shimThrowCount).toBe(1);
    expect(thrown).toBe(globals.__shimOriginalError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
