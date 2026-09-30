import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { DEFAULTS, controlConfig } from "../control";
import { buildActionCtx } from "../extension";
import { getField, coerce } from "@spider/ui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
it("defaults new child launches to RPC and validates print rollback", () => {
  const scratch = resolve(".spider/scratch/rpc-config"); mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, "case-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    expect(DEFAULTS["subagents.childMode"]).toBe("rpc");
    expect(controlConfig("get", root, "subagents.childMode")).toBe("rpc");
    controlConfig("set", root, "subagents.childMode", "print");
    expect(controlConfig("get", root, "subagents.childMode")).toBe("print");
    expect(() => controlConfig("set", root, "subagents.childMode", "bogus")).toThrow(/rpc|print/);
    expect(coerce(getField("subagents.childMode")!, "print")).toEqual({ ok: true, value: "print" });
    expect(coerce(getField("subagents.childMode")!, "bogus").ok).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("allows repairing a malformed child mode without allowing a run to launch", () => {
  const scratch = resolve(".spider/scratch/rpc-config"); mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, "repair-"));
  let ctx: ReturnType<typeof buildActionCtx> | undefined;
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".spider")); writeFileSync(join(root, ".spider", "config.json"), JSON.stringify({ "subagents.childMode": "bogus" }));
    expect(() => { ctx = buildActionCtx({} as never, { action: "control", command: "config", op: "set" }, "repair-owner", root); }).not.toThrow();
    expect(() => buildActionCtx({} as never, { action: "run", task: "work" }, "repair-owner", root)).toThrow(/rpc|print/);
    controlConfig("set", root, "subagents.childMode", "print");
    expect(controlConfig("get", root, "subagents.childMode")).toBe("print");
  } finally {
    if (ctx) for (const db of new Set([ctx.db, ctx.repoDb, ctx.globalDb])) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
