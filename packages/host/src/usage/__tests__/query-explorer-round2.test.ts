import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
afterEach(cleanupFixtureDashboards);
import { createHmac } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { request } from "node:http";
import { startUsageHttpServer } from "../server.js";
import { DashboardQueryError } from "../dashboard-contract.js";
import { build } from "esbuild";
import { join, resolve } from "node:path";
import { openDashboardReader } from "../dashboard-reader.js";
import { dashboardKey } from "../dashboard-identities.js";
import { compileSlice, encodeCursor } from "../dashboard-selection.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Filter, Slice } from "../dashboard-contract.js";
import { queryExplorer, queryFilterValues, EXPLORER_ROUTES } from "../query-explorer.js";
import { queryOverview } from "../query-overview.js";
import { querySourceErrors } from "../query-source-errors.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHmac: vi.fn(actual.createHmac) };
});
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});
const S: Slice = { start: M, end: M + 15 * D, filters: [] };
const idFilter = (field: Dimension, value: string | null): Filter => ({ field, value, kind: "id" } as Filter);
const open = (instanceId = "round2") => openDashboardReader(fixture.file, { instanceId, now: () => NOW, calibrationMode: () => "off", serverBuild: "fixture" })!;
function inspect<T>(fn: (ctx: DashboardQueryContext) => T): T {
  let failure: unknown;
  const value = reader.snapshot(ctx => { try { return fn(ctx); } catch (error) { failure = error; } });
  if (failure) throw failure;
  return value as T;
}
const values = () => inspect(ctx => queryFilterValues(ctx, S, "project", "", 200));
beforeEach(() => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([dashboardCall("a", { project: "project-a" }), dashboardCall("b", { project: "project-b" })]));
  reader = open();
});
afterEach(() => { reader.close(); fixture.close(); vi.restoreAllMocks(); });

// Dropping any safety check must accept the corresponding unsafe file and fail these oracles.
for (const unsafe of ["symlink", "mode", "short", "long", "empty", "directory", "hardlink"] as const) {
  it(`refuses ${unsafe} salts without rotating or exposing paths`, () => {
    const file = fixture.file + ".explorer-salt";
    const target = join(fixture.root, "target");
    writeFileSync(target, Buffer.alloc(32, 7), { mode: 0o600 });
    if (unsafe === "symlink") symlinkSync(target, file);
    else if (unsafe === "hardlink") linkSync(target, file);
    else if (unsafe === "directory") mkdirSync(file);
    else {
      writeFileSync(file, Buffer.alloc(unsafe === "short" ? 31 : unsafe === "long" ? 33 : unsafe === "empty" ? 0 : 32, 7), { mode: 0o600 });
      if (unsafe === "mode") chmodSync(file, 0o644);
    }
    const before = unsafe === "directory" ? null : readFileSync(file);
    expect(values).toThrow("identity-unavailable");
    if (before) expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(fixture.root).filter(name => /explorer-salt\./.test(name))).toEqual([]);
  });
}
it("refuses a salt not owned by the current user", () => {
  writeFileSync(fixture.file + ".explorer-salt", Buffer.alloc(32, 7), { mode: 0o600 });
  vi.spyOn(process, "getuid").mockReturnValue(statSync(fixture.file + ".explorer-salt").uid + 1);
  expect(values).toThrow("identity-unavailable");
});
it("read-only salt directories give a fixed identity error and preserve the original failure", () => {
  chmodSync(fixture.root, 0o555);
  try {
    expect(values).toThrow("identity-unavailable");
    expect(inspect(ctx => queryOverview(ctx, S)).totals.calls).toBe(2);
  } finally { chmodSync(fixture.root, 0o755); }
});
it("creates private salts even when umask removes owner permissions", () => {
  const mask = process.umask(0o277);
  try {
    expect(values().rows).toHaveLength(2);
    expect(statSync(fixture.file + ".explorer-salt").mode & 0o777).toBe(0o600);
  } finally { process.umask(mask); }
});
it("win32 does not require POSIX mode bits on an existing regular salt", () => {
  const file = fixture.file + ".explorer-salt";
  writeFileSync(file, Buffer.alloc(32, 7), { mode: 0o600 }); chmodSync(file, 0o666);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { expect(values().rows).toHaveLength(2); }
  finally { Object.defineProperty(process, "platform", descriptor); }
});
it("salt replacement changes ids and stale bookmarked ids are rejected", () => {
  const a = values().rows[0]!.id!;
  reader.close();
  writeFileSync(fixture.file + ".explorer-salt", Buffer.alloc(32, 8), { mode: 0o600 });
  reader = open("replaced");
  const b = values().rows[0]!.id!;
  expect(b).not.toBe(a);
  expect(() => inspect(ctx => queryOverview(ctx, { ...S, filters: [idFilter("project", a)] }))).toThrow("unknown-filter-id");
  reader.close(); unlinkSync(fixture.file + ".explorer-salt"); reader = open("deleted");
  expect(values().rows[0]!.id).not.toBe(b);
  expect(() => inspect(ctx => queryExplorer(ctx, { slice: { ...S, filters: [idFilter("project", b)] }, groupBy: ["project"], page: { limit: 50 } }))).toThrow("unknown-filter-id");
});

