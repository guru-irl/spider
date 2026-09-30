// packages/host/src/hooks.ts
// Phase 0 registers EMPTY (no-op) handlers for every hook in the contract's
// "Hook wiring" table. Later phases replace each body.
//
// A6 VALIDATE-FIRST resolution: the draft contract named the tool hooks
// `beforeToolCall`/`afterToolCall`, but pi's real ExtensionAPI.on() fires
// `tool_call` (result {block?,reason?}) and `tool_result`
// (result {content?,details?,isError?}) — verified against
// @earendil-works/pi-coding-agent .../core/extensions/types.d.ts. We register the
// REAL event names so Phase 0 handlers actually fire; Phase 3 fills their bodies.
//   - before_agent_start     -> memory snapshot (Phase 1), active-agents (Phase 5)
//   - session_start          -> session upsert + self-name (Phase 1/6)
//   - session_before_compact -> organism drain (Phase 6)
//   - session_compact        -> bookkeeping (Phase 6)
//   - session_shutdown       -> organism final consolidation (Phase 6)
//   - resources_discover     -> contribute skills dirs + config hot-reload (Phase 0/7)
//
// Task 7b: the `tool_call` / `tool_result` events are now OWNED by routing
// (packages/host/src/routing/index.ts, wired in extension.ts). They are
// intentionally NOT registered here to avoid double-registration.
import { openGlobal, appendEvent, type Db } from "@spider/db-core";
import { openSessionRunDb } from "./session-run-db";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cwdOf, sessionIdOf } from "./session-context";
import { readInjectionSnapshot } from "./injection-snapshot";
import { contributeSkillPaths } from "@spider/superpowers";
import { reapOrphanRuns, pollPendingMessages } from "@spider/subagents";
import { execEnforcement } from "./control";

export interface PiLikeAPI {
  on(name: string, fn: (...args: unknown[]) => unknown): void;
}

export const HOOK_NAMES = [
  "before_agent_start",
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "resources_discover",
  "tool_call",
] as const;

export function registerHooks(pi: PiLikeAPI): void {
  // One handler per hook (the contract's "every hook has a handler" invariant).
  // before_agent_start + session_start carry Phase 1 memory logic; every other
  // hook stays a no-op pass-through until its phase fills the body. DBs are
  // opened LAZILY inside the handler (never at module load), and each body is
  // fully defensive so a memory failure never breaks agent start / session start.
  for (const name of HOOK_NAMES) {
    if (name === "before_agent_start") {
      pi.on(name, (event: any, ctx?: unknown) => {
        // pi consumes the RETURNED prompt patch, not mutation of event.systemPrompt.
        if (typeof event?.systemPrompt !== "string") return undefined;
        try {
          const snap = readInjectionSnapshot(cwdOf(ctx) ?? process.cwd(), sessionIdOf(ctx));
          if (snap.text) return { systemPrompt: event.systemPrompt + "\n\n" + snap.text };
        } catch {
          // Snapshot injection is best-effort; never block agent start.
        }
        return undefined;
      });
    } else if (name === "session_start") {
      pi.on(name, (event: any, ctx?: unknown) => {
        const sessionId = sessionIdOf(ctx);
        // No invented "unknown" session: native session events carry no ID.
        if (!sessionId) return undefined;
        const cwd = cwdOf(ctx) ?? process.cwd();
        return (async () => {
          let db: Db | undefined;
          let globalDb: Db | undefined;
          const logFailure = (tool: string, error: unknown) => {
            if (!db) return;
            try {
              appendEvent(db, {
                sessionId, ts: Date.now(), phase: "after", tool,
                description: `${tool} failed: ${String((error as Error)?.message ?? error)}`,
              });
            } catch { /* a diagnostic must not break session start */ }
          };
          try {
            db = openSessionRunDb(cwd, sessionId).db;
            globalDb = openGlobal();
            const sm = (ctx as Partial<ExtensionContext>)?.sessionManager;
            const sessionName = sm?.getSessionName?.()?.trim() || null;
            db.prepare(
              "INSERT INTO sessions(id, name, reason, started_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(id) DO UPDATE SET reason=excluded.reason, " +
              "name=COALESCE(excluded.name,sessions.name), ended_at=NULL",
            ).run(sessionId, sessionName, event?.reason ?? null, Date.now());

            // Keep these connection lifetimes through the asynchronous operations,
            // then close them. Startup must never poll a made-up session ID.
            await Promise.all([
              reapOrphanRuns({ db }).then(r => { if (r.error) logFailure("reaper", r.error); })
                .catch(e => logFailure("reaper", e)),
              pollPendingMessages(globalDb, sessionId, pi).catch(e => logFailure("poller", e)),
            ]);
          } catch (e) {
            logFailure("session", e);
          } finally {
            db?.close();
            globalDb?.close();
          }
        })();
      });
    } else if (name === "resources_discover") {
      // Contribute the superpowers baseline skills + the project's .spider/skills
      // tier. Best-effort: a discovery failure must never break session start.
      pi.on(name, (event: any, ctx?: unknown) => {
        try {
          const cwd = cwdOf(ctx) ?? String(event?.cwd ?? process.cwd());
          return { skillPaths: contributeSkillPaths(cwd) };
        } catch {
          return undefined;
        }
      });
    } else if (name === "tool_call") {
      // Mechanically enforce spider exec over bash. Unknown enforcement state
      // must block bash, not silently permit it.
      pi.on(name, (event: any) => {
        try {
          const tool = event?.toolName;
          if (tool !== "bash") return undefined;
          
          const cwd = String(event?.cwd ?? process.cwd());
          const { current, errors } = execEnforcement(cwd);

          // Default ON when unset or a layer is malformed; only explicitly false is safe.
          if (errors.length === 0 && current === false) return undefined;
          
          const cmd = String(event?.input?.command ?? "");
          // Cap command display at 500 chars to avoid bloating the reason
          const displayCmd = cmd.length > 500 ? cmd.slice(0, 500) + "\n[... truncated]" : cmd;
          
          const reason = `bash is disabled in this project — use spider exec (only what you print enters context).

Replace this call with:
  spider({ action: "exec", language: "shell", code: ${JSON.stringify(displayCmd)} })`;
          
          return { block: true, reason };
        } catch {
          // A lookup or event failure must not make bash available.
          return { block: true, reason: "bash is disabled in this project; use spider exec" };
        }
      });
    } else {
      pi.on(name, () => undefined);
    }
  }
}
