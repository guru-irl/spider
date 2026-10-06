import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { bootUsageServer } from "../server-entry.js";
import { writeServerRecord } from "../server-lock.js";
import * as dashboardReader from "../dashboard-reader.js";
import { createDashboardFixture } from "./fixtures/dashboard-ledger.js";
import * as httpServer from "../server.js";
import { execFile, execFileSync } from "node:child_process";
import { readUsageServerCrashCodes } from "../server-runtime.js";
import * as serverRuntime from "../server-runtime.js";
vi.mock("../../build-id.js", () => ({ LOADED_BUILD: { sha: "def5678", builtAt: "2026-10-05T04:05:06.000Z", version: "fixture-bundle", dirty: false } }));
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import Database from "better-sqlite3";
import { request } from "node:http";

function localUsageRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, agent: false, timeout: 1000 }, res => {
      let body = "";
      res.on("data", bytes => { body += bytes; if (Buffer.byteLength(body) > 1024 * 1024) req.destroy(new Error("fixture-response-limit")); });
      res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("fixture-request-timeout"))); req.end();
  });
}
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { extensionShim } = require("../../../../../scripts/extension-shim.mjs");
const pids = new Set<number>(), roots: string[] = [];
let built: string, buildRoot: string;
function fixture() {
  const root = mkdtempSync(join(buildRoot, "packaged-usage-")); roots.push(root);
  mkdirSync(join(root, "packaged", "dist"), { recursive: true });
  const bundle = join(root, "packaged", "dist", "extension.js"); cpSync(built, bundle);
  mkdirSync(join(root, "agent", "sessions", "synthetic"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"usage.calibration":"off","usage.counter.poll":true}');
  // Auth is deliberately unusable. Dashboard ingestion must neither read it nor poll.
  mkdirSync(join(root, "agent", "auth.json"));
  writeFileSync(join(root, "agent", "sessions", "synthetic", "session.jsonl"), [
    JSON.stringify({ type: "session", id: "synthetic", timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "synthetic-call", timestamp: new Date().toISOString(), message: {
      role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 30 } } }),
  ].join("\n") + "\n");
  const registry = new Database(join(root, "spider.db")); registry.exec("CREATE TABLE projects(project_key TEXT, db_path TEXT)"); registry.close();
  const shim = join(root, "shim.mjs"); writeFileSync(shim, ts.transpile(extensionShim(bundle), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }));
  const launcher = join(root, "launcher.mjs");
  writeFileSync(launcher, `
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import { registerHooks } from 'node:module';
    import { relative, isAbsolute } from 'node:path';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('file:')) {
        const path = relative(${JSON.stringify(buildRoot)}, fileURLToPath(result.url));
        if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('fixture-ancestor-import-forbidden');
      }
      return result;
    } });
    const [mode, bundle, shim] = process.argv.slice(2);
    const commands = new Map(); const events = new Map(); let opened = [];
    const pi = { registerTool() {}, registerCommand(name, def) { commands.set(name, def); },
      on(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); return () => {}; },
      async exec(command, args) { opened.push(args[0]); return { code: 0, stdout: '', stderr: '', killed: false }; } };
    const ctx = { cwd: process.cwd(), hasUI: true, mode: 'tui', ui: { notify() {}, setWidget() {} } };
    if (mode === 'shim') await (await import(pathToFileURL(shim).href)).default(pi);
    else (await import(pathToFileURL(bundle).href)).default(pi);
    if (opened.length) throw new Error('fixture-import-launched-browser');
    if (!commands.has('usage')) throw new Error('fixture-usage-command-missing');
    await commands.get('usage').handler('', ctx);
    if (opened.length !== 1) throw new Error('fixture-usage-command-failed');
    process.stdout.write(JSON.stringify({ url: opened[0] }));
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: join(root, "agent"),
    SPIDER_TEST_FIXTURE_CHECKOUT: resolve("."), NODE_PATH: "" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR") delete env[key];
  return { root, bundle, shim, launcher, env, lockFile: join(root, "usage-server", "lock.json") };
}
async function until<T>(read: () => Promise<T | undefined>, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("fixture-dashboard-deadline");
}
beforeAll(async () => {
  const scratch = resolve(".spider/scratch/usage-ui"); mkdirSync(scratch, { recursive: true });
  buildRoot = mkdtempSync(join(scratch, "dashboard-bundle-build-"));
  built = process.env.SPIDER_USAGE_TEST_BUNDLE ?? join(buildRoot, "dist", "extension.js");
  // A resolver fence below prevents ancestor node_modules or workspace links from rescuing the artifact.
  const modules = join(buildRoot, "node_modules");
  const pending = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox", "better-sqlite3", "sqlite-vec", "turndown"];
  const copied = new Set<string>();
  for (const name of pending) {
    if (copied.has(name)) continue;
    const source = resolve("node_modules", name), target = join(modules, name);
    if (!existsSync(source)) continue; // Optional platform dependency.
    copied.add(name); mkdirSync(dirname(target), { recursive: true });
    if (process.platform === "darwin") execFileSync("cp", ["-cR", source, target]);
    else cpSync(source, target, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    pending.push(...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }));
  }
  const installed = readdirSync(resolve("node_modules"), { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".")) return [];
    return entry.name.startsWith("@") ? readdirSync(resolve("node_modules", entry.name)).map(name => `${entry.name}/${name}`) : [entry.name];
  });
  // The standalone server strips loader env flags. Local poison packages prevent
  // its workers as well as the launcher from falling back to checkout dev deps.
  const forbidden = new Set([...installed.filter(name => !copied.has(name)), ...readdirSync(resolve("packages")).map(name => `@spider/${name}`), "vite", "rolldown", "typescript"]);
  for (const name of forbidden) {
    const dir = join(modules, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
    writeFileSync(join(dir, "index.js"), 'throw new Error("fixture-workspace-import-forbidden");');
  }
  if (!process.env.SPIDER_USAGE_TEST_BUNDLE) await run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build", "--outDir", join(buildRoot, "dist")], { timeout: 60000, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 });
}, 90000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) {
    try { pids.add(JSON.parse(readFileSync(join(root, "usage-server", "lock.json"), "utf8")).pid); } catch { /* failed launch or already closed */ }
  }
  for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* own process already exited */ } }
  for (const pid of pids) await until(async () => { try { process.kill(pid, 0); return undefined; } catch { return true; } }, 3000);
  pids.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); }, 90000);

it("packaged slice works without source checkout", async () => {
  // Omitting embedded HTML, the participant, its getter, native bundle identity or bounded stop breaks real packaged behavior.
  const code = readFileSync(built, "utf8");
  const parsed = ts.createSourceFile("extension.js", code, ts.ScriptTarget.ESNext, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }; visit(parsed);
  expect(imports.some(id => id === "vite" || id === "rolldown" || id.startsWith("virtual:") || id.includes("/usage/web/") || id.startsWith("@spider/"))).toBe(false);
  expect(readdirSync(process.env.SPIDER_USAGE_TEST_BUNDLE ? resolve("dist") : join(buildRoot, "dist"))).toEqual(["extension.js"]);
  for (const mode of ["native", "shim"]) {
    const f = fixture();
    const launch = await run(process.execPath, [f.launcher, mode, f.bundle, f.shim], { cwd: f.root, env: f.env, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const lock = JSON.parse(readFileSync(f.lockFile, "utf8")); pids.add(lock.pid);
    if (mode === "native") {
      const second = await run(process.execPath, [f.launcher, mode, f.bundle, f.shim], { cwd: f.root, env: f.env, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      const reusedLock = JSON.parse(readFileSync(f.lockFile, "utf8"));
      expect(reusedLock.pid).toBe(lock.pid); expect(reusedLock.instanceId).toBe(lock.instanceId);
      expect(reusedLock.serverBuild).toBe(lock.serverBuild);
      expect(JSON.parse(second.stdout).url).not.toBe(JSON.parse(launch.stdout).url);
      // Observe the launcher's reuse result against the exact packaged build identity.
      const reused = await serverRuntime.ensureUsageServer({ bundleUrl: f.bundle, lockFile: f.lockFile,
        serverBuild: lock.serverBuild, calibrationMode: "off", roots: {
          ledgerFile: join(f.root, "usage.db"), registryDb: join(f.root, "spider.db"), leaseDir: join(f.root, "usage-leases"),
          sessionsDir: join(f.root, "agent", "sessions"), authPath: join(f.root, "agent", "auth.json"),
        } });
      pids.add(reused.pid);
      expect(reused.reused).toBe(true); expect(reused.pid).toBe(lock.pid);
      expect(pids.size, "equal-build launches retain one server").toBe(1);
      const servers = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
        .filter(line => line.includes(f.bundle) && line.includes("--spider-usage-server"));
      expect(servers).toHaveLength(1);
    }
    const bootstrapUrl = new URL(JSON.parse(launch.stdout).url);
    expect(bootstrapUrl.pathname).toBe("/bootstrap"); expect(bootstrapUrl.searchParams.size).toBe(1);
    expect(bootstrapUrl.search).not.toContain(lock.secret);
    const bootstrap = await localUsageRequest(lock.port, bootstrapUrl.pathname + bootstrapUrl.search);
    expect(bootstrap.status).toBe(303);
    const headers = { Cookie: bootstrap.headers["set-cookie"]![0]!.split(";")[0]! };
    const html = await localUsageRequest(lock.port, "/", headers);
    expect(html.status).toBe(200); expect(html.body, "packaged browser entry is present").toContain("<script>");
    expect(html.body).toContain("<style>");
    expect(html.body, "Task 5b theme is embedded").toContain("#282a36");
    expect(html.body, "Task 5b auto-start entry is embedded").toContain("DOMContentLoaded");
    expect(html.body).toContain("usage-shell");
    expect(Buffer.byteLength(html.body)).toBeLessThan(400 * 1024);
    expect(gzipSync(html.body).byteLength).toBeLessThan(Buffer.byteLength(html.body));
    const shell = html.body.replace(/<script>[\s\S]*?<\/script>/gi, "");
    expect(shell.match(/\bid="usage-app"/g) ?? []).toHaveLength(1);
    expect(shell).toContain('<div id="usage-app"></div>'); expect(shell).not.toMatch(/<\/?main\b/i);
    const scripts = [...html.body.matchAll(/<script>([\s\S]*?)<\/script>/g)], styles = [...html.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(scripts).toHaveLength(1); expect(styles).toHaveLength(1);
    const scriptHash = createHash("sha256").update(scripts[0]![1]!).digest("base64");
    const styleHash = createHash("sha256").update(styles[0]![1]!).digest("base64");
    // Hashes must cover exactly the served executable text. Only the optional Google Fonts origins are allowed.
    expect(html.headers["content-security-policy"]).toBe([
      "default-src 'none'", `script-src 'sha256-${scriptHash}'`, `style-src 'sha256-${styleHash}' https://fonts.googleapis.com`,
      "style-src-attr 'none'", "font-src https://fonts.gstatic.com", "connect-src 'self'", "img-src 'self'", "object-src 'none'",
      "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
    ].join("; "));
    // The SVG namespace identifies DOM nodes, not a network resource.
    const resourceHtml = html.body.replaceAll("http://www.w3.org/2000/svg", "");
    const externalUrls = [...new Set(resourceHtml.match(/https?:\/\/[^\s"'`<>\\)]+/g) ?? [])];
    expect(externalUrls).toEqual(["https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600&family=Cascadia+Code:wght@400;500&display=swap"]);
    expect(styles[0]![1]).not.toMatch(/url\(/i);
    const status = await until(async () => {
      const reply = await localUsageRequest(lock.port, "/api/status", headers); const dto = JSON.parse(reply.body).data;
      return reply.status === 200 && dto.calls === 1 && dto.ingest.role === "standby" ? dto : undefined;
    });
    expect(status.ingest.backfill).toBe("complete"); expect(status.counter.ts).toBeNull();
    expect(status.serverBuild).toBe(lock.serverBuild); expect(lock.serverBuild).toMatch(/^[^@]+@\d{4}-\d{2}-\d{2}T/);
    const manifest = require("../../../../../scripts/build-id.mjs").parseBuildId(code);
    expect(lock.serverBuild).toBe(`${manifest.sha}@${manifest.builtAt}`);
    expect(await readUsageServerCrashCodes(join(f.root, "usage-server"))).not.toContain("usage-server-build-invalid");
    // Match the rolling-month slice and empty filters sent by the real app.
    const now = Date.now(), date = new Date(now);
    const overviewParams = new URLSearchParams({ start: String(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)), end: String(now), filters: "[]" });
    const overviewReply = await localUsageRequest(lock.port, `/api/overview?${overviewParams}`, headers);
    expect({ status: overviewReply.status, length: overviewReply.body.length }).toMatchObject({ status: 200, length: expect.any(Number) });
    expect(overviewReply.body.length, JSON.stringify({ status: overviewReply.status, headers: overviewReply.headers })).toBeGreaterThan(0);
    const overview = JSON.parse(overviewReply.body).data;
    expect(overview.calibration.status).toBe("off"); expect(overview.totals.tokens.total).toBe(160);
    const db = new Database(join(f.root, "usage.db"), { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM counter_snapshots").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT owner FROM leases WHERE name = 'counter'").get()).not.toMatchObject({ owner: expect.any(String) });
    } finally { db.close(); }
    writeFileSync(join(f.root, "config.json"), '{"usage.calibration":"auto"}');
    const auto = JSON.parse((await localUsageRequest(lock.port, "/api/overview", headers)).body).data;
    expect(auto.calibration.status).toBe("uncalibrated"); expect(auto.totals.tokens.total).toBe(160);
    const published = new Database(join(f.root, "usage.db"), { readonly: true });
    try {
      const row = published.prepare("SELECT value FROM ledger_metadata WHERE key = 'worker-snapshot'").get() as { value: string };
      expect(JSON.parse(row.value).calibration.status).toBe("off");
    } finally { published.close(); }
    process.kill(lock.pid, "SIGTERM");
    await until(async () => { try { process.kill(lock.pid, 0); return undefined; } catch { return true; } }, 3500);
    expect(existsSync(f.lockFile)).toBe(false);
    const stopped = new Database(join(f.root, "usage.db"), { readonly: true });
    try { expect(stopped.prepare("SELECT COUNT(*) AS n FROM leases WHERE owner IS NOT NULL").get()).toEqual({ n: 0 }); }
    finally { stopped.close(); }
    pids.delete(lock.pid);
  }
}, 30000);

