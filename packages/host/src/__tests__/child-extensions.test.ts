import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { paths, type Db } from "@spider/db-core";
import { makeRunHandler, teardownAll } from "@spider/subagents";
import { buildActionCtx } from "../extension";
import { controlConfig, controlDoctor, configValues } from "../control";
import { applyConfigEdit, applyConfigUnset } from "../control/config-cmd";
import { coerce, getField } from "@spider/ui";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/child-extensions");
let root: string;
let previousGlobal: string;
const dbs = new Set<Db>();
beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  // Non-git fixture roots must not discover the enclosing checkout.
  vi.stubEnv("GIT_CEILING_DIRECTORIES", scratch);
  root = mkdtempSync(join(scratch, "config-"));
  previousGlobal = paths.globalRoot;
  paths.globalRoot = join(root, "global");
});
afterEach(() => {
  vi.restoreAllMocks();
  teardownAll();
  for (const db of dbs) db.close();
  dbs.clear();
  paths.globalRoot = previousGlobal;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function actionCtx() {
  const ctx = buildActionCtx({} as never, { action: "run", task: "work" }, "extension-owner", root);
  for (const db of [ctx.db, ctx.repoDb, ctx.globalDb]) dbs.add(db);
  return ctx;
}
function extension(name: string): string {
  const file = join(root, name);
  writeFileSync(file, "export default () => {};\n");
  return file;
}

it("accepts a global extension list, persists an array, and unsets back to empty", () => {
  expect(controlConfig("get", root, "subagents.extensions")).toEqual([]);
  const list = ["/path/to/compaction.ts", "/path/to/other.js"];
  expect(controlConfig("set", root, "subagents.extensions", list, "global")).toMatchObject({ ok: true });
  expect(controlConfig("get", root, "subagents.extensions")).toEqual(list);
  controlConfig("unset", root, "subagents.extensions", undefined, "global");
  expect(controlConfig("get", root, "subagents.extensions")).toEqual([]);
});

it.each([['["relative.ts"]'], ['["/path/to/valid.ts", "../relative.ts"]'], ['[1]'], ['{}'], ['"/path/to/one.ts"'], ['not json']])(
  "rejects invalid extension JSON %s without changing config", raw => {
    const result = coerce(getField("subagents.extensions")!, raw);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/absolute.*paths/i) });
    expect(controlConfig("get", root, "subagents.extensions")).toEqual([]);
  },
);
it.each([{ value: ["relative.ts"] }, { value: ["/path/to/valid.ts", "../relative.ts"] }, { value: [1] }, { value: "/path/to/one.ts" }, { value: null }])(
  "validates direct config writes too: $value", ({ value }) => {
    expect(() => controlConfig("set", root, "subagents.extensions", value, "global")).toThrow(/absolute.*paths/i);
  },
);

function localConfig(value: unknown): string {
  const file = join(root, ".spider", "config.json");
  mkdirSync(join(root, ".spider"), { recursive: true });
  writeFileSync(file, JSON.stringify({ "subagents.extensions": value }));
  return file;
}

it("uses global extensions even when childMode has a local override", () => {
  const global = extension("global.ts");
  const local = extension("local.ts");
  controlConfig("set", root, "subagents.extensions", [global], "global");
  controlConfig("set", root, "subagents.childMode", "print", "global");
  expect(actionCtx()).toMatchObject({ childMode: "print", subagentOnlyExtensions: [global] });
  localConfig([local]);
  controlConfig("set", root, "subagents.childMode", "rpc");
  expect(actionCtx()).toMatchObject({ childMode: "rpc", subagentOnlyExtensions: [global] });
  expect(configValues(root).sources["subagents.extensions"]).toBe("global");
  controlConfig("unset", root, "subagents.extensions");
  expect(actionCtx()).toMatchObject({ subagentOnlyExtensions: [global] });
});

it("ignores repository-supplied extension code and reports the file in config get and doctor", () => {
  const file = localConfig([extension("untrusted.ts")]);
  expect(actionCtx().subagentOnlyExtensions).toEqual([]);
  expect(controlConfig("get", root, "subagents.extensions")).toEqual([]);
  expect(configValues(root)).toMatchObject({ sources: { "subagents.extensions": "default" }, errors: [expect.stringContaining(file)] });
  expect(configValues(root).errors.join("\n")).toMatch(/ignored.*global/i);
  expect(controlDoctor(root).lines.join("\n")).toContain(file);
});