it("normalizes symlinked and trailing-separator HOME on a separator boundary", () => {
  const real = join(fixture.root, "realhome"); mkdirSync(real);
  const home = realpathSync(real); const link = join(fixture.root, "linkhome"); symlinkSync(real, link);
  fixture.ledger.apply(dashboardBatch([dashboardCall("home", { project: home + "/src/repo" }), dashboardCall("other", { project: home + "-other/src/repo" })]));
  for (const variant of [home + "/", link]) {
    reader.close(); process.env.HOME = variant; reader = open(variant);
    const labels = values().rows.map(row => row.label);
    expect(labels).toContain("~/src/repo"); expect(labels).toContain("…/src/repo");
    expect(JSON.stringify(labels)).not.toContain(home);
  }
});
it("redacts embedded POSIX, drive and UNC paths without mangling file prefixes", () => {
  const home = process.env.HOME!;
  const samples: [string, string][] = [
    [`path=${home}/src/repo`, "path=~/src/repo"], [`[${home}/src/repo]`, "[~/src/repo]"],
    ["`/srv/private/repo`", "`…/private/repo`"], ["x,/srv/private/repo", "x,…/private/repo"],
    ["file:/srv/private/repo", "file:…/private/repo"], ["path=C:\\private\\src\\repo", "path=…/src/repo"],
    ["path=\\\\server\\private\\src\\repo", "path=…/src/repo"],
  ];
  fixture.ledger.apply(dashboardBatch(samples.map(([role], i) => dashboardCall(`label-${i}`, { role }))));
  inspect(ctx => {
    const rows = queryFilterValues(ctx, S, "role", "", 200).rows;
    for (const [, label] of samples) expect(rows).toContainEqual({ id: expect.any(String), label });
  });
});
it("all dimensions and decoded cursors keep synthetic absolute paths off the wire", () => {
  const home = process.env.HOME!;
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 6 }, (_, i) => dashboardCall(`privacy-${i}`, {
    project: `${home}/src/repo-${i}`, repo: `${home}/src/repo`, sessionId: `session-${i}`, runId: `run-${i}`,
    runName: `file:${home}/src/run-${i}`, role: `path=${home}/src/role-${i}`, agent: `[/srv/private/agent-${i}]`,
  }))));
  const dimensions: Dimension[] = ["project", "repo", "session", "actor", "role", "agent", "provider", "model", "requestedModel", "thinking", "run", "runName", "phase", "parentRun", "auxPurpose", "api", "day"];
  inspect(ctx => {
    const blobs: string[] = [];
    const append = (page: { nextCursor: string | null }) => { blobs.push(JSON.stringify(page)); if (page.nextCursor) blobs.push(Buffer.from(page.nextCursor, "base64url").toString()); };
    for (const field of dimensions) {
      const page = queryFilterValues(ctx, S, field, "", 1); append(page);
      if (page.nextCursor) append(queryFilterValues(ctx, S, field, "", 1, page.nextCursor));
      for (const row of queryFilterValues(ctx, S, field, "", 200).rows) {
        blobs.push(JSON.stringify(row));
        if (row.id === null) continue; // No discovery action for a missing or unsupported key.
        const slice = { ...S, filters: [idFilter(field, row.id)] };
        append(queryExplorer(ctx, { slice, groupBy: [field], page: { limit: 1 } }));
        blobs.push(JSON.stringify(queryOverview(ctx, slice)));
      }
    }
    append(queryExplorer(ctx, { slice: S, groupBy: ["project", "repo", "session"], page: { limit: 1 } }));
    const all = blobs.join("\n");
    expect(all).not.toContain(home); expect(all).not.toContain(fixture.root); expect(all).not.toContain("/srv/private/");
    expect(all).toContain("~/src/repo-");
  });
});