it("boot failure stops participant and supplies live calibration getter", async () => {
  // A bind/setup rejection must not strand an ingest worker, and startup mode must not freeze its getter.
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "boot-failure-")); roots.push(root);
  const dir = join(root, "usage-server"); mkdirSync(dir, { mode: 0o700 });
  const lockFile = join(dir, "lock.json"), instanceId = randomBytes(16).toString("hex"), createdAt = Date.now();
  const configFile = join(root, "config.json"); writeFileSync(configFile, '{"usage.calibration":"off"}');
  const options = { bundleUrl: new URL("file:///synthetic/extension.js"), lockFile, instanceId,
    serverBuild: "synthetic@2026-10-05T00:00:00.000Z", calibrationMode: "off" as const, calibrationConfigFile: configFile,
    roots: { ledgerFile: join(root, "usage.db"), registryDb: join(root, "registry.db"), leaseDir: join(root, "leases"),
      sessionsDir: join(root, "sessions"), authPath: join(root, "auth.json") } };
  await writeServerRecord(`${lockFile}.guard`, { version: 1, instanceId, createdAt, pid: process.pid });
  await writeServerRecord(join(dir, "startup.json"), { version: 1, instanceId, createdAt, secret: randomBytes(32).toString("base64url"), options });
  vi.spyOn(httpServer, "startUsageHttpServer").mockRejectedValue(new Error("synthetic-bind-failed"));
  const ledger = createDashboardFixture(false);
  const realOpenReader = dashboardReader.openDashboardReader;
  let closed: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(dashboardReader, "openDashboardReader").mockImplementation((_file, readerOptions) => {
    const reader = realOpenReader(ledger.file, readerOptions)!;
    closed = vi.spyOn(reader, "close");
    return reader;
  });
  let stopped = false;
  await expect(bootUsageServer({ ...options, startParticipant: ingest => {
    expect(ingest.roots).toEqual(options.roots); expect(ingest.bundleUrl).toBe(options.bundleUrl);
    expect(ingest.getCalibrationMode()).toBe("off");
    writeFileSync(configFile, '{"usage.calibration":"auto"}'); expect(ingest.getCalibrationMode()).toBe("auto");
    writeFileSync(configFile, '{"usage.calibration":"off"}'); expect(ingest.getCalibrationMode()).toBe("off");
    return { snapshot: () => ({ role: "standby", lastIngestAt: null, backfill: "pending", errorCode: null }),
      stop: async () => { await new Promise(resolve => setImmediate(resolve)); stopped = true; } };
  } })).rejects.toThrow("synthetic-bind-failed");
  expect(stopped, "participant stopped before boot failure escapes").toBe(true);
  try { expect(closed, "boot opened a reader").toBeDefined(); expect(closed).toHaveBeenCalledOnce(); }
  finally { ledger.close(); }
});

