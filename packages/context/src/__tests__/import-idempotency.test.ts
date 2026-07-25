import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "@spider/db-core";
import { makeContentDb } from "./helpers/tmpdb";
import { importSessions } from "../import";

let cx: ReturnType<typeof makeContentDb>;
let f = "";

afterEach(() => {
  cx?.cleanup();
  try {
    if (f) rmSync(f);
  } catch {
    // ignore
  }
});

const digest = async () => ({
  candidates: [{ kind: "memory" as const, category: "convention", content: "prefer vitest" }],
  summary: "s",
});

function mkctx() {
  cx = makeContentDb();
  return { db: cx.db, repoDb: cx.repoDb, cwd: process.cwd(), sessionId: "cur" };
}

describe("importSessions idempotency", () => {
  it("stages candidates on first import and skips on re-import (no dupes)", async () => {
    const ctx = mkctx();
    const dir = paths.scratch("project", process.cwd());
    mkdirSync(dir, { recursive: true });
    f = join(dir, `imp-${randomUUID()}.jsonl`);
    writeFileSync(f, JSON.stringify({ role: "user", content: "we prefer vitest" }));

    const first = await importSessions(ctx, { session: f }, digest);
    expect(first.imported).toBe(1);
    expect(first.staged).toBeGreaterThan(0);

    const memCount = () => (ctx.repoDb.prepare("SELECT COUNT(*) n FROM memory WHERE source='import'").get() as any).n;
    expect(memCount()).toBe(1);
    expect((ctx.repoDb.prepare("SELECT status FROM memory WHERE source='import'").get() as any).status).toBe("staged");

    const second = await importSessions(ctx, { session: f }, digest);
    expect(second.skipped).toBe(1);
    expect(memCount()).toBe(1);
  });

  it("commit:true activates candidates for a single trusted import", async () => {
    const ctx = mkctx();
    const dir = paths.scratch("project", process.cwd());
    mkdirSync(dir, { recursive: true });
    f = join(dir, `imp2-${randomUUID()}.jsonl`);
    writeFileSync(f, JSON.stringify({ role: "user", content: "hi" }));

    await importSessions(ctx, { session: f, commit: true }, digest);
    expect((ctx.repoDb.prepare("SELECT status FROM memory WHERE source='import'").get() as any).status).toBe("active");
  });
});
