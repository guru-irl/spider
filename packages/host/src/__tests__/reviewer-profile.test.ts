import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths, type Db } from "@spider/db-core";
import { makeRunHandler, teardownAll } from "@spider/subagents";
import { buildActionCtx } from "../extension";
import { controlConfig, configValues } from "../control";
import { applyConfigEdit, applyConfigUnset } from "../control/config-cmd";
import { coerce, getField } from "@spider/ui";

const key = "subagents.profiles.reviewer.excludeTools";
const scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/reviewer-profile");
let root: string;
let previousGlobal: string;
const dbs = new Set<Db>();
beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", scratch);
  root = mkdtempSync(join(scratch, "config-"));
  previousGlobal = paths.globalRoot;
  paths.globalRoot = join(root, "global");
});
afterEach(() => {
  teardownAll();
  for (const db of dbs) db.close();
  dbs.clear();
  paths.globalRoot = previousGlobal;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function config(scope: "global" | "local", value: unknown) {
  const dir = scope === "global" ? paths.globalRoot : join(root, ".spider");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ [key]: value }));
}
function actionCtx(action: "run" | "control" = "run") {
  const ctx = buildActionCtx({} as never, { action }, "reviewer-owner", root);
  for (const db of [ctx.db, ctx.repoDb, ctx.globalDb]) dbs.add(db);
  return ctx;
}

// A missing policy or dropped plumbing must fail at argv, not at a mocked builder.
const shapes = [
  { name: "single", args: { agent: "reviewer", task: "review" }, agents: ["reviewer"], notices: 1 },
  { name: "parallel", args: { tasks: [{ agent: "worker", task: "work" }, { agent: "reviewer", task: "review" }] }, agents: ["worker", "reviewer"], notices: 2 },
  { name: "chain", args: { chain: [{ agent: "worker", task: "work" }, { agent: "reviewer", task: "{previous}" }] }, agents: ["worker", "reviewer"], notices: 1 },
  { name: "pipeline", args: { pipeline: [{ agent: "worker", task: "work" }, { agent: "reviewer", role: "quality", task: "{previous}" }] }, agents: ["worker", "reviewer"], notices: 2 },
];
for (const childMode of ["rpc", "print"] as const) {
  for (const override of [undefined, [], ["write", "bash", "write", "intercom"]] as const) {
    it.each(shapes)(`${childMode} $name applies ${override ? "configured" : "default"} reviewer exclusions without changing workers`, async shape => {
      if (override) config("global", override);
      controlConfig("set", root, "subagents.childMode", childMode);
      const ctx = actionCtx();
      let notices = 0;
      let completed!: () => void;
      const completion = new Promise<void>(done => { completed = done; });
      ctx.pi = { sendMessage() { if (++notices === shape.notices) completed(); } };
      const launches: Array<{ agent: string; argv: string[] }> = [];
      const handler = makeRunHandler({ spawner: spec => {
        launches.push({ agent: spec.env.PI_SUBAGENT_CHILD_AGENT, argv: spec.argv });
        return { kill() {}, detach() {}, wait: async () => ({ exitCode: 0, result: "report" }) };
      } });
      // Run arguments cannot override the user-owned tool profile.
      await handler({ ...shape.args, reviewerExcludeTools: [], excludeTools: [], profiles: { reviewer: { excludeTools: [] } } }, ctx);
      await completion;
      expect(launches.map(launch => launch.agent)).toEqual(shape.agents);
      for (const { agent, argv } of launches) {
        const exclusions = argv.flatMap((arg, index) => arg === "--exclude-tools" ? argv[index + 1].split(",") : []);
        const want = agent !== "reviewer" || override?.length === 0 ? [] : override ? ["write", "bash", "intercom"] : ["edit", "write"];
        expect(exclusions).toEqual([...new Set([...(childMode === "rpc" ? ["intercom", "contact_supervisor"] : []), ...want])]);
        expect(argv.filter(arg => arg === "--exclude-tools")).toHaveLength(exclusions.length ? 1 : 0);
        expect(argv).toContain("--no-extensions");
      }
    });
  }
}

it("ignores repository profile overrides and keeps global provenance", () => {
  config("local", []);
  expect(controlConfig("get", root, key)).toEqual(["edit", "write"]);
  expect(configValues(root)).toMatchObject({ sources: { [key]: "default" }, errors: [expect.stringMatching(/ignored.*global/i)] });
  config("global", ["write"]);
  expect(controlConfig("get", root, key)).toEqual(["write"]);
  expect(configValues(root).sources[key]).toBe("global");
});

it.each(["local", "global"] as const)("protects tool set and unset at %s scope", scope => {
  config("global", ["write"]);
  config("local", []);
  const files = [join(paths.globalRoot, "config.json"), join(root, ".spider/config.json")];
  const before = files.map(file => readFileSync(file, "utf8"));
  expect(applyConfigEdit(root, key, "[]", scope)).toMatchObject({ ok: false, error: expect.stringMatching(/user/i) });
  expect(applyConfigUnset(root, key, scope)).toMatchObject({ ok: false, error: expect.stringMatching(/user/i) });
  expect(files.map(file => readFileSync(file, "utf8"))).toEqual(before);
});

it.each([null, "write", [false], [""], ["write,edit"], [" write"]])("blocks malformed global profiles %j but permits repair actions", value => {
  config("global", value);
  expect(() => actionCtx()).toThrow(/excludeTools/);
  expect(() => actionCtx("control")).not.toThrow();
  expect(configValues(root).errors.join("\n")).toMatch(/invalid.*excludeTools/);
  expect(() => controlConfig("set", root, key, value, "global")).toThrow(/tool/i);
});

it("accepts tool selectors and empty user overrides in the config schema", () => {
  const field = getField(key);
  expect(field).toBeDefined();
  expect(coerce(field!, '["edit","mcp__*"]')).toMatchObject({ ok: true, value: ["edit", "mcp__*"] });
  expect(coerce(field!, '[]')).toMatchObject({ ok: true, value: [] });
  expect(coerce(field!, '["write,edit"]')).toMatchObject({ ok: false });
});

it("allows an explicit empty global profile and resets to defaults on unset", () => {
  controlConfig("set", root, key, [], "global");
  expect(controlConfig("get", root, key)).toEqual([]);
  controlConfig("unset", root, key, undefined, "global");
  expect(controlConfig("get", root, key)).toEqual(["edit", "write"]);
  expect(() => controlConfig("set", root, key, [])).toThrow(/global.only/i);
});
