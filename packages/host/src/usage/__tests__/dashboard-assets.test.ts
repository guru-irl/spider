import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { PlainDocument, elements, settle } from "./fixtures/plain-dom.js";
const require = createRequire(import.meta.url);
const dirs: string[] = [];
const outputWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock("vite", async original => {
  const real = await original<typeof import("vite")>();
  return { ...real, build: vi.fn((options: import("vite").InlineConfig = {}) => real.build({ ...options,
    plugins: [...(options.plugins ?? []), { name: "fixture-write-observer", writeBundle() { outputWrites.count++; } }],
  })) };
});
afterEach(() => { outputWrites.count = 0; vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("browser assets stay inside one bundle", async () => {
  // A placeholder entry, host dependency or disk-emitted browser asset would break the packaged app.
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href).catch(() => undefined);
  expect(module, "in-memory asset builder exists").toBeDefined();
  const distFiles = () => existsSync(resolve("dist")) ? readdirSync(resolve("dist")).sort() : null;
  const before = distFiles();
  const asset = await module!.buildUsageDashboard();
  expect(distFiles()).toEqual(before);
  expect(outputWrites.count, "in-memory browser build never writes, including identical overwrites").toBe(0);
  expect(asset.html.indexOf('<div id="usage-app">')).toBeLessThan(asset.html.indexOf("<script>"));
  expect(asset.html).toContain("#282a36");
  expect(asset.modules.some((file: string) => file.endsWith("/web/app.ts"))).toBe(true);
  expect(asset.modules.some((file: string) => file.endsWith("/web/theme.css"))).toBe(true);
  expect(asset.html).toContain("<style>"); expect(asset.html).toContain("<script>");
  expect(asset.html).not.toMatch(/<script[^>]+src=|<link|unsafe-inline|node:|@earendil|better-sqlite3/);
  expect(asset.modules.every((file: string) => file.includes("/usage/web/"))).toBe(true);
  const js = /<script>([\s\S]*?)<\/script>/.exec(asset.html)![1]!;
  const browser = require("typescript").createSourceFile("browser.js", js, 99, true);
  expect(browser.parseDiagnostics).toEqual([]);
  const document = new PlainDocument(), mount = document.createElement("div"); mount.id = "usage-app"; document.body.append(mount);
  const requests: string[] = [];
  vi.useFakeTimers();
  try {
    runInNewContext(js, { document, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async (path: string) => { requests.push(path); return new Response(JSON.stringify({ error: { code: "ledger-changed" } }), { status: 409 }); } });
    await settle();
    expect(elements(document.body, "main")).toHaveLength(1);
    expect(elements(mount, "nav")).toHaveLength(1);
    expect(elements(mount, "h1")[0]?.textContent).toBe("Overview");
    expect(requests).toContain("/api/status");
    expect(requests.some(path => path.startsWith("/api/overview?"))).toBe(true);
    expect(mount.textContent).toContain("Usage changed. Refresh to start a new page.");
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  const scratch = resolve(".spider/scratch/usage-ui"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "browser-graph-")); dirs.push(root);
  for (const specifier of ["node:fs", "@earendil-works/pi-coding-agent", "better-sqlite3", "@spider/db-core"]) {
    const entry = join(root, "entry.ts"); writeFileSync(entry, `import * as forbidden from ${JSON.stringify(specifier)}; console.log(forbidden);`);
    await expect(module!.buildUsageDashboard({ entry })).rejects.toThrow(/usage-browser-import-forbidden/);
  }
});

it("browser watch refreshes embedded assets", async () => {
  // Reusing cached virtual HTML or forgetting browser/CSS watch dependencies would ship old assets after a watch rebuild.
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href);
  const { build } = await import("vite");
  const scratch = resolve(".spider/scratch/usage-ui"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "browser-watch-")); dirs.push(root);
  const entry = join(root, "entry.ts"), css = join(root, "theme.css"), host = join(root, "host.ts"), outDir = join(root, "dist");
  writeFileSync(entry, 'import "./theme.css"; document.body.textContent = "Watch one";');
  writeFileSync(css, "body{color:rgb(1,2,3)}");
  writeFileSync(host, 'export { DASHBOARD_HTML } from "virtual:spider-usage-dashboard";');
  const watcher = await build({ configFile: false, logLevel: "silent", plugins: [module.usageDashboardAssetsPlugin({ entry })],
    build: { watch: {}, ssr: host, outDir, minify: false, rollupOptions: { output: { entryFileNames: "fixture.mjs" } } } }) as import("vite").Rolldown.RolldownWatcher;
  const errors: unknown[] = []; let builds = 0;
  watcher.on("event", event => { if (event.code === "END") builds++; if (event.code === "ERROR") errors.push(event.error); });
  const wait = async (n: number, expected: string) => {
    const output = join(outDir, "fixture.mjs");
    const ready = () => builds >= n && existsSync(output) && readFileSync(output, "utf8").includes(expected);
    const end = Date.now() + 8000;
    while (!ready() && Date.now() < end && !errors.length) await new Promise(resolve => setTimeout(resolve, 25));
    expect(errors).toEqual([]); expect(builds).toBeGreaterThanOrEqual(n); expect(ready()).toBe(true);
  };
  try {
    await wait(1, "Watch one");
    expect(readFileSync(join(outDir, "fixture.mjs"), "utf8")).toContain("Watch one");
    writeFileSync(entry, 'import "./theme.css"; document.body.textContent = "Watch two";');
    await wait(2, "Watch two");
    expect(readFileSync(join(outDir, "fixture.mjs"), "utf8")).toContain("Watch two");
    const count = builds; writeFileSync(css, "body{color:rgb(4,5,6)}"); await wait(count + 1, "#040506");
    expect(readFileSync(join(outDir, "fixture.mjs"), "utf8")).toContain("#040506");
    expect(readdirSync(outDir)).toEqual(["fixture.mjs"]);
  } finally { await watcher.close(); }
});

