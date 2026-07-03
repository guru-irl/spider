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
import { resolveProject, openGlobal, openProject } from "@spider/db-core";
import { assembleSnapshot } from "@spider/memory";

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
          const id = event?.sessionId;
          if (id) {
            const project = resolveProject(String(event?.cwd ?? process.cwd()));
            openProject(project.projectKey)
              .prepare("INSERT OR IGNORE INTO sessions(id, reason, started_at) VALUES (?, ?, ?)")
              .run(String(id), event?.reason ?? null, Date.now());
          }
        } catch {
          // session upsert is best-effort; never block session start.
        }
        return undefined;
      });
    } else {
      pi.on(name, () => undefined);
    }
  }
}
