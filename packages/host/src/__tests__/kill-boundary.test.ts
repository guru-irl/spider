import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, type Db } from "@spider/db-core";
import { testScratchPath } from "./testutil.js";
import { RunStore, makeKillHandler } from "@spider/subagents";
import { renderKillResult } from "@spider/ui";

function freshDb(): Db {
  return openDbAt(join(testScratchPath(".spider-test"), `kill-boundary-${randomUUID()}.db`), "project");
}

// Identity theme to get raw glyphs
const identityTheme = {
  fg: (_t: string, s: string) => s,
  bg: (_t: string, s: string) => s,
  bold: (s: string) => s,
  glyph: "🕸",
};
const ctx = { theme: identityTheme, width: 80 } as any;

describe("kill handler → renderer boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders ALL runs when partial failure occurs (some killed, one throws)", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    
    // Seed 3 runs
    const alpha = store.create({ sessionId: "s1", agent: "worker", name: "alpha", task: "t" });
    const beta = store.create({ sessionId: "s1", agent: "worker", name: "beta", task: "t" });
    const gamma = store.create({ sessionId: "s1", agent: "worker", name: "gamma", task: "t" });
    store.start(alpha.id);
    store.start(beta.id);
    store.start(gamma.id);
    
    // Spy on prototype to affect the handler's internal store
    const spy = vi.spyOn(RunStore.prototype, "cancel").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    const rendered = renderKillResult(res.details as any, ctx).join("\n");

    // CRITICAL: All three run names must appear
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");

    // The error message must appear
    expect(rendered).toContain("kill(s) failed");

    // The fail glyph must appear (for the failed run)
    expect(rendered).toContain("✗");
    
    // At least one run must show failed outcome (not just in the error banner)
    // Check that there's a row with the ✗ glyph followed by outcome text
    const hasFailedOutcome = rendered.includes("✗") && 
      (rendered.includes("· failed") || rendered.match(/✗.*·.*failed/));
    expect(hasFailedOutcome).toBe(true);

    // The success/warn glyph must appear (for successful runs)
    expect(rendered).toMatch(/✓|⚠/);

    // The failure cause must appear
    expect(rendered).toContain("SQLITE_BUSY");
  });

  it("renders all successful kills with success glyphs", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    
    // Seed 2 runs
    const alpha = store.create({ sessionId: "s1", agent: "worker", name: "alpha", task: "t" });
    const beta = store.create({ sessionId: "s1", agent: "worker", name: "beta", task: "t" });
    store.start(alpha.id);
    store.start(beta.id);
    
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    const rendered = renderKillResult(res.details as any, ctx).join("\n");

    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toMatch(/✓|⚠/);
    expect(rendered).not.toContain("✗");
  });

  it("renders resolution failure (unknown id) with error only", async () => {
    const db = freshDb();
    
    const handler = makeKillHandler();
    const res = await handler({ id: "ghost" }, { db, sessionId: "s1" });
    const rendered = renderKillResult(res.details as any, ctx).join("\n");

    expect(rendered).toContain("ghost");
    expect(rendered).toContain("✗");
    expect(rendered).toContain("no active run");
  });
});
