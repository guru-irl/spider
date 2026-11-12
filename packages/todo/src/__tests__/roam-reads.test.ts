import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDbAt, setGlobalDbPathForTests } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { catalogReplica, replicaPath, resolveSessionReplica } from "@spider/db-core/roam/catalog";
import { makeTodo } from "../actions";
import { addTodo } from "../store";

const machine = "11111111-1111-4111-8111-111111111111";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { setGlobalDbPathForTests(null); for (const f of fixtures.splice(0)) f.close(); });

it("hub reads box-created session without a checkout", async () => {
  const global = createReplica("global", machine), local = createReplica("worktree", machine);
  fixtures.push(global, local);
  setGlobalDbPathForTests(global.db.raw.name);
  const key = "worktree:fixture-repo:fixture-workspace" as const;
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const source = openDbAt(replicaPath(global.db, key), "worktree");
  try {
    source.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    source.exec("INSERT INTO sessions(id,name,started_at) VALUES ('remote-session','Remote',1)");
    const todo = addTodo(source, "remote-session", "remote todo");
    catalogReplica(global.db, key, source);
    const read = resolveSessionReplica(global.db, "remote-session")!;
    expect(read.db.raw.readonly).toBe(true);
    read.db.close();
    const result = await makeTodo({ projectDb: local.db, getSessionId: () => "local" })({ op: "view", session: "remote-session" }, { globalDb: global.db });
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual([{ session: "remote-session", name: "Remote", current: false, todos: [todo] }]);
    expect(local.db.prepare("SELECT count(*) AS n FROM todos").get()).toEqual({ n: 0 });
  } finally { source.close(); }
}, 5000);
