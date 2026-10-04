import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { makeGlobalMemDb, makeMemDb } from "./helpers/tmpdb";
import { reviewedWrite, reviewerContext, parseVerdict } from "../reviewed-write";
import { stageWrite, rejectPending, forgetMemory } from "../staging";
import { getMemory, searchMemoryFts } from "../store";
import { MemoryOverflowError } from "../overflow";
import { activeCharTotal, listActive } from "../internal";

let repo: ReturnType<typeof makeMemDb>;
let global: ReturnType<typeof makeGlobalMemDb>;
afterEach(() => { repo?.cleanup(); global?.cleanup(); });
const fact = { category: "convention" as const, content: "Use reproducible build flags for package builds", source: "user" as const };
const justification = "Build flags remain relevant next month; other agents reuse the build steps; this is repo-specific.";
function setup() { repo = makeMemDb(); global = makeGlobalMemDb(); return { repo: repo.db, global: global.db }; }
function write(verdict: unknown, scope: "repo" | "global" = "repo") {
  return reviewedWrite(setup(), scope, fact, justification, { reviewer: vi.fn(async () => verdict), timeoutMs: 100 });
}

describe("reviewed remember", () => {
  it.each(["repo", "global"] as const)("user remember stores justification in the %s active row", async scope => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, scope, fact, justification, { reviewer: async () => ({ verdict: "new", reason: "durable" }) });
    expect(result.status).toBe("active");
    expect(getMemory(dbs[scope], scope, result.uuid!)).toMatchObject({ status: "active", justification });
  });
  it.each(["repo", "global"] as const)("auto remember stores justification in the %s staged row", async scope => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, scope, { ...fact, source: "auto" }, justification, { reviewer: async () => ({ verdict: "new", reason: "durable" }) });
    expect(result.status).toBe("staged");
    expect(getMemory(dbs[scope], scope, result.uuid!)).toMatchObject({ status: "staged", justification });
  });
  it("new stores an active record with searchable FTS and the review reason", async () => {
    const result = await write({ verdict: "new", reason: "useful after this session" });
    expect(result).toMatchObject({ status: "active", verdict: "new", reason: "useful after this session", scope: "repo" });
    expect(getMemory(repo.db, "repo", result.uuid!)?.status).toBe("active");
    expect(searchMemoryFts(repo.db, "repo", "reproducible").map(r => r.uuid)).toContain(result.uuid);
  });
  it("already_present returns the active uuid and does not insert", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "Use reproducible build flags for builds" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "already_present", existing_uuid: old.uuid, reason: "same instruction" }) });
    expect(result).toMatchObject({ verdict: "already_present", uuid: old.uuid, reason: "same instruction" });
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
  });
  it("supersedes archives via FTS-aware path and inserts a searchable active entry", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "Use outdated build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "new toolchain" }) });
    expect(result).toMatchObject({ status: "active", verdict: "supersedes", archived: [old.uuid] });
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("archived");
    expect(searchMemoryFts(dbs.repo, "repo", "outdated")).toEqual([]);
    expect(searchMemoryFts(dbs.repo, "repo", "reproducible").map(r => r.uuid)).toContain(result.uuid);
    expect(getMemory(dbs.repo, "repo", result.uuid!)).toMatchObject({ justification });
  });
  it("supersession overflow preserves active entries and does not double the not-stored prefix", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible flags" });
    const filler = stageWrite(dbs.repo, "repo", { ...fact, content: "x".repeat(7900) });
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "reproducible flags " + "y".repeat(470) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "updated flags" }),
    });
    expect(result.status).toBe("rejected");
    expect(result.message!.match(/not stored:/gi)).toHaveLength(1);
    expect(result.message).toContain("repo memory is full (7,922 of 8,000 chars used)");
    expect(result.message).toContain(`${old.uuid} · 22 chars`);
    expect(result.message).toContain("[would be replaced]");
    expect(result.message).toContain("Active entries (2, largest first");
    expect(result.message).toContain("nothing written");
    expect(result.archived).toEqual([]);
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(getMemory(dbs.repo, "repo", filler.uuid!)?.status).toBe("active");
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 2 });
  });

  it.each(["repo", "global"] as const)("credits a 470-char %s replacement at 7,465/8,000", async scope => {
    const dbs = setup();
    const old = stageWrite(dbs[scope], scope, { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs[scope], scope, { ...fact, content: "x".repeat(6995) });
    expect(activeCharTotal(dbs[scope], scope)).toBe(7465);
    const result = await reviewedWrite(dbs, scope, { ...fact, content: "reproducible " + "b".repeat(524) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "updated instruction" }),
    });
    expect(result).toMatchObject({ status: "active", archived: [old.uuid] });
    expect(activeCharTotal(dbs[scope], scope)).toBe(7532);
    expect(getMemory(dbs[scope], scope, old.uuid!)?.status).toBe("archived");
  });
  it.each(["repo", "global"] as const)("lists all 19 active %s entries and credits the target on rejected supersession", async scope => {
    const dbs = setup();
    const old = stageWrite(dbs[scope], scope, { ...fact, content: "reproducible " + "a".repeat(457) });
    const fillers = Array.from({ length: 18 }, (_, i) => stageWrite(dbs[scope], scope, {
      ...fact, content: `${i}:`.padEnd(i === 17 ? 399 : 388, "x"),
    }));
    const result = await reviewedWrite(dbs, scope, { ...fact, content: "reproducible " + "b".repeat(993) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "expanded instruction" }),
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain(`${scope} memory is full (7,465 of 8,000 chars used)`);
    expect(result.message).toContain("free at least 1.");
    expect(result.message).toContain("Replacement credit: 470 chars; projected usage: 8,001 of 8,000 chars.");
    const rows = result.message.split("\n").filter(line => line.startsWith("- "));
    expect(rows).toHaveLength(19);
    expect(result.message).toContain("Active entries (19, largest first");
    expect(rows.find(line => line.includes(old.uuid!))).toContain("[would be replaced]");
    for (const entry of fillers) expect(result.message).toContain(entry.uuid!);
    expect(activeCharTotal(dbs[scope], scope)).toBe(7465);
    expect(listActive(dbs[scope], scope)).toHaveLength(19);
    expect(getMemory(dbs[scope], scope, old.uuid!)?.status).toBe("active");
  });
  it("credits every final same-scope reviewer target, but not related cross-scope targets", async () => {
    const dbs = setup();
    const first = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "a".repeat(457) });
    const second = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "c".repeat(87) });
    const cross = stageWrite(dbs.global, "global", { ...fact, content: "reproducible " + "g".repeat(687) });
    stageWrite(dbs.repo, "repo", { ...fact, content: "x".repeat(6895) });
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "reproducible " + "b".repeat(1093) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [first.uuid, second.uuid, cross.uuid], reason: "final targets" }),
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Replacement credit: 570 chars; projected usage: 8,001 of 8,000 chars.");
    expect(result.message).toContain("free at least 1.");
    expect(result.message).not.toContain(cross.uuid!);
    expect(listActive(dbs.repo, "repo")).toHaveLength(3);
    expect(getMemory(dbs.global, "global", cross.uuid!)?.status).toBe("active");
  });
  it.each(["repo", "global"] as const)("does not credit a cross-scope replacement against %s usage", async scope => {
    const dbs = setup();
    const other = scope === "repo" ? "global" : "repo";
    const cross = stageWrite(dbs[other], other, { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs[scope], scope, { ...fact, content: "x".repeat(7465) });
    const result = await reviewedWrite(dbs, scope, { ...fact, content: "reproducible " + "b".repeat(524) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [cross.uuid], reason: "related elsewhere" }),
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("free at least 2.");
    expect(result.message).not.toContain("Replacement credit");
    expect(activeCharTotal(dbs[scope], scope)).toBe(7465);
    expect(getMemory(dbs[other], other, cross.uuid!)?.status).toBe("active");
  });
  it("uses the final reviewer scope without crediting source-scope entries", async () => {
    const dbs = setup();
    const source = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs.global, "global", { ...fact, content: "x".repeat(7465) });
    const pending = reviewedWrite(dbs, "repo", { ...fact, content: "reproducible " + "b".repeat(524) }, justification, {
      reviewer: async () => ({ verdict: "wrong_scope", scope: "global", reason: "global instruction" }),
    });
    await expect(pending).rejects.toThrow("redirected from repo to global; global memory is full (7,465 of 8,000 chars used)");
    await expect(pending).rejects.toThrow("free at least 2.");
    expect(getMemory(dbs.repo, "repo", source.uuid!)?.status).toBe("active");
  });
  it("does not credit pending automatic supersessions against active usage", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs.repo, "repo", { ...fact, content: "x".repeat(7530) });
    const result = await reviewedWrite(dbs, "repo", { ...fact, source: "auto" }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "pending update" }),
    });
    expect(result).toMatchObject({ status: "staged", archived: [], pendingSupersedes: [old.uuid] });
    expect(activeCharTotal(dbs.repo, "repo")).toBe(8000);
  });

  it("uses current target sizes rather than the reviewer's cached content", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.global, "global", { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs.global, "global", { ...fact, content: "x".repeat(6995) });
    const result = await reviewedWrite(dbs, "global", { ...fact, content: "reproducible " + "b".repeat(993) }, justification, {
      reviewer: async () => {
        dbs.global.prepare("UPDATE global_memory SET content = ? WHERE uuid = ?").run("a".repeat(50), old.uuid);
        return { verdict: "supersedes", supersedes: [old.uuid], reason: "updated target" };
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("global memory is full (7,045 of 8,000 chars used)");
    expect(result.message).toContain("Replacement credit: 50 chars; projected usage: 8,001 of 8,000 chars.");
    expect(activeCharTotal(dbs.global, "global")).toBe(7045);
    expect(getMemory(dbs.global, "global", old.uuid!)?.status).toBe("active");
  });
  it("accepts a replacement that reaches the cap exactly after credit", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.global, "global", { ...fact, content: "reproducible " + "a".repeat(457) });
    stageWrite(dbs.global, "global", { ...fact, content: "x".repeat(6995) });
    const result = await reviewedWrite(dbs, "global", { ...fact, content: "reproducible " + "b".repeat(992) }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "expanded instruction" }),
    });
    expect(result).toMatchObject({ status: "active", archived: [old.uuid] });
    expect(activeCharTotal(dbs.global, "global")).toBe(8000);
  });
  it.each(["repo", "global"] as const)("checks %s replacement credit against a concurrent writer's committed usage", async scope => {
    const dbs = setup();
    const old = stageWrite(dbs[scope], scope, { ...fact, content: "reproducible " + "a".repeat(457) });
    const filler = stageWrite(dbs[scope], scope, { ...fact, content: "x".repeat(6995) });
    const table = scope === "repo" ? "memory" : "global_memory";
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const Sqlite = require('better-sqlite3'); const db = new Sqlite(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE " + workerData.table + " SET content = ? WHERE uuid = ?").run('x'.repeat(7464), workerData.uuid);
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`,
      { eval: true, workerData: { path: dbs[scope].raw.name, table, uuid: filler.uuid } });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve()); worker.once("error", reject);
      });
      const result = await reviewedWrite(dbs, scope, { ...fact, content: "reproducible " + "b".repeat(524) }, justification, {
        reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "updated instruction" }),
      });
      expect(result.status).toBe("rejected");
      expect(result.archived).toEqual([]);
      expect(result.message).toContain(`${scope} memory is full (7,934 of 8,000 chars used)`);
      expect(result.message).toContain("Replacement credit: 470 chars; projected usage: 8,001 of 8,000 chars.");
      expect(activeCharTotal(dbs[scope], scope)).toBe(7934);
      expect(getMemory(dbs[scope], scope, old.uuid!)?.status).toBe("active");
      expect(listActive(dbs[scope], scope)).toHaveLength(2);
    } finally { await worker.terminate(); }
  }, 10000);

  it("does not archive superseded entries if insertion loses a duplicate race", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "outdated reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => {
      stageWrite(dbs.repo, "repo", fact);
      return { verdict: "supersedes", supersedes: [old.uuid], reason: "replaced" };
    } });
    expect(result.message).toBe("not stored: duplicate");
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
  });
  it("wrong_scope writes into the other table and reports both scopes", async () => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "wrong_scope", scope: "global", reason: "true everywhere" }) });
    expect(result).toMatchObject({ verdict: "wrong_scope", requestedScope: "repo", scope: "global", reason: "true everywhere" });
    expect(getMemory(dbs.global, "global", result.uuid!)).toMatchObject({ status: "active", justification });
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 0 });
  });
  it.each(["repo", "global"] as const)("names the redirect and full target when requested %s storage overflows", async requestedScope => {
    const dbs = setup();
    const target = requestedScope === "repo" ? "global" : "repo";
    stageWrite(dbs[target], target, { ...fact, content: "x".repeat(8000) });
    const pending = reviewedWrite(dbs, requestedScope, fact, justification, {
      reviewer: async () => ({ verdict: "wrong_scope", scope: target, reason: "belongs in target" }),
    });
    await expect(pending).rejects.toBeInstanceOf(MemoryOverflowError);
    await expect(pending).rejects.toThrow(`Not stored: redirected from ${requestedScope} to ${target}; ${target} memory is full (8,000 of 8,000 chars used)`);
    await expect(pending).rejects.toThrow(`sub=forget uuid=<uuid> scope=${target}`);
    expect(listActive(dbs[requestedScope], requestedScope)).toHaveLength(0);
    expect(listActive(dbs[target], target)).toHaveLength(1);
    expect(activeCharTotal(dbs[target], target)).toBe(8000);
  });
  it("wrong_scope does not claim storage if destination has an exact duplicate", async () => {
    const dbs = setup();
    const existing = stageWrite(dbs.global, "global", fact);
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "wrong_scope", scope: "global", reason: "true everywhere" }) });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("not stored: redirected to global, which already has it");
    expect(dbs.global.prepare("SELECT count(*) n FROM global_memory").get()).toMatchObject({ n: 1 });
    expect(getMemory(dbs.global, "global", existing.uuid!)?.status).toBe("active");
  });
  it("not_durable writes no row and says to keep it in the conversation", async () => {
    const result = await write({ verdict: "not_durable", reason: "only today's run" });
    expect(result).toMatchObject({ verdict: "not_durable", reason: "only today's run" });
    expect(result.message).toBe("not stored: not durable enough for memory, keep it in the conversation (only today's run)");
    expect(repo.db.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 0 });
  });
  it.each([
    ["throw", async () => { throw Error("service down"); }, /service down/],
    ["bad JSON", async () => "not-json", /invalid.*JSON|JSON/i],
    ["unknown existing uuid", async () => ({ verdict: "already_present", existing_uuid: "fabricated", reason: "wrong" }), /unknown.*uuid/i],
    ["unknown superseded uuid", async () => ({ verdict: "supersedes", supersedes: ["fabricated"], reason: "wrong" }), /unknown.*uuid/i],
    ["invalid shape", async () => ({ verdict: "new" }), /reason/i],
  ])("review %s skips and stores as requested", async (_name, reviewer, reason) => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer });
    expect(result).toMatchObject({ status: "active", scope: "repo" });
    expect(result.message).toMatch(/review skipped:/);
    expect(result.message).toMatch(reason);
    expect(getMemory(dbs.repo, "repo", result.uuid!)).toMatchObject({ status: "active" });
  });
  it("timeout does not wait forever and stores as requested", async () => {
    const dbs = setup();
    vi.useFakeTimers();
    const pending = reviewedWrite(dbs, "repo", fact, justification, { reviewer: () => new Promise(() => {}), timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    vi.useRealTimers();
    expect(result.message).toContain("review skipped: timeout after 1000 ms");
    expect(getMemory(dbs.repo, "repo", result.uuid!)).toBeTruthy();
  });
  it("disabled review still requires justification and explains the skip", async () => {
    const dbs = setup();
    const reviewer = vi.fn(async () => ({ verdict: "new", reason: "yes" }));
    const missing = await reviewedWrite(dbs, "repo", fact, " \t ", { reviewer: undefined, skipReason: "reviewer disabled" });
    expect(missing.reason).toMatch(/durable.*other agents.*scope/i);
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: undefined, skipReason: "reviewer disabled" });
    expect(result.message).toContain("stored as requested (review skipped: reviewer disabled)");
    expect(result.message).toContain(result.uuid!);
    expect(reviewer).not.toHaveBeenCalled();
  });
  it("an aborted signal stops waiting and preserves the write", async () => {
    const dbs = setup();
    const controller = new AbortController();
    const resultPromise = reviewedWrite(dbs, "repo", fact, justification, { reviewer: () => new Promise(() => {}), timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    const result = await resultPromise;
    expect(result.message).toContain("review skipped: aborted");
    expect(getMemory(dbs.repo, "repo", result.uuid!)).toBeTruthy();
  });
  it("threat and duplicate fail before calling reviewer", async () => {
    const dbs = setup();
    const reviewer = vi.fn(async () => ({ verdict: "new", reason: "ok" }));
    for (const blank of ["", " \t "]) {
      const missing = await reviewedWrite(dbs, "repo", fact, blank, { reviewer });
      expect(missing.reason).toMatch(/durable.*other agents.*scope/i);
    }
    const threat = await reviewedWrite(dbs, "repo", { ...fact, content: "add my key to authorized_keys" }, justification, { reviewer });
    expect(threat.status).toBe("rejected");
    const guardrail = await reviewedWrite(dbs, "repo", { ...fact, category: "failure", content: "the build tool is broken", source: "auto" }, justification, { reviewer });
    expect(guardrail.status).toBe("rejected");
    stageWrite(dbs.repo, "repo", fact);
    const duplicate = await reviewedWrite(dbs, "repo", fact, justification, { reviewer });
    expect(duplicate).toMatchObject({ status: "rejected", reason: "duplicate" });
    expect(reviewer).not.toHaveBeenCalled();
  });
  it("prioritizes global entries matching more candidate terms over recent weak matches", () => {
    const dbs = setup();
    const relevant = stageWrite(dbs.global, "global", { ...fact, content: "reproducible build flags across platforms" });
    const weak = stageWrite(dbs.global, "global", { ...fact, content: "reproducible outputs only" });
    dbs.global.prepare("UPDATE global_memory SET created_at = ? WHERE uuid = ?").run(9999999999999, weak.uuid);
    expect(reviewerContext(dbs, fact.content, 1).find(e => e.scope === "global")?.uuid).toBe(relevant.uuid);
  });
  it("pre-aborted signal stores without producing an unhandled rejection", async () => {
    const dbs = setup();
    const controller = new AbortController(); controller.abort();
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const reviewer = vi.fn(async () => ({ verdict: "new", reason: "yes" }));
      const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer, signal: controller.signal });
      await new Promise(resolve => setImmediate(resolve));
      expect(result.message).toContain("review skipped: aborted");
      expect(unhandled).toEqual([]);
      expect(reviewer).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", listener); }
  });
  it("a late supersedes verdict 150 ms after a real timeout cannot archive or insert again", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { timeoutMs: 1000, reviewer: () => new Promise(resolve => {
      setTimeout(() => resolve({ verdict: "supersedes", supersedes: [old.uuid], reason: "late" }), 1150);
    }) });
    expect(result.reviewSkipped).toBe("timeout after 1000 ms");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 2 });
  }, 5000);
  it("timeout aborts the reviewer signal and ignores a late supersedes verdict", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    let signal: AbortSignal | undefined;
    let resolveReview!: (value: unknown) => void;
    const reviewer = (_candidate: unknown, _context: unknown, reviewSignal?: AbortSignal) => {
      signal = reviewSignal;
      return new Promise<unknown>(resolve => { resolveReview = resolve; });
    };
    vi.useFakeTimers();
    try {
      const pending = reviewedWrite(dbs, "repo", fact, justification, { reviewer, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.reviewSkipped).toBe("timeout after 1000 ms");
      expect(signal?.aborted).toBe(true);
      resolveReview({ verdict: "supersedes", supersedes: [old.uuid], reason: "late" });
      await Promise.resolve();
      expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
      expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 2 });
    } finally { vi.useRealTimers(); }
  });
  it.each(["timeout", "aborted"])("an abort-listener reviewer rejection cannot mask %s", async cause => {
    const dbs = setup();
    const controller = new AbortController();
    if (cause === "timeout") vi.useFakeTimers();
    const pending = reviewedWrite(dbs, "repo", fact, justification, { timeoutMs: 1000, signal: controller.signal,
      reviewer: (_c, _e, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("model call aborted")), { once: true });
      }),
    });
    try {
      if (cause === "timeout") await vi.advanceTimersByTimeAsync(1000);
      else controller.abort();
      expect((await pending).reviewSkipped).toBe(cause === "timeout" ? "timeout after 1000 ms" : "aborted");
    } finally { vi.useRealTimers(); }
  });
  it("caller abort also aborts the injected reviewer signal", async () => {
    const dbs = setup(); const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = reviewedWrite(dbs, "repo", fact, justification, { signal: controller.signal, reviewer: async (_c, _e, s) => {
      signal = s; return new Promise(() => {});
    } });
    controller.abort();
    expect((await pending).reviewSkipped).toBe("aborted");
    expect(signal?.aborted).toBe(true);
  });
  it("supersedes rolls back both insert and archive when archiving fails", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    dbs.repo.exec(`CREATE TRIGGER deny_archive BEFORE UPDATE OF status ON memory
      WHEN NEW.status = 'archived' BEGIN SELECT RAISE(ABORT, 'archive blocked'); END`);
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "newer" }) });
    expect(result.message).toMatch(/not stored.*nothing written.*archive blocked/);
    expect(result.archived).toEqual([]);
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(searchMemoryFts(dbs.repo, "repo", "old").map(e => e.uuid)).toContain(old.uuid);
  });
  it("does not archive other-scope entries and reports their full uuid", async () => {
    const dbs = setup();
    const cross = stageWrite(dbs.global, "global", { ...fact, content: "old reproducible build flags global" });
    const local = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags repo" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "supersedes", supersedes: [cross.uuid, local.uuid], reason: "newer" }) });
    expect(result.archived).toEqual([local.uuid]);
    expect(result.message).toContain(`related entry in global scope, not archived: ${cross.uuid}`);
    expect(result.message).toContain(local.uuid!);
    expect(result.message).toContain(result.uuid!);
    expect(getMemory(dbs.global, "global", cross.uuid!)?.status).toBe("active");
  });
  it("staged supersedes reports related entries without promising archives; active memory stays unchanged", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", { ...fact, source: "auto" }, justification, { reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "newer" }) });
    expect(result.status).toBe("staged");
    expect(result.message).toContain(`staged for approval as ${result.uuid}`);
    expect(result.message).toContain(`related entries, not archived: ${old.uuid}`);
    expect(result.message).toContain("approval does not archive");
    expect(result.archived).toEqual([]);
    expect(result.pendingSupersedes).toEqual([old.uuid]);
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(getMemory(dbs.repo, "repo", result.uuid!)).toMatchObject({ status: "staged", justification });
  });
  it("stale supersedes citation skips review and stores as requested", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => {
      forgetMemory(dbs.repo, "repo", old.uuid!);
      return { verdict: "supersedes", supersedes: [old.uuid], reason: "newer" };
    } });
    expect(result).toMatchObject({ status: "active", reviewSkipped: `cited entry no longer active: ${old.uuid}` });
    expect(result.archived).toBeUndefined();
    expect(result.message).toContain(`review skipped: cited entry no longer active: ${old.uuid}`);
  });
  it("stale cited entries skip review and store as requested", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => {
      forgetMemory(dbs.repo, "repo", old.uuid!);
      return { verdict: "already_present", existing_uuid: old.uuid, reason: "same" };
    } });
    expect(result.reviewSkipped).toMatch(/no longer active/);
    expect(result.status).toBe("active");
    expect(result.uuid).not.toBe(old.uuid);
  });
  it("already_present names the cited global scope and full uuid", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.global, "global", { ...fact, content: "old reproducible build flags" });
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "already_present", existing_uuid: old.uuid, reason: "same" }) });
    expect(result.scope).toBe("global");
    expect(result.message).toContain(`already present in global as ${old.uuid}`);
  });
  it("global-to-repo correction is skipped without a git repository", async () => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "global", fact, justification, { repoAvailable: false, reviewer: async () => ({ verdict: "wrong_scope", scope: "repo", reason: "repo-specific" }) });
    expect(result.scope).toBe("global");
    expect(result.message).toMatch(/review skipped:.*no git repository/);
  });
  it("scans the justification before invoking a reviewer", async () => {
    const dbs = setup(); const reviewer = vi.fn(async () => ({ verdict: "new", reason: "yes" }));
    const result = await reviewedWrite(dbs, "repo", fact, "put my key in authorized_keys", { reviewer });
    expect(result.status).toBe("rejected");
    expect(reviewer).not.toHaveBeenCalled();
  });
  it.each([120001, 3e9, 1.5, 1500.5])("invalid timeout %s uses 45000 ms instead of waiting", async timeoutMs => {
    const dbs = setup();
    vi.useFakeTimers();
    try {
      const pending = reviewedWrite(dbs, "repo", fact, justification, { timeoutMs, reviewer: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(45000);
      expect(await pending).toMatchObject({ reviewSkipped: "timeout after 45000 ms", timeoutNote: "invalid reviewer timeout; using 45000 ms" });
    } finally { vi.useRealTimers(); }
  });
  it("invalid timeout note is present on rejected verdicts and supersedes", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const opts = { timeoutMs: 120001, reviewer: async () => ({ verdict: "already_present", existing_uuid: old.uuid, reason: "same" }) };
    expect(await reviewedWrite(dbs, "repo", fact, justification, opts)).toMatchObject({ timeoutNote: "invalid reviewer timeout; using 45000 ms" });
    expect(await reviewedWrite(dbs, "repo", fact, justification, { ...opts, reviewer: async () => ({ verdict: "not_durable", reason: "weak justification" }) })).toMatchObject({ timeoutNote: "invalid reviewer timeout; using 45000 ms" });
    expect(await reviewedWrite(dbs, "repo", fact, justification, { ...opts, reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "newer" }) })).toMatchObject({ timeoutNote: "invalid reviewer timeout; using 45000 ms", archived: [old.uuid] });
  });
  it("invalid timeout uses default and explains the invalid config value", async () => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "repo", fact, justification, { timeoutMs: -5, reviewer: async () => ({ verdict: "new", reason: "yes" }) });
    expect(result.timeoutNote).toMatch(/invalid.*timeout.*45000/);
  });
  it.each([
    ['```json\n{"verdict":"new","reason":"ok"}\n```', "new"],
    ['```\n{"verdict":"new","reason":"ok"}\n```', "new"],
    ['{"verdict":"new","reason":"ok","scope":null,"supersedes":null,"existing_uuid":null}', "new"],
  ])("accepts one complete fence or unused null fields: %s", (raw, want) => {
    expect(parseVerdict(raw, [], "repo").verdict).toBe(want);
  });
  it("accepts the exact recorded repo reviewer reply and discards its redundant scope", () => {
    const raw = '{"verdict":"new","scope":"repo","reason":"This durable project-specific API contract can guide future agents using `spider exec`."}';
    expect(parseVerdict(raw, [], "repo")).toEqual({
      verdict: "new", reason: "This durable project-specific API contract can guide future agents using `spider exec`.",
    });
  });
  it("rejects the exact recorded repo reviewer reply for a global request", () => {
    const raw = '{"verdict":"new","scope":"repo","reason":"This durable project-specific API contract can guide future agents using `spider exec`."}';
    expect(() => parseVerdict(raw, [], "global")).toThrow();
  });
  it.each([
    { verdict: "already_present", existing_uuid: "known", reason: "same" },
    { verdict: "supersedes", supersedes: ["known"], reason: "newer" },
    { verdict: "not_durable", reason: "one-off" },
  ])("discards matching scope for $verdict", verdict => {
    const context = [{ uuid: "known", scope: "repo" as const, category: fact.category, content: "existing fact" }];
    expect(parseVerdict({ ...verdict, scope: "repo" }, context, "repo")).toEqual(verdict);
  });
  it("accepts and discards a redundant global scope", () => {
    expect(parseVerdict({ verdict: "new", reason: "durable", scope: "global" }, [], "global"))
      .toEqual({ verdict: "new", reason: "durable" });
  });
  it.each([1, true, [], {}])("rejects non-string redundant scope: %j", scope => {
    expect(() => parseVerdict({ verdict: "new", reason: "durable", scope }, [], "repo")).toThrow();
  });
  it.each(["repo", "global"] as const)("rejects mismatched scope for a %s request", requestedScope => {
    const scope = requestedScope === "repo" ? "global" : "repo";
    expect(() => parseVerdict({ verdict: "not_durable", reason: "one-off", scope }, [], requestedScope)).toThrow();
  });
  it.each([null, "extra"])("rejects an unknown extra key even with matching scope: %j", unknown => {
    expect(() => parseVerdict({ verdict: "new", reason: "durable", scope: "repo", unknown }, [], "repo")).toThrow();
  });
  it.each([
    '{"verdict":"new","reason":"ok","scope":"global"}',
    'prose before ```json\n{"verdict":"new","reason":"ok"}\n```',
    '```js\n{"verdict":"new","reason":"ok"}\n```',
    '{"verdict":"new","reason":"ok","unknown":null}',
    '{"verdict":"new","reason":"ok","supersedes":[]}',
    '{"verdict":"new","reason":"ok",}',
    'prose {"verdict":"new","reason":"ok"}',
    '{"verdict":"new","reason":"ok"} extra',
    '{"verdict":"New","reason":"ok"}',
    '{"verdict":"new","reason":"   "}',
    '{"verdict":"supersedes","reason":"ok","supersedes":[]}',
    '{"verdict":"wrong_scope","reason":"ok","scope":"repo"}',
    '```json\n{"verdict":"new","reason":"ok"}\n```\n```json\n{"verdict":"new","reason":"ok"}\n```',
  ])("rejects malformed verdict: %s", raw => {
    expect(() => parseVerdict(raw, [], "repo")).toThrow();
  });
  it.each([
    'prose before ```json\n{"verdict":"new","reason":"ok"}\n```',
    '```js\n{"verdict":"new","reason":"ok"}\n```',
    '{"verdict":"new","reason":"ok","unknown":null}',
    '{"verdict":"new","reason":"ok","supersedes":[]}',
  ])("malformed reviewer output %s skips review and stores as requested", async response => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => response });
    expect(result).toMatchObject({ status: "active", scope: "repo" });
    expect(result.message).toContain("review skipped:");
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
  });
  it("rejects repeated uuids even when each citation is in context", () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const context = [{ uuid: old.uuid!, scope: "repo" as const, category: fact.category, content: "old reproducible build flags" }];
    expect(() => parseVerdict({ verdict: "supersedes", supersedes: [old.uuid, old.uuid], reason: "newer" }, context, "repo")).toThrow();
  });
  it("ignores short and stopword tokens when matching global context", () => {
    const dbs = setup();
    const distracting = stageWrite(dbs.global, "global", { ...fact, content: "Decisions in specific contexts belong to maintainers" });
    const relevant = stageWrite(dbs.global, "global", { ...fact, content: "Docker builds must stay safe" });
    expect(reviewerContext(dbs, "Run CI in Docker to be safe", 1).find(e => e.scope === "global")?.uuid).toBe(relevant.uuid);
    expect(distracting.uuid).not.toBe(relevant.uuid);
  });
  it("builds bounded relevant context from active entries in both scopes only", () => {
    const dbs = setup();
    const add = (scope: "repo" | "global", content: string, source: "user" | "auto" = "user") => stageWrite(dbs[scope], scope, { ...fact, content, source });
    const repoActive = add("repo", "reproducible build flags with cache");
    const globalActive = add("global", "reproducible build flags on every system");
    add("repo", "reproducible build flags pending", "auto");
    const rejected = add("repo", "reproducible build flags rejected", "auto");
    rejectPending(dbs.repo, "repo", rejected.uuid!);
    add("global", "reproducible build flags pending global", "auto");
    const archived = add("global", "reproducible build flags archived");
    forgetMemory(dbs.global, "global", archived.uuid!);
    add("repo", "unrelated banana instruction");
    const entries = reviewerContext(dbs, fact.content);
    expect(entries.map(e => e.uuid)).toEqual([repoActive.uuid, globalActive.uuid]);
    expect(entries.map(e => [e.scope, e.category])).toEqual([["repo", "convention"], ["global", "convention"]]);
  });
  it("invalid memory category is rejected before review even when disabled", async () => {
    const dbs = setup();
    const reviewer = vi.fn(async () => ({ verdict: "new", reason: "ok" }));
    for (const options of [{ reviewer }, { reviewer: undefined }]) {
      const result = await reviewedWrite(dbs, "repo", { ...fact, category: "### injected heading" as any }, justification, options);
      expect(result).toMatchObject({ status: "rejected", reason: "invalid memory category: expected preference, convention, tool-quirk, failure, correction, insight" });
      expect(result.message).toContain("not stored: invalid memory category:");
    }
    expect(reviewer).not.toHaveBeenCalled();
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 0 });
    expect(await reviewedWrite(dbs, "repo", { ...fact, category: "invalid" as any }, justification,
      { reviewer, timeoutMs: 120001 })).toMatchObject({ timeoutNote: "invalid reviewer timeout; using 45000 ms" });
  });
  it("a supersedes transaction waits for a concurrent writer then archives and stores", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "old reproducible build flags" });
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const Sqlite = require('better-sqlite3'); const db = new Sqlite(workerData);
      db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, 150);`,
      { eval: true, workerData: dbs.repo.raw.name });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve()); worker.once("error", reject);
      });
      const result = await reviewedWrite(dbs, "repo", fact, justification, { reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "newer" }) });
      expect(result).toMatchObject({ status: "active", archived: [old.uuid] });
      expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("archived");
    } finally { await worker.terminate(); }
  }, 10000);
  it("limits active results independently in each scope when more than twelve match", () => {
    const dbs = setup();
    for (let i = 0; i < 15; i++) {
      stageWrite(dbs.repo, "repo", { ...fact, content: `reproducible build option ${i}` });
      stageWrite(dbs.global, "global", { ...fact, content: `reproducible build setting ${i}` });
    }
    const entries = reviewerContext(dbs, "reproducible build");
    expect(entries.filter(e => e.scope === "repo")).toHaveLength(12);
    expect(entries.filter(e => e.scope === "global")).toHaveLength(12);
  });
});

// Unused null scope is tolerated just like null existing_uuid/supersedes.
it.each([
  { verdict: "new", reason: "durable" },
  { verdict: "not_durable", reason: "one task" },
  { verdict: "already_present", existing_uuid: "known", reason: "same fact" },
  { verdict: "supersedes", supersedes: ["known"], reason: "newer fact" },
])("accepts unused null scope for $verdict without weakening wrong_scope", verdict => {
  const context = [{ uuid: "known", scope: "repo" as const, category: fact.category, content: "existing fact" }];
  expect(parseVerdict({ ...verdict, scope: null }, context, "repo")).toEqual(verdict);
  expect(() => parseVerdict({ verdict: "wrong_scope", reason: "redirect", scope: null }, context, "repo")).toThrow(/scope/);
});
