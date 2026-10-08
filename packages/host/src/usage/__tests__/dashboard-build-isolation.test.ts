import { prepareDashboardBuild } from "./fixtures/dashboard-build.js";
import { afterEach, expect, it, vi } from "vitest";
import { build, createServer, resolveConfig } from "vite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const roots: string[] = [];
function scratch() { const base = resolve(".spider/scratch/usage-dashboard-assets/builds"); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, "fixture-")); roots.push(root); return root; }
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("two independent builds preserve each other", async () => {
  const root = scratch(), outDir = join(root, "dist"), dashboard = join(outDir, "dashboard");
  const extension = () => build({ configFile: resolve("vite.config.mjs"), logLevel: "silent", build: { outDir } });
  const browserConfig = prepareDashboardBuild(root);
  const browser = () => build({ configFile: browserConfig, logLevel: "silent" });
  await browser(); const names = readdirSync(join(dashboard, "assets")).sort(); const bytes = names.map(n => readFileSync(join(dashboard, "assets", n)));
  await extension(); expect(readdirSync(outDir).sort()).toEqual(["dashboard", "extension.js"]);
  expect(names.map(n => readFileSync(join(dashboard, "assets", n)))).toEqual(bytes);
  const host = readFileSync(join(outDir, "extension.js")); expect(host.toString()).not.toContain("virtual:spider-usage-dashboard");
  writeFileSync(join(dashboard, "assets/stale-12345678.js"), "stale"); await browser();
  expect(readFileSync(join(outDir, "extension.js"))).toEqual(host);
  expect(readdirSync(dashboard).sort()).toEqual(["assets", "index.html"]); expect(readdirSync(join(dashboard, "assets")).sort()).toEqual(names);
  expect(names.every(n => /^[\w-]+-[\w-]{8,}\.(js|css)$/.test(n))).toBe(true);
  expect(bytes.reduce((n, b) => n + b.length, readFileSync(join(dashboard, "index.html")).length)).toBeLessThanOrEqual(512 * 1024);
  const copy = join(root, "synthetic-checkout"); mkdirSync(join(copy, "scripts"), { recursive: true }); mkdirSync(join(copy, "packages/host/src"), { recursive: true });
  cpSync(resolve("vite.config.mjs"), join(copy, "vite.config.mjs")); cpSync(resolve("scripts/build-id.mjs"), join(copy, "scripts/build-id.mjs"));
  writeFileSync(join(copy, "package.json"), '{"type":"module","version":"0.0.0"}');
  const source = join(copy, "packages/host/src/extension.ts"); writeFileSync(source, 'export default function fixture() { return "first"; }');
  const watcher = await build({ configFile: join(copy, "vite.config.mjs"), root: copy, logLevel: "silent", build: { outDir, watch: {} } }) as import("vite").Rolldown.RolldownWatcher;
  const next = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.off("event", onEvent); reject(new Error("fixture-watch-deadline")); }, 60_000);
    const onEvent = (event: { code: string; error?: unknown }) => {
      if (event.code === "END" || event.code === "ERROR") { clearTimeout(timer); watcher.off("event", onEvent); if (event.code === "ERROR") reject(event.error); else resolve(); }
    }; watcher.on("event", onEvent);
  });
  try {
    await next(); expect(readFileSync(join(outDir, "extension.js"), "utf8")).toContain("first");
    expect(names.map(n => readFileSync(join(dashboard, "assets", n)))).toEqual(bytes);
    const rebuilt = next(); writeFileSync(source, 'export default function fixture() { return "second"; }'); await rebuilt;
    expect(readFileSync(join(outDir, "extension.js"), "utf8")).toContain("second");
    expect(names.map(n => readFileSync(join(dashboard, "assets", n)))).toEqual(bytes);
  } finally { await watcher.close(); }
  const guard = () => execFileSync(process.execPath, [resolve("scripts/assert-bundle.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
  expect(guard()).toContain("assert-bundle: OK");
  for (const file of ["dist/extra.js", "dist/dashboard/states.html", "dist/dashboard/assets/app-12345678.js.map", "dist/dashboard/assets/extra.bin"]) {
    writeFileSync(join(root, file), "synthetic"); expect(guard).toThrow(); rmSync(join(root, file));
  }
  const index = readFileSync(join(dashboard, "index.html")); rmSync(join(dashboard, "index.html")); expect(guard).toThrow(); writeFileSync(join(dashboard, "index.html"), index);
  const cssFile = names.find(n => n.endsWith(".css"))!, jsFile = names.find(n => n.endsWith(".js"))!;
  for (const html of [`<link href="/assets/${cssFile}"><script src="/assets/${jsFile}">alert(1)</script>`, `<link href=/assets/${cssFile}><script src=/assets/${jsFile}></script>`]) {
    writeFileSync(join(dashboard, "index.html"), html); expect(guard).toThrow();
  }
  writeFileSync(join(dashboard, "index.html"), index);
  const js = names.find(n => n.endsWith(".js"))!, saved = readFileSync(join(dashboard, "assets", js));
  writeFileSync(join(dashboard, "assets", js), "x".repeat(512 * 1024)); expect(guard).toThrow(); writeFileSync(join(dashboard, "assets", js), saved);
}, 180_000);
it("dev and e2e states never ship and e2e output must be owned scratch", async () => {
  const config = (mode: string, outDir?: string) => resolveConfig({ configFile: resolve("vite.dashboard.config.mjs"), mode, ...(outDir ? { build: { outDir } } : {}) }, "build");
  const prod = await config("production"); expect(Object.keys(prod.build.rollupOptions.input as object)).toEqual(["index"]);
  expect(prod.build.modulePreload).toEqual({ polyfill: false }); expect(prod.build.assetsInlineLimit).toBe(0);
  const dev = await config("development", join(scratch(), "output")); expect(Object.keys(dev.build.rollupOptions.input as object).sort()).toEqual(["index", "states"]);
  await expect(config("e2e")).rejects.toThrow(/scratch/);
  const e2e = await config("e2e", join(scratch(), "output")); expect(Object.keys(e2e.build.rollupOptions.input as object).sort()).toEqual(["index", "states"]);
});
it("production refuses redirected dashboard output", async () => {
  const config = (mode: string, outDir: string) => resolveConfig({ configFile: resolve("vite.dashboard.config.mjs"), mode, build: { outDir } }, "build");
  for (const output of [resolve("dist"), join(scratch(), "output"), resolve("dist/dashboard/nested")]) {
    await expect(config("production", output)).rejects.toThrow(/production.*dist\/dashboard/);
  }
});
it("development and e2e refuse production dashboard output", async () => {
  const config = (mode: string, outDir: string) => resolveConfig({ configFile: resolve("vite.dashboard.config.mjs"), mode, build: { outDir } }, "build");
  for (const mode of ["development", "e2e"]) {
    for (const output of [resolve("dist/dashboard"), resolve(".spider/scratch"), resolve("dist")]) {
      await expect(config(mode, output)).rejects.toThrow(/scratch/);
    }
    await expect(config(mode, join(scratch(), "output"))).resolves.toBeDefined();
  }
});
it("states catalogue renders page-specific component examples and terminal errors without a second auto-start", async () => {
  const { PlainDocument, elements } = await import("./fixtures/plain-dom.js");
  const { fixtureStateCases } = await import("./fixtures/redesign-contract.js");
  const doc = new PlainDocument(), root = doc.createElement("div"); root.id = "states-root"; doc.body.append(root);
  vi.stubGlobal("document", doc.asDocument()); vi.stubGlobal("fetch", () => new Promise(() => {}));
  const states = await import("../web/states.js");
  states.renderFixtureStates(doc.asDocument(), root as unknown as HTMLElement, fixtureStateCases());
  expect(elements(root, "h2").length).toBe(fixtureStateCases().length);
  expect(root.textContent).toContain("Session not found");
  expect(elements(root, "svg").length).toBeGreaterThan(0);
  expect(elements(root, "table").length).toBeGreaterThan(0);
  expect(elements(root, "main")).toHaveLength(0);
});
it("dev serves fresh fixture envelopes and a JSON state catalogue without browser fixture imports", async () => {
  const server = await createServer({ configFile: resolve("vite.dashboard.config.mjs"), mode: "development", logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  try {
    await server.listen(); const address = server.httpServer!.address() as import("node:net").AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of ["/api/status", "/api/overview", "/api/sessions", "/api/session/synthetic", "/api/calibration"]) {
      const first = await (await fetch(origin + path)).json() as { data: unknown; apiVersion: number };
      expect(first.apiVersion).toBe(1); expect(first.data).toBeDefined();
      first.data = null; expect((await (await fetch(origin + path)).json() as { data: unknown }).data).not.toBeNull();
    }
    const catalogue = await (await fetch(origin + "/api/fixture-states")).json() as { page: string; responses: object }[];
    expect(new Set(catalogue.map(c => c.page))).toEqual(new Set(["overview", "session", "calibration"]));
    expect(catalogue.every(c => Object.keys(c.responses).length > 0)).toBe(true);
    expect(await (await fetch(origin + "/states.html")).text()).toContain("states-root");
    for (const path of ["/@vite/client", "/@vite/env", "/theme.css"]) expect((await fetch(origin + path)).status, path).toBe(200);
    const privateFile = join(scratch(), "synthetic-private.db"); writeFileSync(privateFile, "fixture-only");
    for (const path of [resolve("package.json"), privateFile]) {
      const response = await fetch(origin + "/@fs/" + path);
      expect(response.status, path).toBe(403);
    }
    const entry = await fetch(origin + "/app.ts"); expect(entry.status).toBe(200);
    expect(await entry.text()).not.toMatch(/fixtures\/redesign-contract/);
  } finally { await server.close(); }
});
it("browser boundary rejects outside runtime, bare imports and symlink escapes but permits types and HTML/CSS", async () => {
  const { usageBrowserBoundary } = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-browser-boundary.mjs", import.meta.url).href);
  const root = scratch(), web = join(root, "web"); mkdirSync(web);
  writeFileSync(join(root, "outside.ts"), 'export const value = "outside"; export type Value = string;');
  writeFileSync(join(web, "index.html"), '<script type="module" src="/app.ts"></script>'); writeFileSync(join(web, "style.css"), 'body{color:white}');
  const run = () => build({ configFile: false, root: web, logLevel: "silent", plugins: [usageBrowserBoundary(web)], build: { outDir: join(root, "output") } });
  for (const imp of ['import {value} from "../outside.ts";', 'import * as value from "node:fs";']) {
    writeFileSync(join(web, "app.ts"), imp + 'console.log(value);'); await expect(run()).rejects.toThrow(/usage-browser-import-forbidden/);
  }
  symlinkSync(join(root, "outside.ts"), join(web, "escape.ts")); writeFileSync(join(web, "app.ts"), 'import {value} from "./escape.ts"; console.log(value);'); await expect(run()).rejects.toThrow(/usage-browser-import-forbidden/);
  writeFileSync(join(web, "app.ts"), 'import type {Value} from "../outside.ts"; import "./style.css"; const value: Value = "type-only"; console.log(value);');
  await run(); expect(readFileSync(join(root, "output/index.html"), "utf8")).toMatch(/\/assets\/.*\.js/);
});