it("raw filters never reinterpret id-shaped stored values", () => {
  const shaped = "v1_" + "Q".repeat(43);
  fixture.ledger.apply(dashboardBatch([dashboardCall("shape", { role: shaped })]));
  expect(inspect(ctx => queryOverview(ctx, { ...S, filters: [{ field: "role", value: shaped }] })).totals.calls).toBe(1);
  expect(() => inspect(ctx => queryOverview(ctx, { ...S, filters: [idFilter("role", shaped)] }))).toThrow("unknown-filter-id");
});
it("session and run keys are safe stored ids; unsupported ids remain counted without keys", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("safe", { sessionId: "safe.session:1", runId: "safe-run_1" }),
    dashboardCall("bad", { sessionId: "/private/session", runId: "bad id" }),
    dashboardCall("bad2", { sessionId: "x".repeat(129), runId: "bad/id" }),
  ]));
  inspect(ctx => {
    for (const [field, safe] of [["session", "safe.session:1"], ["run", "safe-run_1"]] as const) {
      expect(dashboardKey(ctx, field, safe)).toBe(safe);
      expect(dashboardKey(ctx, field, "/unsupported")).toBeNull();
      const all = queryExplorer(ctx, { slice: S, groupBy: [field], page: { limit: 200 } });
      expect(all.totals.calls).toBe(5); expect(all.rows.reduce((n, row) => n + row.measure.calls, 0)).toBe(5);
      expect(all.rows).toContainEqual({ key: [safe], labels: [safe], measure: expect.objectContaining({ calls: 1 }) });
      const bad = all.rows.filter(row => row.labels[0] === "unsupported id");
      expect(bad.reduce((n, row) => n + row.measure.calls, 0)).toBe(2); expect(bad.every(row => row.key[0] === null)).toBe(true);
      expect(queryFilterValues(ctx, S, field, "safe", 200).rows).toEqual([{ id: safe, label: safe }]);
      expect(queryExplorer(ctx, { slice: { ...S, filters: [idFilter(field, safe)] }, groupBy: [field], page: { limit: 50 } }).totals.calls).toBe(1);
    }
  });
});
it("typeahead pages sort by case-insensitive label then id, including label ties", () => {
  const names = ["zulu", "Bravo", "alpha", "ALPHA", "bravo", "éclair", "Örebro", "a".repeat(161), "a".repeat(160) + "z"];
  fixture.ledger.apply(dashboardBatch(names.map((model, i) => dashboardCall(`sort-${i}`, { model }))));
  inspect(ctx => {
    const full = queryFilterValues(ctx, S, "model", "", 200).rows;
    const sorted = [...full].sort((a,b) => {
      const x = a.label?.toLowerCase() ?? "";
      const y = b.label?.toLowerCase() ?? "";
      return x < y ? -1 : x > y ? 1 : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0;
    });
    expect(full).toEqual(sorted);
    const got: unknown[] = []; let cursor: string | undefined;
    for (let n = 0; n < 20; n++) {
      const page = queryFilterValues(ctx, S, "model", "", 1, cursor); got.push(...page.rows); cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined(); expect(got).toEqual(full);
  });
});
it("id resolution uses an indexed distinct cache and invalidates on revision changes", () => {
  const id = values().rows.find(row => row.label === "project-a")!.id!;
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    const filtered = { ...S, filters: [idFilter("project", id)] };
    expect(queryOverview(ctx, filtered).totals.calls).toBe(1);
    const statements = prepare.mock.calls.map(([sql]) => sql);
    const lookup = statements.find(sql => /SELECT DISTINCT/.test(sql) && /FROM calls/.test(sql))!;
    expect(lookup).toBeDefined();
    const plan = ctx.db.prepare("EXPLAIN QUERY PLAN " + lookup).all(M, M + 15 * D) as { detail: string }[];
    expect(plan.some(row => /SEARCH c USING INDEX calls_period_read \(ts>\? AND ts<\?\)/.test(row.detail))).toBe(true);
    prepare.mockClear();
    expect(queryOverview(ctx, filtered).totals.calls).toBe(1);
    expect(prepare.mock.calls.some(([sql]) => sql === lookup)).toBe(false);
    expect(compileSlice(filtered, undefined, ctx).sql).not.toContain("explorer_id");
    prepare.mockRestore();
  });
  fixture.db.prepare("UPDATE calls SET project='replacement' WHERE id='a'").run();
  expect(() => inspect(ctx => queryOverview(ctx, { ...S, filters: [idFilter("project", id)] }))).toThrow("unknown-filter-id");
});
it("ids are hashed once per distinct value after grouping, not per call", () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 1000 }, (_, i) => dashboardCall(`perf-${i}`, { model: "shared-model", project: "shared-project" }))));
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    vi.mocked(createHmac).mockClear();
    expect(queryExplorer(ctx, { slice: S, groupBy: ["model", "project"], page: { limit: 50 } }).totals.calls).toBe(1002);
    expect(vi.mocked(createHmac).mock.calls).toHaveLength(5);
    const sql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("WITH counted"))!;
    // Count the executed UDF calls independently, preserving the actual public identities.
    const seen: Record<string, number> = {};
    const ids = new Map<string, string>();
    for (const field of ["model", "project"] as const) for (const row of queryFilterValues(ctx, S, field, "", 200).rows) ids.set(field + ":" + row.label, row.id!);
    ctx.db.raw.function("explorer_id", { deterministic: true }, (field: string, value: string | null) => {
      if (value === null) return null;
      seen[field + ":" + value] = (seen[field + ":" + value] ?? 0) + 1;
      return ids.get(field + ":" + value)!;
    });
    ctx.db.prepare(sql).all(M, M + 15 * D, 51);
    expect(Math.max(...Object.values(seen))).toBeLessThanOrEqual(2);
    prepare.mockRestore();
  });
});

