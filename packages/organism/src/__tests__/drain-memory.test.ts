import { afterEach, describe, expect, it } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { drainSession } from "../drain.js";
import { runMemoryTodoPass } from "../passes/run-memory-todo.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("organism activity allocation", () => {
  it("never materializes raw event payloads or run tasks/results for a digest", async () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    const blob = "unused raw output ".repeat(4096);
    db.prepare("INSERT INTO runs(id,session_id,agent,status,task,result) VALUES ('r1','s1','worker','done',?,?)").run(blob, blob);
    db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary,payload) VALUES ('r1','s1',1,'message','verified final finding',?)").run(JSON.stringify({ text: blob }));
    db.prepare("INSERT INTO events(session_id,ts,phase,tool,description,payload) VALUES ('s1',2,'after','edit','fixed the fixture',?)").run(JSON.stringify({ content: blob }));

    // Observe bytes crossing SQLite's result boundary. A JS-side discard is too late.
    let materializedBytes = 0;
    db.raw.function("observe_large_column", (value: string | null) => {
      materializedBytes += Buffer.byteLength(value ?? "");
      return value;
    });
    for (const [table, large] of [["runs", ["task", "result"]], ["run_events", ["payload"]], ["events", ["payload"]]] as const) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      db.raw.exec(`ALTER TABLE ${table} RENAME TO fixture_${table}`);
      const rowid = table === "runs" ? "rowid AS rowid," : "";
      db.raw.exec(`CREATE VIEW ${table} AS SELECT ${rowid}${columns.map(({ name }) => (large as readonly string[]).includes(name) ? `observe_large_column(${name}) AS ${name}` : name).join(",")} FROM fixture_${table}`);
    }

    const bundle = drainSession(db, "s1", "before_compact");
    let prompt = "";
    await runMemoryTodoPass(bundle, { complete: async (_system, messages) => {
      prompt = messages.map(message => message.content).join("\n");
      return "Nothing to save.";
    } });
    expect(prompt).toContain("verified final finding");
    expect(prompt).toContain("fixed the fixture");
    expect(materializedBytes).toBe(0);
    expect(JSON.stringify(bundle)).not.toContain("unused raw output");
  });

  it("reserves the run event window for rows with summaries", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    const insert = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary) VALUES (NULL,'s1',?,'message',?)");
    insert.run(1, "useful finding");
    db.transaction(() => { for (let i = 0; i < 250; i++) insert.run(i + 2, null); })();
    expect(drainSession(db, "s1", "before_compact").runEvents.map(event => event.summary)).toEqual(["useful finding"]);
  });

  it("orders queued runs by creation among the recent runs", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    const insert = db.prepare("INSERT INTO runs(id,session_id,agent,status,started_at) VALUES (?,'s1','worker',?,?)");
    db.transaction(() => {
      for (let i = 0; i < 101; i++) insert.run(`old-${i}`, "done", i + 1);
      insert.run("queued", "queued", null);
      insert.run("newer", "running", 102);
    })();
    const runs = drainSession(db, "s1", "before_compact").runs;
    expect(runs).toHaveLength(100);
    expect(runs.slice(-2).map(run => run.id)).toEqual(["queued", "newer"]);
  });

  it("retains only recent, bounded activity in chronological order across repeated drains", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    const run = db.prepare("INSERT INTO runs(id,session_id,agent,status,started_at) VALUES (?,?,'worker','done',?)");
    const event = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary) VALUES (?,?,?,'message',?)");
    const tracked = db.prepare("INSERT INTO events(session_id,ts,phase,tool,description) VALUES (?,?,'after','edit',?)");
    const todo = db.prepare("INSERT INTO todos(session_id,seq,text,done,created_at) VALUES (?,?,?,1,?)");
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        run.run(`run-${i}`, "s1", i);
        event.run(`run-${i}`, "s1", i, `finding-${i} ` + "x".repeat(4000));
        tracked.run("s1", i, `activity-${i} ` + "x".repeat(4000));
        todo.run("s1", i + 1, `done-${i} ` + "x".repeat(4000), i);
      }
      // Neither other sessions nor organism's own receipts may displace useful evidence.
      for (let i = 0; i < 250; i++) {
        event.run(null, "s1", 1000 + i, "organism drain receipt");
        db.prepare("UPDATE run_events SET type='log' WHERE id=last_insert_rowid()").run();
        run.run(`foreign-${i}`, "s2", 1000 + i);
        tracked.run("s2", 1000 + i, "foreign activity");
      }
    })();
    for (let trigger = 0; trigger < 3; trigger++) {
      const bundle = drainSession(db, "s1", "before_compact");
      expect(bundle.runs.length).toBeLessThanOrEqual(100);
      expect(bundle.runs.at(-1)?.id).toBe("run-499");
      expect(bundle.runEvents.length).toBeLessThanOrEqual(200);
      expect(bundle.runEvents.at(-1)?.summary).toMatch(/^finding-499 /);
      expect(bundle.events.length).toBeLessThanOrEqual(40);
      expect(bundle.events.at(-1)?.description).toMatch(/^activity-499 /);
      expect(bundle.todos.length).toBeLessThanOrEqual(100);
      expect(bundle.todos.at(-1)?.text).toMatch(/^done-499 /);
      expect(bundle.runEvents.every((item, index, items) => index === 0 || items[index - 1].id < item.id)).toBe(true);
      expect(JSON.stringify(bundle).length).toBeLessThan(800_000);
    }
    expect(db.prepare("SELECT count(*) AS n FROM runs WHERE session_id='s1'").get()).toEqual({ n: 500 });
    expect(db.prepare("SELECT count(*) AS n FROM run_events WHERE session_id='s1'").get()).toEqual({ n: 750 });
  });
});