it("asset boundary escapes raw compiler end tags case-insensitively and hashes the complete executable text", async () => {
  // A compiler/plugin can emit raw end tags even if its default minifier escapes string literals.
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href);
  const { build } = await import("vite");
  const script = 'globalThis.values = ["</script>", "</ScRiPt ", "</SCRIPT/", "</style>", "</STYLE "];';
  const css = 'p::after{content:"</StYlE >"}';
  vi.mocked(build).mockResolvedValueOnce({ output: [
    { type: "chunk", fileName: "usage.js", code: script, modules: {} },
    { type: "asset", fileName: "usage.css", source: css },
  ] } as never);
  const { html } = await module.buildUsageDashboard();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script(?=[\s/>])/gi)];
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style(?=[\s/>])/gi)];
  expect(scripts).toHaveLength(1); expect(styles).toHaveLength(1);
  expect(scripts[0][1]).not.toMatch(/<\/script/gi); expect(styles[0][1]).not.toMatch(/<\/style/gi);
  expect(styles[0][1]).toBe('p::after{content:"<\\/StYlE >"}');
  const context: { values?: string[] } = {}; runInNewContext(scripts[0][1], context);
  expect(Array.from(context.values!)).toEqual(["</script>", "</ScRiPt ", "</SCRIPT/", "</style>", "</STYLE "]);
  const { usageSecurityHeaders } = await import("../server-security.js");
  const csp = usageSecurityHeaders(html)["Content-Security-Policy"];
  for (const raw of [scripts[0][1], styles[0][1]]) expect(csp).toContain(`sha256-${createHash("sha256").update(raw).digest("base64")}`);
});

it("asset boundary rejects extra output files", async () => {
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href);
  const { build } = await import("vite");
  vi.mocked(build).mockResolvedValueOnce({ output: [
    { type: "chunk", fileName: "usage.js", code: "", modules: {} },
    { type: "asset", fileName: "extra.bin", source: "fixture" },
  ] } as never);
  await expect(module.buildUsageDashboard()).rejects.toThrow("usage-browser-output-invalid");
});

it("browser graph rejects runtime relative imports outside web but allows erased type imports", async () => {
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href);
  const scratch = resolve(".spider/scratch/usage-ui"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "browser-relative-")); dirs.push(root);
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "outside.ts"), 'export const value = "outside"; export type Value = string;');
  const entry = join(root, "web", "entry.ts");
  writeFileSync(entry, 'import { value } from "../outside.ts"; console.log(value);');
  await expect(module.buildUsageDashboard({ entry })).rejects.toThrow("usage-browser-import-forbidden");
  writeFileSync(entry, 'import type { Value } from "../outside.ts"; const value: Value = "type-only"; console.log(value);');
  expect((await module.buildUsageDashboard({ entry })).html).toContain("type-only");
  // The resolved path is within web. Only the bare-specifier guard rejects this dependency.
  const localPackage = join(root, "web", "node_modules", "local-browser-fixture"); mkdirSync(localPackage, { recursive: true });
  writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "local-browser-fixture", type: "module", exports: "./index.js" }));
  writeFileSync(join(localPackage, "index.js"), 'export const value = "bare-inside-root";');
  writeFileSync(entry, 'import { value } from "local-browser-fixture"; console.log(value);');
  await expect(module.buildUsageDashboard({ entry })).rejects.toThrow("usage-browser-import-forbidden");
});

it("embedded shell has one usage-app div and no main landmark", async () => {
  // Task 5b renders the page's only main inside this mount root.
  const module = await import(/* @vite-ignore */ new URL("../../../../../scripts/usage-dashboard-assets.mjs", import.meta.url).href);
  const { html } = await module.buildUsageDashboard();
  const shell = html.replace(/<script>[\s\S]*?<\/script>/gi, "");
  expect(shell.match(/\bid="usage-app"/g)).toHaveLength(1);
  expect(shell).toContain('<div id="usage-app"></div>');
  expect(shell).not.toMatch(/<\/?main\b/i);
});