it("old cursors return ledger-changed after a process restart", async () => {
  for (let i = 0; i < 3; i++) fixture.db.prepare("INSERT INTO import_state(path,last_ingest_at,parse_errors,generation) VALUES (?,?,?,0)").run(`synthetic/error-${i}`, NOW, 1);
  const exp = inspect(ctx => queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1 } }).nextCursor!);
  const src = inspect(ctx => querySourceErrors(ctx, { limit: 1 }).nextCursor!);
  vi.resetModules();
  const freshExplorer = await import("../query-explorer.js");
  const freshSource = await import("../query-source-errors.js");
  expect(() => inspect(ctx => freshExplorer.queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1, cursor: exp } }))).toThrow("ledger-changed");
  expect(() => inspect(ctx => freshSource.querySourceErrors(ctx, { limit: 1, cursor: src }))).toThrow("ledger-changed");
});
it("cursor MAC is not signed with a fixed all-zero key", () => {
  const cursor = encodeCursor("fixture", "fixed-key-test:1", {}, [1]);
  const { mac, ...payload } = JSON.parse(Buffer.from(cursor, "base64url").toString());
  expect(createHmac("sha256", Buffer.alloc(32)).update(JSON.stringify(payload)).digest("base64url")).not.toBe(mac);
});
it("cursor windows reject a mismatched explicit start when end is omitted", () => {
  inspect(ctx => {
    for (const route of EXPLORER_ROUTES) {
      const params = new URLSearchParams(route.path.endsWith("filter-values") ? "field=project&limit=1" : "groupBy=project&limit=1");
      const first = route.handle(ctx, params) as { nextCursor: string };
      params.set("cursor", first.nextCursor); params.set("start", String(M + 1));
      expect(() => route.handle(ctx, params)).toThrow("invalid-query");
    }
  });
});
it("escaped control labels fit the complete HTTP envelope cap and continue", () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 200 }, (_, i) => dashboardCall(`control-${i}`, {
    runName: String(i).padStart(3, "0") + "\u0001".repeat(157), role: "\u0002\"\\".repeat(53) + String(i % 7), phase: "\u001f".repeat(160),
  }))));
  inspect(ctx => {
    for (const [query, cap] of [
      [(cursor?: string) => queryExplorer(ctx, { slice: S, groupBy: ["runName", "role", "phase"], page: { limit: 200, cursor } }), 256 * 1024],
      [(cursor?: string) => queryFilterValues(ctx, S, "runName", "", 200, cursor), 64 * 1024],
    ] as const) {
      let cursor: string | undefined; let count = 0;
      for (let n = 0; n < 20; n++) {
        const p = query(cursor);
        const envelope = { apiVersion: 1, revision: ctx.revision, generatedAt: NOW, period: { start: S.start, end: S.end }, data: p };
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(cap);
        count += p.rows.length; cursor = p.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined(); expect(count).toBe(201);
    }
  });
});

