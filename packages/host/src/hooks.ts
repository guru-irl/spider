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
import { resolveProject, openGlobal, openProject, openRepo, openDbAt, paths, appendEvent, type Db } from "@spider/db-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cwdOf, sessionIdOf } from "./session-context";
import { assembleSnapshot } from "@spider/memory";
import { contributeSkillPaths } from "@spider/superpowers";
import { reapOrphanRuns, pollPendingMessages } from "@spider/subagents";
import { controlConfig } from "./control";
import { join } from "node:path";

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
        let repoDb: Db | undefined;
        let globalDb: Db | undefined;
        try {
          const cwd = cwdOf(ctx) ?? process.cwd();
          const sessionId = sessionIdOf(ctx) || undefined;
          const project = resolveProject(cwd, { sessionId, explicitCwd: !sessionId });
          repoDb = project.repoKey
            ? openRepo(project.repoKey)
            : openDbAt(join(paths.projectRoot(project.projectKey), "repo.db"), "repo");
          globalDb = openGlobal();
          const snap = assembleSnapshot({ global: globalDb, repo: repoDb }, { charCap: 8000 });
          if (snap) return { systemPrompt: event.systemPrompt + "\n\n" + snap };
        } catch {
          // Snapshot injection is best-effort; never block agent start.
        } finally {
          repoDb?.close();
          globalDb?.close();
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
            const project = resolveProject(cwd, { sessionId, explicitCwd: false });
            db = openProject(project.projectKey);
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
      // Mechanically enforce spider exec over bash. Best-effort: a hook failure
      // must never break a turn.
      pi.on(name, (event: any) => {
        try {
          const tool = event?.toolName;
          if (tool !== "bash") return undefined;
          
          const cwd = String(event?.cwd ?? process.cwd());
          const enforce = controlConfig("get", cwd, "exec.enforce");
          
          // Default ON when unset; only disable if explicitly false
          if (enforce === false) return undefined;
          
          const cmd = String(event?.input?.command ?? "");
          // Cap command display at 500 chars to avoid bloating the reason
          const displayCmd = cmd.length > 500 ? cmd.slice(0, 500) + "\n[... truncated]" : cmd;
          
          const reason = `bash is disabled in this project — use spider exec (only what you print enters context).

Replace this call with:
  spider({ action: "exec", language: "shell", code: ${JSON.stringify(displayCmd)} })`;
          
          return { block: true, reason };
        } catch {
          // Enforcement is best-effort; never break a turn
          return undefined;
        }
      });
    } else {
      pi.on(name, () => undefined);
    }
  }
}