it("does not report ignored local extensions as shadowing a global write", () => {
  localConfig(["/path/to/untrusted.ts"]);
  const result = controlConfig("set", root, "subagents.extensions", [], "global");
  expect(result).not.toHaveProperty("shadowedBy");
  expect(controlConfig("get", root, "subagents.extensions")).toEqual([]);
});

it.each(["run", "control"] as const)("reads each config file once for a %s action and derives all dispatch settings", action => {
  const trusted = extension("trusted.ts");
  controlConfig("set", root, "subagents.extensions", [trusted], "global");
  controlConfig("set", root, "subagents.childMode", "rpc", "global");
  controlConfig("set", root, "models.defaults", { worker: "provider/global", reviewer: "provider/reviewer" }, "global");
  localConfig(["/path/to/untrusted.ts"]);
  controlConfig("set", root, "subagents.childMode", "print");
  controlConfig("set", root, "models.defaults", { worker: "provider/local" });
  const reads = vi.spyOn(fs, "readFileSync");
  const ctx = buildActionCtx({} as never, { action }, "extension-owner", root);
  for (const db of [ctx.db, ctx.repoDb, ctx.globalDb]) dbs.add(db);
  expect(ctx).toMatchObject({
    childMode: "print", subagentOnlyExtensions: [trusted],
    modelDefaults: { worker: "provider/local", reviewer: "provider/reviewer" },
  });
  for (const file of [join(paths.globalRoot, "config.json"), join(root, ".spider", "config.json")]) {
    expect(reads.mock.calls.filter(([path]) => path === file)).toHaveLength(1);
  }
});

it("rejects non-global set but permits local unset for cleanup", () => {
  expect(() => controlConfig("set", root, "subagents.extensions", [])).toThrow(/global.only/i);
  localConfig(["/path/to/untrusted.ts"]);
  expect(controlConfig("unset", root, "subagents.extensions")).toMatchObject({ ok: true, scope: "local" });
  expect(configValues(root).errors).toEqual([]);
});

it.each([undefined, "local", "global"] as const)("protects tool set and unset at %s scope without changing either file", scope => {
  controlConfig("set", root, "subagents.extensions", [extension("trusted.ts")], "global");
  const localFile = localConfig(["/path/to/untrusted.ts"]);
  const globalFile = join(paths.globalRoot, "config.json");
  const before = [readFileSync(globalFile, "utf8"), readFileSync(localFile, "utf8")];
  expect(applyConfigEdit(root, "subagents.extensions", "[]", scope)).toMatchObject({ ok: false, error: expect.stringMatching(/protected.*user/i) });
  expect(applyConfigUnset(root, "subagents.extensions", scope)).toMatchObject({ ok: false, error: expect.stringMatching(/protected.*user/i) });
  for (const result of [applyConfigEdit(root, "subagents.extensions", "[]", scope), applyConfigUnset(root, "subagents.extensions", scope)]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("~/.pi/agent/spider/config.json, or config.json under SPIDER_GLOBAL_ROOT") });
  }
  expect([readFileSync(globalFile, "utf8"), readFileSync(localFile, "utf8")]).toEqual(before);
});

it("loads the user-edited global file without requiring a tool write", () => {
  const trusted = extension("user-edited.ts");
  mkdirSync(paths.globalRoot, { recursive: true });
  writeFileSync(join(paths.globalRoot, "config.json"), JSON.stringify({ "subagents.extensions": [trusted] }));
  expect(actionCtx().subagentOnlyExtensions).toEqual([trusted]);
});

it("does not let a consumer mutate the empty extension default for future dispatches", () => {
  const value = controlConfig("get", root, "subagents.extensions") as string[];
  try { value.push("/path/to/untrusted.ts"); } catch { /* frozen defaults may refuse mutation */ }
  try {
    expect(actionCtx().subagentOnlyExtensions).toEqual([]);
  } finally {
    // RED must not leak the mutation into other tests.
    if (!Object.isFrozen(value)) value.length = 0;
  }
});

