import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { makeGlobalMemDb, makeMemDb } from "./helpers/tmpdb";
import { reviewedWrite } from "../reviewed-write";
import { approvePending, forgetMemory, stageWrite } from "../staging";
import { getMemory, searchMemoryFts } from "../store";
import { activeCharTotal, listActive } from "../internal";

let repo: ReturnType<typeof makeMemDb>;
let global: ReturnType<typeof makeGlobalMemDb>;
afterEach(() => { vi.useRealTimers(); repo?.cleanup(); global?.cleanup(); });
const fact = { category: "convention" as const, content: "Use reproducible build flags", source: "user" as const };
const justification = "Build flags remain useful next month; other agents reuse them; this is repo-specific.";
function setup() { repo = makeMemDb(); global = makeGlobalMemDb(); return { repo: repo.db, global: global.db }; }

describe("explicit remember supersedes", () => {
  it.each(["new", "timeout", "disabled"] as const)("replaces 470 with 537 global chars at 7,465/8,000 when review is %s", async mode => {
    const dbs = setup();
    // The target need not be discoverable in the reviewer's keyword window.
    const old = stageWrite(dbs.global, "global", { ...fact, content: "a".repeat(470) });
    stageWrite(dbs.global, "global", { ...fact, content: "x".repeat(6995) });
    if (mode === "timeout") vi.useFakeTimers();
    const pending = reviewedWrite(dbs, "global", { ...fact, content: "b".repeat(537) }, justification, {
      supersedes: [old.uuid!.slice(0, 8)], timeoutMs: 1000,
      reviewer: mode === "disabled" ? undefined : mode === "timeout" ? () => new Promise(() => {}) : async () => ({ verdict: "new", reason: "durable" }),
    });
    void pending.catch(() => {});
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ status: "active", archived: [old.uuid] });
    expect(result.message).toContain(`archived ${old.uuid}`);
    expect(getMemory(dbs.global, "global", old.uuid!)?.status).toBe("archived");
    expect(getMemory(dbs.global, "global", result.uuid!)?.content).toBe("b".repeat(537));
    expect(activeCharTotal(dbs.global, "global")).toBe(7532);
    if (mode === "timeout") expect(result.reviewSkipped).toBe("timeout after 1000 ms");
  });

  it.each(["unknown", "ambiguous", "inactive", "cross-scope", "malformed"] as const)("rejects %s explicit targets before review without writing or archiving", async kind => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const second = stageWrite(dbs.repo, "repo", { ...fact, content: "Use deterministic test flags" });
    const cross = stageWrite(dbs.global, "global", fact);
    let target = "unknown-id";
    if (kind === "ambiguous") {
      dbs.repo.prepare("UPDATE memory SET uuid = ? WHERE uuid = ?").run("ambiguous-one", old.uuid);
      dbs.repo.prepare("UPDATE memory SET uuid = ? WHERE uuid = ?").run("ambiguous-two", second.uuid);
      target = "ambiguous";
    } else if (kind === "inactive") { forgetMemory(dbs.repo, "repo", old.uuid!); target = old.uuid!; }
    else if (kind === "cross-scope") target = cross.uuid!;
    const before = listActive(dbs.repo, "repo").map(e => e.uuid);
    const reviewer = vi.fn(async () => ({ verdict: "new", reason: "durable" }));
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, {
      supersedes: kind === "malformed" ? "not-an-array" as any : [kind === "ambiguous" ? "ambiguous-two" : second.uuid!, target], reviewer,
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(kind === "cross-scope" ? /global.*scope|scope.*global/ : kind === "inactive" ? /not active/ : kind === "malformed" ? /list|array/ : kind === "unknown" ? /unknown memory UUID or prefix/ : /ambiguous UUID prefix/);
    expect(listActive(dbs.repo, "repo").map(e => e.uuid)).toEqual(before);
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 2 });
    expect(getMemory(dbs.global, "global", cross.uuid!)?.status).toBe("active");
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("lists UUIDs and statuses when an inactive entry makes a prefix ambiguous", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const other = stageWrite(dbs.repo, "repo", { ...fact, content: "Use deterministic test flags" });
    forgetMemory(dbs.repo, "repo", other.uuid!);
    dbs.repo.prepare("UPDATE memory SET uuid = ? WHERE uuid = ?").run("abcdef01-active", old.uuid);
    dbs.repo.prepare("UPDATE memory SET uuid = ? WHERE uuid = ?").run("abcdef02-archived", other.uuid);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, { supersedes: ["abcdef0"] });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("ambiguous UUID prefix");
    expect(result.message).toContain("abcdef01-active (active)");
    expect(result.message).toContain("abcdef02-archived (archived)");
    expect(listActive(dbs.repo, "repo")).toHaveLength(1);
  });

  it("resolves uppercase UUID prefixes and tells the reviewer which entries the caller replaces", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    dbs.repo.prepare("UPDATE memory SET uuid = ? WHERE uuid = ?").run("abcdef01-target", old.uuid);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use revised reproducible build flags" }, justification, {
      supersedes: ["ABCDEF01"], reviewer: async candidate => {
        // Missing resolved targets must prevent the revised fact from being accepted.
        return candidate.supersedes?.includes("abcdef01-target")
          ? { verdict: "new", reason: "caller replaces prior instruction" }
          : { verdict: "not_durable", reason: "replacement intent missing" };
      },
    });
    expect(result).toMatchObject({ status: "active", archived: ["abcdef01-target"] });
    expect(getMemory(dbs.repo, "repo", "abcdef01-target")?.status).toBe("archived");
  });

  it.each(["%", "_"])("treats %s as a literal UUID prefix, not a SQL wildcard", async ref => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, { supersedes: [ref] });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("unknown memory UUID or prefix");
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
  });

  it.each(["auto", "import"] as const)("treats an empty supersedes list as a no-op for staged %s writes", async source => {
    const dbs = setup();
    const result = await reviewedWrite(dbs, "repo", { ...fact, source }, justification, { supersedes: [] });
    expect(result.status).toBe("staged");
    expect(getMemory(dbs.repo, "repo", result.uuid!)?.status).toBe("staged");
  });

  it("passes resolved explicit targets even when they are outside the reviewer context window", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, {
      supersedes: [old.uuid!.slice(0, 8)], contextLimit: 0,
      reviewer: async candidate => candidate.supersedes?.includes(old.uuid!)
        ? { verdict: "new", reason: "replacement intent supplied" }
        : { verdict: "not_durable", reason: "replacement intent missing" },
    });
    expect(result).toMatchObject({ status: "active", archived: [old.uuid] });
  });

  it("unions and deduplicates explicit and reviewer targets for cap credit and FTS-aware archival", async () => {
    const dbs = setup();
    const first = stageWrite(dbs.repo, "repo", { ...fact, content: "a".repeat(470) });
    const second = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "c".repeat(87) });
    stageWrite(dbs.repo, "repo", { ...fact, content: "x".repeat(6895) });
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "reproducible " + "b".repeat(987) }, justification, {
      supersedes: [first.uuid!, first.uuid!.slice(0, 8), second.uuid!],
      reviewer: async () => ({ verdict: "supersedes", supersedes: [second.uuid], reason: "updated instruction" }),
    });
    expect(result.status).toBe("active");
    expect(result.archived).toEqual([first.uuid, second.uuid]);
    expect(activeCharTotal(dbs.repo, "repo")).toBe(7895);
    expect(getMemory(dbs.repo, "repo", first.uuid!)?.status).toBe("archived");
    expect(getMemory(dbs.repo, "repo", second.uuid!)?.status).toBe("archived");
    expect(searchMemoryFts(dbs.repo, "repo", "reproducible").map(e => e.uuid)).toEqual([result.uuid]);
  });

  it("credits a reviewer-added target alongside the explicit target", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", { ...fact, content: "a".repeat(470) });
    const extra = stageWrite(dbs.repo, "repo", { ...fact, content: "reproducible " + "c".repeat(87) });
    stageWrite(dbs.repo, "repo", { ...fact, content: "x".repeat(6895) });
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "reproducible " + "b".repeat(1092) }, justification, {
      supersedes: [old.uuid!], reviewer: async () => ({ verdict: "supersedes", supersedes: [extra.uuid], reason: "both replaced" }),
    });
    expect(result).toMatchObject({ status: "active", archived: [old.uuid, extra.uuid] });
    expect(activeCharTotal(dbs.repo, "repo")).toBe(8000);
  });

  it("rejects over-cap after credit with truthful usage and leaves every target active", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.global, "global", { ...fact, content: "a".repeat(470) });
    stageWrite(dbs.global, "global", { ...fact, content: "x".repeat(6995) });
    const result = await reviewedWrite(dbs, "global", { ...fact, content: "b".repeat(1006) }, justification, {
      supersedes: [old.uuid!], reviewer: async () => ({ verdict: "new", reason: "durable" }),
    });
    expect(result).toMatchObject({ status: "rejected", archived: [] });
    expect(result.message).toContain("global memory is full (7,465 of 8,000 chars used)");
    expect(result.message).toContain("Replacement credit: 470 chars; projected usage: 8,001 of 8,000 chars.");
    expect(result.message).toContain("free at least 1.");
    expect(result.message).toContain(`${old.uuid} · 470 chars · [would be replaced]`);
    expect(activeCharTotal(dbs.global, "global")).toBe(7465);
    expect(listActive(dbs.global, "global")).toHaveLength(2);
  });

  it.each(["not_durable", "already_present", "wrong_scope"] as const)("does not archive or write when review returns %s", async verdict => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use reproducible build flags consistently" }, justification, {
      supersedes: [old.uuid!], reviewer: async () => verdict === "already_present"
        ? { verdict, existing_uuid: old.uuid, reason: "same fact" }
        : verdict === "wrong_scope" ? { verdict, scope: "global", reason: "global fact" } : { verdict, reason: "task only" },
    });
    expect(result.status).toBe("rejected");
    if (verdict === "wrong_scope") expect(result.message).toContain("reviewer redirected to global scope, nothing written");
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(listActive(dbs.repo, "repo")).toHaveLength(1);
    expect(listActive(dbs.global, "global")).toHaveLength(0);
  });

  it.each(["auto", "import"] as const)("rejects explicit supersedes for staged %s writes without persisting intent", async source => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated reproducible build flags", source }, justification, { supersedes: [old.uuid!] });
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/supersedes.*not supported.*staged/);
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
  });

  it("staged reviewer supersession reports related entries and approval archives nothing", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated reproducible build flags", source: "auto" }, justification, {
      reviewer: async () => ({ verdict: "supersedes", supersedes: [old.uuid], reason: "newer" }),
    });
    expect(result.status).toBe("staged");
    expect(result.message).toContain("approval does not archive");
    expect(result.message).toContain(old.uuid!);
    expect(result.message).not.toContain("pending supersession");
    expect(approvePending(dbs.repo, "repo", result.uuid!)?.status).toBe("active");
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
  });

  it("rolls back explicit archives and FTS removal if insertion fails", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    dbs.repo.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON memory BEGIN SELECT RAISE(ABORT, 'insert blocked'); END");
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, { supersedes: [old.uuid!] });
    expect(result).toMatchObject({ status: "rejected", archived: [] });
    expect(result.message).toMatch(/nothing written.*insert blocked/);
    expect(getMemory(dbs.repo, "repo", old.uuid!)?.status).toBe("active");
    expect(searchMemoryFts(dbs.repo, "repo", "reproducible").map(e => e.uuid)).toEqual([old.uuid]);
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
  });

  it("rechecks explicit targets after reviewer latency without a fallback insertion", async () => {
    const dbs = setup();
    const old = stageWrite(dbs.repo, "repo", fact);
    const result = await reviewedWrite(dbs, "repo", { ...fact, content: "Use updated flags" }, justification, {
      supersedes: [old.uuid!], reviewer: async () => {
        forgetMemory(dbs.repo, "repo", old.uuid!);
        return { verdict: "new", reason: "durable" };
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/not active/);
    expect(dbs.repo.prepare("SELECT count(*) n FROM memory").get()).toMatchObject({ n: 1 });
  });

  it.each(["repo", "global"] as const)("checks explicit %s credit only after acquiring the concurrent writer's lock", async scope => {
    const dbs = setup();
    const old = stageWrite(dbs[scope], scope, { ...fact, content: "a".repeat(470) });
    const filler = stageWrite(dbs[scope], scope, { ...fact, content: "x".repeat(6995) });
    const table = scope === "repo" ? "memory" : "global_memory";
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const Sqlite = require('better-sqlite3'); const db = new Sqlite(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE ' + workerData.table + ' SET content = ? WHERE uuid = ?').run('x'.repeat(7464), workerData.uuid);
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`,
      { eval: true, workerData: { path: dbs[scope].raw.name, table, uuid: filler.uuid } });
    try {
      await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
      const result = await reviewedWrite(dbs, scope, { ...fact, content: "b".repeat(537) }, justification, { supersedes: [old.uuid!] });
      expect(result).toMatchObject({ status: "rejected", archived: [] });
      expect(result.message).toContain("Replacement credit: 470 chars; projected usage: 8,001 of 8,000 chars.");
      expect(activeCharTotal(dbs[scope], scope)).toBe(7934);
      expect(getMemory(dbs[scope], scope, old.uuid!)?.status).toBe("active");
      expect(listActive(dbs[scope], scope)).toHaveLength(2);
    } finally { await worker.terminate(); }
  }, 10000);
});
