import { describe, expect, it, vi } from "vitest";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import type { Change, Hlc, ReplicaEffects } from "@spider/db-core/roam/types";
import {
  A, B, C, SA, SB, SESSION, apply, batch, clock, deleted, effects, home, memory, replica, rows, session, todo, transfer,
} from "./roam-apply-fixture";

const orders = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

function localTodo(root: ReturnType<typeof replica>, uuid: string, seq: number, text: string) {
  const result = root.db.prepare("INSERT INTO todos(uuid, session_id, seq, text, done, created_at) VALUES (?, ?, ?, ?, 0, 1)")
    .run(uuid, SESSION, seq, text);
  root.db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, ?)").run(result.lastInsertRowid, text);
}

function removeLocalTodo(root: ReturnType<typeof replica>, uuid: string) {
  const old = root.db.prepare("SELECT id, text FROM todos WHERE uuid = ?").get(uuid) as { id: number; text: string };
  root.db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(old.id, old.text);
  root.db.prepare("DELETE FROM todos WHERE uuid = ?").run(uuid);
}

function runRecord(origin: string, at: Hlc): Change {
  return {
    changeId: "run", entity: "runs", rowKey: "run-1", op: "put", clock: at,
    writerSession: SESSION, writerEpoch: 1, schema: 14,
    body: { id: "run-1", session_id: SESSION, parent_run_id: null, agent: "worker", role: null, name: null, status: "running", phase: null, model: null, task: null, thinking: null, started_at: 1, ended_at: null, step_count: 0, token_count: 0, result: null, child_mode: "print", origin_machine: origin },
  };
}