it("non-browser package sources cannot use browser globals", () => {
  // DOM lib declarations are program-wide, so typecheck alone would permit accidental document/window access in Node.
  const files: string[] = [];
  function collect(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || join(dir, entry.name) === resolve("packages/host/src/usage/web")) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) collect(file); else if (/\.(?:[cm]?ts|tsx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) files.push(file);
  } }
  for (const name of readdirSync(resolve("packages"))) {
    const src = resolve("packages", name, "src"); if (existsSync(src)) collect(src);
  }
  const program = ts.createProgram(files, { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext });
  const checker = program.getTypeChecker(); const violations: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && (node.text === "document" || node.text === "window")) {
        const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
        if (!declarations.length || declarations.some(d => d.getSourceFile().isDeclarationFile)) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      }
      ts.forEachChild(node, visit);
    } visit(source);
  }
  expect(violations).toEqual([]);
});

it("source launcher forwards the distinct loaded bundle identity exactly", async () => {
  const launch = vi.spyOn(serverRuntime, "ensureUsageServer").mockRejectedValue(new Error("fixture-stop-before-spawn"));
  const { registerUsageDashboardCommand } = await import("../dashboard-command.js");
  let handler: any;
  registerUsageDashboardCommand({ on() {}, registerCommand(_name: string, definition: any) { handler = definition.handler; } } as never, "file:///synthetic/extension.js");
  await handler("", { mode: "tui", ui: { notify() {}, setWidget() {} } });
  expect(launch.mock.calls[0][0].serverBuild).toBe("def5678@2026-10-05T04:05:06.000Z");
});