it("exclusive publication preserves the salt that another creator already published", () => {
  const winning = Buffer.alloc(32, 9);
  vi.mocked(linkSync).mockImplementationOnce((_temporary, file) => {
    writeFileSync(file, winning, { mode: 0o600 });
    throw Object.assign(new Error("synthetic publication race"), { code: "EEXIST" });
  });
  expect(values().rows).toHaveLength(2);
  expect(readFileSync(fixture.file + ".explorer-salt")).toEqual(winning);
  expect(readdirSync(fixture.root).filter(name => /explorer-salt\./.test(name))).toEqual([]);
});

it("a transient publication hardlink settles without a request error", async () => {
  const salt = fixture.file + ".explorer-salt"; const temporary = salt + ".creator";
  writeFileSync(salt, Buffer.alloc(32, 9), { mode: 0o600 }); linkSync(salt, temporary);
  const child = spawn(process.execPath, [resolve("packages/host/src/usage/__tests__/fixtures/dashboard-identity-unlink.mjs"), temporary], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    await new Promise<void>((ready, reject) => { child.once("message", () => ready()); child.once("error", reject); });
    child.send("go");
    expect(values().rows).toHaveLength(2);
    expect(statSync(salt).nlink).toBe(1);
  } finally { child.kill("SIGKILL"); }
});

