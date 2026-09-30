import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { openDbAt } from "@spider/db-core";
import { join, resolve } from "node:path";
import * as subagents from "../index";
import { buildChildSpawnSpec } from "../pi-args";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(disabled: boolean) {
  const scratch = resolve(".spider/scratch/rpc-intercom"); mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const agent = join(root, "agent"), pkg = join(root, "intercom-package"); mkdirSync(agent); mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["entry.ts"] } })); writeFileSync(join(pkg, "entry.ts"), "export default function() {}");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [{ source: pkg, ...(disabled ? { extensions: [] } : {}) }] }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  expect(typeof (subagents as any).resolveChildIntercom).toBe("function");
  return { root, entry: join(pkg, "entry.ts"), extensions: await (subagents as any).resolveChildIntercom(root) };
}
it("resolves enabled installed intercom manifest paths without installing a package", async () => {
  const f = await fixture(false); expect(f.extensions).toEqual([f.entry]);
});
it("does not load disabled intercom extension resources", async () => { expect((await fixture(true)).extensions).toEqual([]); });
it("does not resolve installed packages when the Runner itself is replaced", async () => {
  const f = await fixture(false);
  const unusedAgentDir = join(f.root, "unused-agent-dir"); vi.stubEnv("PI_CODING_AGENT_DIR", unusedAgentDir);
  const db = openDbAt(join(f.root, "runs.db"), "worktree");
  try {
    const handler = subagents.makeRunHandler({ makeRunner: () => ({ runAsync: () => ({ id: "fake", agent: "worker", name: "fake", status: "running" }) }) });
    await handler({ agent: "worker", task: "work" }, { db, sessionId: "owner", cwd: f.root, runDbPath: join(f.root, "runs.db") });
    expect(existsSync(unusedAgentDir)).toBe(false);
  } finally { subagents.teardownAll(); db.close(); }
});

it("loads intercom alongside spider and overrides inherited stable identity", async () => {
  const f = await fixture(false); vi.stubEnv("PI_INTERCOM_STABLE_ID", "parent-stable"); vi.stubEnv("PI_INTERCOM_SESSION_ID", "parent-broker-id");
  const spec = buildChildSpawnSpec({ runId: "run-unique", sessionId: "parent", agent: "worker", task: "trivial", context: "fresh", parentSessionId: "parent", childIndex: 0, scratchRoot: f.root, dbPath: join(f.root, "db"), childExtensionPath: "spider.ts", intercomExtensions: f.extensions, orchestratorTarget: "parent-broker-id" });
  expect(spec.argv).toContain(f.entry);
  expect(spec.env.PI_INTERCOM_STABLE_ID).toBe("spider-run-unique");
  expect(spec.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID).toBe("parent-broker-id");
  expect(spec.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR).toBe("");
});
