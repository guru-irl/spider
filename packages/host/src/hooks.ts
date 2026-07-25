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
import { resolveProject, openGlobal, openProject, appendEvent } from "@spider/db-core";
import { assembleSnapshot } from "@spider/memory";
import { contributeSkillPaths } from "@spider/superpowers";
import { reapOrphanRuns } from "@spider/subagents";
import { controlConfig } from "./control";

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
      pi.on(name, (event: any) => {
        try {
          const cwd = String(event?.cwd ?? process.cwd());
          const project = resolveProject(cwd);
          const snap = assembleSnapshot(
            { global: openGlobal(), project: openProject(project.projectKey) },
            { charCap: 8000 },
          );
          if (snap && typeof event?.systemPrompt === "string") {
            event.systemPrompt += "\n\n" + snap;
          }
        } catch {
          // snapshot injection is best-effort; never block agent start.
        }
        return undefined;
      });
    } else if (name === "session_start") {
      pi.on(name, (event: any) => {
        try {
          const cwd = String(event?.cwd ?? process.cwd());
          const project = resolveProject(cwd);
          const db = openProject(project.projectKey);
          
          // Reap subagents orphaned by a host that died without firing session_shutdown
          // (crash / dead tty / SIGKILL). Best-effort and defensive: a reaper failure must
          // never block session start.
          void reapOrphanRuns({ db })
            .then((r) => {
              if (r.error) {
                try {
                  appendEvent(db, {
                    sessionId: String(event?.sessionId ?? "unknown"),
                    ts: Date.now(),
                    phase: "after",
                    tool: "reaper",
                    description: `orphan reaper failed: ${r.error}`,
                  });
                } catch { /* best-effort event logging */ }
              }
            })
            .catch((e) => {
              try {
                appendEvent(db, {
                  sessionId: String(event?.sessionId ?? "unknown"),
                  ts: Date.now(),
                  phase: "after",
                  tool: "reaper",
                  description: `orphan reaper rejected: ${String((e as Error)?.message ?? e)}`,
                });
              } catch { /* best-effort event logging */ }
            });
          
          const id = event?.sessionId;
          if (id) {
            db
              .prepare("INSERT OR IGNORE INTO sessions(id, reason, started_at) VALUES (?, ?, ?)")
              .run(String(id), event?.reason ?? null, Date.now());
          }
        } catch {
          // session upsert is best-effort; never block session start.
        }
        return undefined;
      });
    } else if (name === "resources_discover") {
      // Contribute the superpowers baseline skills + the project's .spider/skills
      // tier. Best-effort: a discovery failure must never break session start.
      pi.on(name, (event: any) => {
        try {
          const cwd = String(event?.cwd ?? process.cwd());
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