it("concurrent processes publish one stable salt without errors, flips or leftovers", async () => {
  const root = join(fixture.root, "race"); mkdirSync(root);
  const bundle = join(root, "identities.mjs");
  await build({ entryPoints: [resolve("packages/host/src/usage/dashboard-identities.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const worker = resolve("packages/host/src/usage/__tests__/fixtures/dashboard-identity-race.mjs");
  const children = new Set<ReturnType<typeof spawn>>();
  try {
    for (let round = 0; round < 12; round++) {
      const file = join(root, `race-${round}.db`);
      const jobs = Array.from({ length: 8 }, () => {
        const child = spawn(process.execPath, [worker, bundle, file], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.add(child);
        let output = ""; child.stdout!.on("data", chunk => output += chunk); child.stderr!.on("data", chunk => output += chunk);
        const ready = new Promise<void>((resolveReady, reject) => { child.once("message", () => resolveReady()); child.once("error", reject); });
        const done = new Promise<string>((resolveDone, reject) => { child.once("exit", code => { children.delete(child); code === 0 ? resolveDone(output.trim()) : reject(new Error(output)); }); child.once("error", reject); });
        return { child, ready, done };
      });
      await Promise.all(jobs.map(job => job.ready)); jobs.forEach(job => job.child.send("go"));
      const ids = await Promise.all(jobs.map(job => job.done));
      expect(ids.every(id => /^v1_[A-Za-z0-9_-]{43}$/.test(id)), JSON.stringify(ids)).toBe(true);
      const successful = ids;
      const salt = readFileSync(file + ".explorer-salt");
      const stable = createHmac("sha256", salt).update(JSON.stringify(["project", "synthetic-project"])).digest("base64url");
      expect(successful.every(id => id === "v1_" + stable), JSON.stringify(ids)).toBe(true);
      // After every publisher has finished, a fresh reader must work without retrying.
      const retry = spawn(process.execPath, [worker, bundle, file], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.add(retry);
      const again = await new Promise<string>((done, reject) => {
        let output = ""; retry.stdout!.on("data", chunk => output += chunk);
        retry.once("message", () => retry.send("go")); retry.once("error", reject);
        retry.once("exit", code => { children.delete(retry); code === 0 ? done(output.trim()) : reject(new Error(output)); });
      });
      expect(again).toBe("v1_" + stable);
    }
    expect(readdirSync(root).filter(name => /explorer-salt\./.test(name))).toEqual([]);
  } finally { for (const child of children) child.kill("SIGKILL"); }
}, 30000);
it("identity error codes map to their fixed HTTP statuses and clear messages", async () => {
  const secret = "synthetic-round2-server-secret";
  const server = await startUsageHttpServer({ instanceId: "round2", serverBuild: "fixture", secret, reader, dashboardDir: createFixtureDashboard(),
    routes: [{ path: "/api/explorer", handle(_ctx, params) { throw new DashboardQueryError(params.get("code") as "identity-unavailable" | "unknown-filter-id"); } }] });
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((done, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, headers, agent: false }, res => {
      let body = ""; res.on("data", chunk => body += chunk); res.once("end", () => done({ status: res.statusCode!, headers: res.headers, body })); res.once("error", reject);
    }); req.once("error", reject); req.end();
  });
  try {
    const minted = await get("/local/bootstrap-nonce", { Authorization: `Bearer ${secret}` });
    const boot = await get("/bootstrap?nonce=" + JSON.parse(minted.body).data.nonce);
    const cookie = boot.headers["set-cookie"]![0]!.split(";")[0]!;
    for (const [code, status, message] of [["identity-unavailable", 503, "Dashboard identity unavailable"], ["unknown-filter-id", 400, "Unknown filter id"]] as const) {
      const response = await get("/api/explorer?code=" + code, { Cookie: cookie });
      expect(response.status).toBe(status); expect(JSON.parse(response.body)).toEqual({ apiVersion: 1, error: { code, message } });
    }
  } finally { await server.close(); }
});

it("FIFO salts fail promptly instead of blocking the event loop", async () => {
  const file = fixture.file + ".explorer-salt";
  execFileSync("mkfifo", [file]);
  const bundle = join(fixture.root, "fifo-identities.mjs");
  await build({ entryPoints: [resolve("packages/host/src/usage/dashboard-identities.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const child = spawn(process.execPath, [resolve("packages/host/src/usage/__tests__/fixtures/dashboard-identity-race.mjs"), bundle, fixture.file], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  try {
    const outcome = await new Promise<string>((resolveResult, reject) => {
      let output = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("FIFO open blocked")); }, 2000);
      child.stdout!.on("data", chunk => output += chunk); child.stderr!.on("data", chunk => output += chunk);
      child.once("message", () => child.send("go")); child.once("error", reject);
      child.once("exit", () => { clearTimeout(timer); resolveResult(output.trim()); });
    });
    expect(outcome).toBe("ERR identity-unavailable");
  } finally { child.kill("SIGKILL"); }
});