describe("roaming merge", () => {
  it.each(orders)("three roots converge in every peer order %i %i %i", async (first, second, third) => {
    const order = [first, second, third];
    const machines = [A, B, C];
    const words = ["alpha", "bravo", "charlie"];
    const repos = machines.map(machine => replica("repo", machine));
    const worktrees = machines.map(machine => replica("worktree", machine));
    const tick = Date.now() + 10_000;
    for (let index = 0; index < 3; index++) {
      const repo = repos[index];
      const tree = worktrees[index];
      enableMemoryCapture(repo.db, repo.storeKey);
      seedSession(tree.db, SESSION, 1, tree.storeKey, 4096);
      for (const root of [repo, tree]) root.db.prepare("UPDATE roam_meta SET hlc_ms = ?, hlc_count = 0").run(tick + index * 1000);
      const addMemory = repo.db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES (?, 'insight', ?, 'active', 'user', 1)");
      addMemory.run("memory-live", words[index]);
      addMemory.run("memory-gone", words[index]);
      localTodo(tree, "todo-live", 1, words[index]);
      localTodo(tree, "todo-gone", 2, words[index]);
      if (index === 2) {
        repo.db.prepare("DELETE FROM memory WHERE uuid = 'memory-gone'").run();
        removeLocalTodo(tree, "todo-gone");
      }
    }
    for (const group of [repos, worktrees]) {
      const handlers = group.map(() => effects());
      for (const source of order) {
        for (let destination = 0; destination < 3; destination++) {
          if (source !== destination) await transfer(group[source], group[destination], handlers[destination]);
        }
      }
    }
    const portableState = (index: number) => ({
      memory: repos[index].db.prepare("SELECT uuid, content, status FROM memory ORDER BY uuid").all(),
      todos: worktrees[index].db.prepare("SELECT uuid, seq, text FROM todos ORDER BY uuid").all(),
      memoryTombstone: repos[index].db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'memory' AND row_key = 'memory-gone'").get(),
      todoTombstone: worktrees[index].db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'todos' AND row_key = 'todo-gone'").get(),
    });
    const expected = {
      memory: [{ uuid: "memory-live", content: "charlie", status: "active" }],
      todos: [{ uuid: "todo-live", seq: 1, text: "charlie" }],
      memoryTombstone: { deleted: 1 }, todoTombstone: { deleted: 1 },
    };
    expect([0, 1, 2].map(portableState)).toEqual([expected, expected, expected]);
    for (const root of worktrees) {
      expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'charlie'").all()).toHaveLength(1);
      expect(root.db.prepare("SELECT state FROM roam_sessions WHERE session_id = ?").get(SESSION)).toEqual({ state: "active" });
    }
  }, 5000);

  it("old puts cannot revive tombstones", async () => {
    const root = replica();
    const handlers = effects();
    const old = todo("todo-1", 1, "old", clock(100));
    const remove = deleted(old, clock(200), "delete-todo-1");
    apply(root, await batch(root, [remove]), handlers);
    apply(root, await batch(root, [old], { after: 1, id: "older" }), handlers);
    expect(rows(root, "todos")).toEqual([]);
    expect(root.db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'todos' AND row_key = 'todo-1'").get()).toEqual({ deleted: 1 });
    expect(rows(root, "roam_changes")).toHaveLength(2);
    expect(handlers.notices).toEqual([root.storeKey]);
  }, 5000);

  it("idle forwarding stops log growth", async () => {
    const roots = [replica("repo", A), replica("repo", B), replica("repo", C)];
    const handlers = roots.map(() => effects());
    enableMemoryCapture(roots[0].db, roots[0].storeKey);
    roots[0].db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-1', 'insight', 'message', 'active', 'user', 1)").run();
    for (let pass = 0; pass < 2; pass++) {
      for (let source = 0; source < 3; source++) {
        for (let destination = 0; destination < 3; destination++) {
          if (source !== destination) await transfer(roots[source], roots[destination], handlers[destination]);
        }
      }
    }
    const before = roots.map(root => rows(root, "roam_changes").length);
    const noticeCounts = handlers.map(handler => handler.notices.length);
    for (let source = 0; source < 3; source++) {
      for (let destination = 0; destination < 3; destination++) {
        if (source !== destination) await transfer(roots[source], roots[destination], handlers[destination]);
      }
    }
    expect(roots.map(root => rows(root, "roam_changes").length)).toEqual(before);
    expect(handlers.map(handler => handler.notices.length)).toEqual(noticeCounts);
  }, 5000);

  it("foreign first row creates retired membership atomically", async () => {
    const root = replica();
    const handlers = effects();
    apply(root, await batch(root, [{ ...session(), writerEpoch: 5 }]), handlers);
    expect(root.db.prepare("SELECT epoch, state FROM roam_sessions WHERE session_id = ?").get(SESSION)).toEqual({ epoch: 5, state: "retired" });
    expect(() => root.db.prepare("INSERT INTO todos(session_id, seq, text, created_at) VALUES (?, 1, 'blocked', 1)").run(SESSION)).toThrow("session is frozen");
    const failed = replica("worktree", C);
    const observer = effects();
    const fail: ReplicaEffects = {
      ...observer.effects,
      winning(db, before, after, change) {
        observer.effects.winning(db, before, after, change);
        if (change.entity === "todos") throw new Error("derived failure");
      },
    };
    const value = await batch(failed, [session(), todo("todo-1", 1, "text", clock(1001))]);
    expect(() => apply(failed, value, { ...observer, effects: fail })).toThrow("derived failure");
    expect(failed.db.prepare("SELECT * FROM roam_sessions WHERE session_id = ?").get(SESSION) ?? null).toBeNull();
    expect(rows(failed, "sessions")).toEqual([]);
    expect(rows(failed, "roam_changes")).toEqual([]);
    expect(rows(failed, "roam_receipts")).toEqual([]);
    expect(failed.db.prepare("SELECT importing FROM roam_meta").get()).toEqual({ importing: 0 });
    expect(observer.notices).toEqual([]);
  }, 5000);

  it("home updates require hub origin and monotone epoch", async () => {
    const root = replica("global");
    const first = home(A, 1, clock(100));
    const foreign = home(B, 1, clock(101, 0, B, SB), null, "foreign-home");
    const nonHubBatch = await batch(root, [foreign]);
    expect(() => apply(root, nonHubBatch)).toThrow(/hub/i);
    apply(root, await batch(root, [first]));
    const next = home(B, 2, clock(200), "move-1");
    apply(root, await batch(root, [next], { after: 1, id: "next" }));
    const before = rows(root, "session_homes");
    for (const bad of [home(A, 1, clock(300), null, "lower"), home(A, 2, clock(301), "move-1", "owner"), home(B, 2, clock(302), "move-2", "move")]) {
      const invalid = await batch(root, [bad], { after: 2, id: bad.changeId });
      expect(() => apply(root, invalid)).toThrow(/epoch|home/i);
      expect(rows(root, "session_homes")).toEqual(before);
      expect(rows(root, "roam_receipts")).toHaveLength(2);
    }
    expect(root.db.prepare("SELECT machine_id, epoch, move_id FROM session_homes WHERE session_id = ?").get(SESSION))
      .toEqual({ machine_id: B, epoch: 2, move_id: "move-1" });
    const marker = replica("global", C);
    apply(marker, await batch(marker, [home("", 1, clock(100), null, "conflict")], { sender: B, stream: SB }));
    expect(marker.db.prepare("SELECT machine_id, epoch, move_id FROM session_homes").get()).toEqual({ machine_id: "", epoch: 1, move_id: null });
  }, 5000);

  it("home epochs cannot advance on an older clock or delete an assignment", async () => {
    const root = replica("global");
    const first = home(A, 1, clock(200));
    apply(root, await batch(root, [first]));
    const staleClock = home(B, 2, clock(100), "move-1");
    const remove = deleted(first, clock(300), "delete-home");
    const before = rows(root, "session_homes");
    for (const bad of [staleClock, remove]) {
      const value = await batch(root, [bad], { after: 1, id: bad.changeId });
      expect(() => apply(root, value)).toThrow(/home|epoch|clock/i);
      expect(rows(root, "session_homes")).toEqual(before);
      expect(rows(root, "roam_receipts")).toHaveLength(1);
    }
  }, 5000);

  it("apply owns base rows and passes deleted rowid to effects", async () => {
    const root = replica();
    const handlers = effects();
    const put = todo("todo-1", 1, "oldtext");
    apply(root, await batch(root, [put]), handlers);
    const before = root.db.prepare("SELECT id FROM todos WHERE uuid = 'todo-1'").get() as { id: number };
    apply(root, await batch(root, [deleted(put, clock(1001), "remove")], { after: 1, id: "remove" }), handlers);
    const last = handlers.calls.at(-1)!;
    expect(last.before?.rowid).toBe(before.id);
    expect(last.before?.body.text).toBe("oldtext");
    expect(last.after).toBeNull();
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'oldtext'").all()).toEqual([]);
    expect(rows(root, "todos")).toEqual([]);
  }, 5000);

  it("effects receive the allocated rowid after a put and update", async () => {
    const root = replica();
    const handlers = effects();
    const observer: ReplicaEffects = {
      winning(_db, before, after, change) { handlers.calls.push({ before, after, change }); },
      committed: handlers.effects.committed,
    };
    const first = todo("todo-1", 1, "first", clock(100));
    apply(root, await batch(root, [first]), { ...handlers, effects: observer });
    const inserted = root.db.prepare("SELECT id FROM todos WHERE uuid = 'todo-1'").get() as { id: number };
    expect(handlers.calls[0].before).toBeNull();
    expect(handlers.calls[0].after).toEqual({ rowid: inserted.id });
    const update: Change = { ...first, changeId: "update", clock: clock(101), body: { ...first.body!, text: "updated" } };
    apply(root, await batch(root, [update], { after: 1, id: "update" }), { ...handlers, effects: observer });
    expect(handlers.calls[1].before?.rowid).toBe(inserted.id);
    expect(handlers.calls[1].after).toEqual({ rowid: inserted.id });
    expect(root.db.prepare("SELECT text FROM todos WHERE id = ?").get(inserted.id)).toEqual({ text: "updated" });
  }, 5000);

  it("new imported runs have no process identity and preserve event order", async () => {
    const root = replica("worktree", A);
    const run = runRecord(A, clock(100));
    const event = (uuid: string, at: number): Change => ({
      changeId: uuid, entity: "run_events", rowKey: uuid, op: "put", clock: clock(at), writerSession: SESSION, writerEpoch: 1, schema: 14,
      body: { uuid, run_id: "run-1", session_id: SESSION, ts: at, type: "history", tool: null, summary: uuid, payload: null },
    });
    apply(root, await batch(root, [run, event("event-1", 101), event("event-2", 102)], { sender: B, stream: SB }));
    expect(root.db.prepare("SELECT pid, host_pid, pid_start_time, intercom_session FROM runs WHERE id = 'run-1'").get())
      .toEqual({ pid: null, host_pid: null, pid_start_time: null, intercom_session: null });
    expect(root.db.prepare("SELECT uuid FROM run_events ORDER BY id").all()).toEqual([{ uuid: "event-1" }, { uuid: "event-2" }]);
  }, 5000);

  it("forwarding preserves per-run event order", async () => {
    const source = replica("worktree", A);
    const relay = replica("worktree", B);
    const destination = replica("worktree", C);
    seedSession(source.db, SESSION, 1, source.storeKey, 4096);
    source.db.prepare("INSERT INTO runs(id, session_id, agent, status) VALUES ('run-1', ?, 'worker', 'running')").run(SESSION);
    const insert = source.db.prepare("INSERT INTO run_events(uuid, run_id, session_id, ts, type) VALUES (?, 'run-1', ?, ?, 'history')");
    insert.run("event-1", SESSION, 1);
    insert.run("event-2", SESSION, 2);
    await transfer(source, relay);
    await transfer(relay, destination);
    const expected = [{ uuid: "event-1" }, { uuid: "event-2" }];
    expect(relay.db.prepare("SELECT uuid FROM run_events ORDER BY id").all()).toEqual(expected);
    expect(destination.db.prepare("SELECT uuid FROM run_events ORDER BY id").all()).toEqual(expected);
    expect(destination.db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all())
      .toEqual([{ row_key: "event-1" }, { row_key: "event-2" }]);
  }, 5000);

  it.each([
    ["foreign", B, { pid: null, host_pid: null, pid_start_time: null, intercom_session: null }],
    ["local", A, { pid: 12, host_pid: 34, pid_start_time: "start", intercom_session: "local-session" }],
  ])("%s run updates handle process identity safely", async (_kind, machine, expected) => {
    const root = replica("worktree", machine);
    root.db.prepare(`INSERT INTO runs(id, session_id, agent, status, origin_machine, pid, host_pid, pid_start_time, intercom_session)
      VALUES ('run-1', ?, 'worker', 'running', ?, 12, 34, 'start', 'local-session')`).run(SESSION, A);
    apply(root, await batch(root, [runRecord(A, clock(100))], { sender: B, stream: SB }));
    expect(root.db.prepare("SELECT pid, host_pid, pid_start_time, intercom_session FROM runs WHERE id = 'run-1'").get()).toEqual(expected);
  }, 5000);

  it("applies global memory and home changes with one committed notice", async () => {
    const root = replica("global");
    const handlers = effects();
    const globalMemory: Change = {
      changeId: "global-memory", entity: "global_memory", rowKey: "global-1", op: "put", clock: clock(100),
      writerSession: null, writerEpoch: null, schema: 14,
      body: { uuid: "global-1", category: "insight", content: "global text", link: null, scope: "global", status: "active", source: "user", confidence: null, created_at: 1, updated_at: null, justification: null, evidence: null, machine_id: null },
    };
    apply(root, await batch(root, [globalMemory, home(A, 1, clock(101))]), handlers);
    expect(root.db.prepare("SELECT uuid, content FROM global_memory").all()).toEqual([{ uuid: "global-1", content: "global text" }]);
    expect(root.db.prepare("SELECT machine_id FROM session_homes").get()).toEqual({ machine_id: A });
    expect(handlers.notices).toEqual([root.storeKey]);
    apply(root, await batch(root, [deleted(globalMemory, clock(102), "global-delete")], { after: 2, id: "delete-global" }), handlers);
    expect(rows(root, "global_memory")).toEqual([]);
    expect(root.db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'global_memory' AND row_key = 'global-1'").get()).toEqual({ deleted: 1 });
  }, 5000);

  it("losing memory edits do not merge fields into the winning row", async () => {
    const root = replica("repo");
    const winner = memory("memory-1", "winning", clock(200), "winner");
    winner.body = { ...winner.body!, status: "archived", link: "winning-link", justification: null, evidence: "winning-evidence" };
    const loser = memory("memory-1", "losing", clock(100), "loser");
    loser.body = { ...loser.body!, status: "active", link: "losing-link", justification: "losing-justification", evidence: null };
    apply(root, await batch(root, [winner]));
    apply(root, await batch(root, [loser], { after: 1, id: "loser" }));
    expect(root.db.prepare("SELECT content, status, link, justification, evidence FROM memory WHERE uuid = 'memory-1'").get())
      .toEqual({ content: "winning", status: "archived", link: "winning-link", justification: null, evidence: "winning-evidence" });
    expect(rows(root, "roam_changes")).toHaveLength(2);
  }, 5000);

  it("memory cap diagnostic counts active characters across rows", async () => {
    const root = replica("repo");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const archived = memory("archived", "x".repeat(9000), clock(100));
      archived.body!.status = "archived";
      const full = memory("full", "y".repeat(8000), clock(101));
      apply(root, await batch(root, [archived, full]));
      expect(warn).not.toHaveBeenCalled();
      const extra = memory("extra", "z", clock(102));
      apply(root, await batch(root, [extra], { after: 2, id: "extra" }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(root.db.prepare("SELECT uuid FROM memory ORDER BY uuid").all()).toEqual([{ uuid: "archived" }, { uuid: "extra" }, { uuid: "full" }]);
    } finally { warn.mockRestore(); }
  }, 5000);

  it("memory cap overflow reports a diagnostic without deleting accepted rows", async () => {
    const root = replica("repo");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      apply(root, await batch(root, [memory("memory-1", "x".repeat(8001))]));
      expect(root.db.prepare("SELECT length(content) AS chars FROM memory WHERE uuid = 'memory-1'").get()).toEqual({ chars: 8001 });
      expect(warn.mock.calls.flat().join(" ")).toMatch(/memory.*cap/i);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("x".repeat(100));
    } finally { warn.mockRestore(); }
  }, 5000);
});