it.each([{ value: "bad" }, { value: ["relative.ts"] }, { value: [false] }])("blocks a run with malformed hand-edited extensions $value but permits repair", ({ value }) => {
  mkdirSync(paths.globalRoot, { recursive: true });
  const file = join(paths.globalRoot, "config.json");
  writeFileSync(file, JSON.stringify({ "subagents.extensions": value }));
  const repair = buildActionCtx({} as never, { action: "control", command: "config", op: "set" }, "extension-owner", root);
  for (const db of [repair.db, repair.repoDb, repair.globalDb]) dbs.add(db);
  expect(() => actionCtx()).toThrow(file);
  expect(configValues(root).errors).toEqual([expect.stringContaining(`invalid subagents.extensions in ${file}`)]);
  expect(controlDoctor(root).lines.join("\n")).toContain(`invalid subagents.extensions in ${file}`);
  controlConfig("set", root, "subagents.extensions", [], "global");
  expect(actionCtx()).toMatchObject({ subagentOnlyExtensions: [] });
});

it("diagnoses invalid ignored local extension lists without blocking runs", () => {
  const file = localConfig(["relative.ts"]);
  expect(actionCtx().subagentOnlyExtensions).toEqual([]);
  expect(configValues(root).errors.join("\n")).toContain(`invalid subagents.extensions in ${file}`);
  expect(controlDoctor(root).lines.join("\n")).toContain(`invalid subagents.extensions in ${file}`);
});

const shapes = [
  { name: "single", args: { agent: "worker", task: "work" }, children: 1, notices: 1 },
  { name: "parallel", args: { tasks: [{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }] }, children: 2, notices: 2 },
  { name: "chain", args: { chain: [{ agent: "worker", task: "one" }, { agent: "worker", task: "{previous}" }] }, children: 2, notices: 1 },
  { name: "pipeline", args: { pipeline: [{ agent: "worker", task: "one" }, { agent: "worker", task: "{previous}" }] }, children: 2, notices: 2 },
];
for (const childMode of ["rpc", "print"] as const) {
  it.each(shapes)(`loads configured extensions and persists skip warnings in ${childMode} $name children`, async shape => {
    const first = extension("first.ts"), second = extension("second.js"), intercom = extension("intercom.ts");
    const spider = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, "packages/subagents/src/pi-args.ts");
    const missing = join(root, "missing.ts"), firstMissing = `${root}/./missing.ts`, directory = join(root, "directory.ts");
    mkdirSync(directory);
    controlConfig("set", root, "subagents.childMode", childMode);
    controlConfig("set", root, "subagents.extensions", [spider, first, first, ...(childMode === "rpc" ? [intercom] : []), firstMissing, missing, second, directory], "global");
    const ctx = actionCtx();
    let notices = 0;
    let completed!: () => void;
    const completion = new Promise<void>(done => { completed = done; });
    ctx.pi = { sendMessage() { if (++notices === shape.notices) completed(); } };
    const launches: string[][] = [];
    const handler = makeRunHandler({
      resolveIntercom: async () => [intercom],
      spawner: spec => {
        launches.push(spec.argv.flatMap((arg, index) => arg === "--extension" ? [spec.argv[index + 1]] : []));
        // Skip warnings must already be in the real run DB before launching.
        const warnings = ctx.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'")
          .all(spec.env.PI_SUBAGENT_RUN_ID) as { summary: string }[];
        const missingWarnings = warnings.filter(w => w.summary.includes("missing.ts"));
        expect(missingWarnings).toHaveLength(1);
        expect(missingWarnings[0].summary).toContain(firstMissing);
        expect(missingWarnings[0].summary).not.toContain(missing);
        expect(warnings.map(w => w.summary).join("\n")).toContain(directory);
        return { kill() {}, detach() {}, wait: async () => ({ exitCode: 0, result: "report" }) };
      },
    });
    await handler(shape.args, ctx);
    await completion;
    expect(launches).toHaveLength(shape.children);
    for (const loaded of launches) expect(loaded).toEqual([spider, ...(childMode === "rpc" ? [intercom] : []), first, second]);
    const runs = ctx.db.prepare("SELECT status FROM runs WHERE session_id=?").all(ctx.sessionId) as { status: string }[];
    expect(runs).toHaveLength(shape.children);
    expect(runs.every(run => run.status === "done")).toBe(true);
  });
}
