import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths } from "@spider/db-core";
import { mirrorMessage, sendIntercom, SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";

let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});
function freshGlobal() {
  dbPath = join(paths.scratch("global"), `g-${randomUUID()}.db`);
  return openDbAt(dbPath, "global");
}

function fakePi() {
  const handlers = new Map<string, Set<(p: any) => void>>();
  return {
    events: {
      on(event: string, fn: (p: any) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event: string, payload: any) {
        if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
          for (const fn of handlers.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) {
            fn({ requestId: payload.requestId, delivered: true });
          }
        }
        for (const fn of handlers.get(event) ?? []) fn(payload);
      },
    },
  };
}

describe("intercom message wrapper + message_mirror observability", () => {
  it("mirrorMessage writes a row to message_mirror", () => {
    const db = freshGlobal();
    mirrorMessage(db, { fromSession: "a", toSession: "reviewer", kind: "handoff", body: "hi" });
    const row = db.prepare("SELECT * FROM message_mirror").get() as any;
    expect(row.from_session).toBe("a");
    expect(row.kind).toBe("handoff");
    expect(row.body).toBe("hi");
    db.close();
  });

  it("sendIntercom emits and awaits ack, then mirrors the message", async () => {
    const db = freshGlobal();
    const pi = fakePi();
    const result = await sendIntercom(pi, db, { to: "reviewer", message: "please review", fromSession: "worker" });
    expect(result.delivered).toBe(true);
    const row = db.prepare("SELECT * FROM message_mirror").get() as any;
    expect(row.to_session).toBe("reviewer");
    db.close();
  });
});
