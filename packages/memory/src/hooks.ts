import type { Db } from "@spider/db-core";
import { assembleSnapshot } from "./snapshot.js";
import type { MemoryConfig } from "./actions.js";

export interface HookDeps {
  projectDb: Db;
  globalDb: Db;
  config: MemoryConfig;
}

/**
 * before_agent_start: append the frozen memory snapshot to the system prompt.
 * Defensive: only mutates when a non-empty snapshot exists and the event
 * carries a string systemPrompt.
 */
export function makeBeforeAgentStart(deps: HookDeps) {
  return (event: any) => {
    const snap = assembleSnapshot(
      { global: deps.globalDb, project: deps.projectDb },
      { charCap: deps.config.snapshotCharCap ?? 8000 },
    );
    if (snap && typeof event?.systemPrompt === "string") {
      event.systemPrompt += "\n\n" + snap;
    }
    return event;
  };
}

/**
 * session_start: upsert a row into the project sessions table. Guards a missing
 * session id and never overwrites an existing row.
 */
export function makeSessionStart(deps: HookDeps) {
  return (event: any) => {
    const id = event?.sessionId;
    if (typeof id !== "string" || id.length === 0) return event;
    deps.projectDb
      .prepare(
        "INSERT INTO sessions (id, reason, started_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, event?.reason ?? null, Date.now());
    return event;
  };
}
