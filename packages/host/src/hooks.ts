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
//   - before_agent_start     -> frozen per-session memory snapshot (Phase 1)
//   - context_with_system    -> same snapshot on notification-triggered requests
//   - session_start          -> session upsert + self-name (Phase 1/6)
//   - session_before_compact -> organism drain (Phase 6)
//   - session_compact        -> bookkeeping (Phase 6)
//   - session_shutdown       -> organism final consolidation (Phase 6)
//   - resources_discover     -> contribute skills dirs + config hot-reload (Phase 0/7)
//
// Task 7b: the `tool_call` / `tool_result` events are now OWNED by routing
// (packages/host/src/routing/index.ts, wired in extension.ts). They are
// intentionally NOT registered here to avoid double-registration.
import { openGlobal, openGlobalReadOnly, getBinding, appendEvent, type Db } from "@spider/db-core";
import { openSessionRunDb } from "./session-run-db";
import type { ContextWithSystemEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
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
  "context_with_system",
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "resources_discover",
  "tool_call",
] as const;

/** Check only the binding on later turns, never active-memory rows or config. */
function memoryTargetOf(cwd: string, sessionId: string): string | undefined {
  if (!sessionId) return cwd;
  let db: Db | undefined;
  try {
    db = openGlobalReadOnly();
    return db ? getBinding(db, sessionId) ?? cwd : cwd;
  } catch {
    // A failed lookup is not an unbind. Keep the current session's frozen source.
    return undefined;
  } finally {
    db?.close();
  }
}

export function registerHooks(pi: PiLikeAPI): void {
  // Instance-local: reloads and subagent processes get independent snapshots.
  // Empty snapshots are frozen too, so the first write cannot change the prefix.
  let frozenMemory: { key: string; target: string; text: string } | undefined;
  const memoryTextOf = (ctx?: unknown): string => {
    const cwd = cwdOf(ctx) ?? process.cwd();
    const sessionId = sessionIdOf(ctx);
    const sessionFile = (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionFile?.();
    const key = JSON.stringify([sessionId, sessionFile ?? null, cwd]);
    const resolvedTarget = memoryTargetOf(cwd, sessionId);
    const target = resolvedTarget ?? (frozenMemory?.key === key ? frozenMemory.target : cwd);
    let text = frozenMemory?.text ?? "";
    if (frozenMemory?.key !== key || frozenMemory.target !== target) {
      // Binding was resolved above; read the chosen target without re-resolving it.
      const snapshot = readInjectionSnapshot(target);
      text = snapshot.text;
      // Inject available tiers now, but retry incomplete builds next request.
      if (resolvedTarget !== undefined && Object.keys(snapshot.errors).length === 0) {
        frozenMemory = { key, target, text };
      }
    }
    return text;
  };
  // One handler per hook. DBs are opened lazily, and injection is defensive so
  // a memory failure never blocks agent start or a provider request.
  for (const name of HOOK_NAMES) {
    if (name === "before_agent_start") {
      pi.on(name, (event: any, ctx?: unknown) => {
        // pi consumes the RETURNED prompt patch, not mutation of event.systemPrompt.
        if (typeof event?.systemPrompt !== "string") return undefined;
        try {
          const text = memoryTextOf(ctx);
          if (text) return { systemPrompt: event.systemPrompt + "\n\n" + text };
        } catch {
          // Snapshot injection is best-effort; never block agent start.
        }
        return undefined;
      });
    } else if (name === "context_with_system") {
      pi.on(name, (event: any, ctx?: unknown) => {
        try {
          const messages = (event as ContextWithSystemEvent | undefined)?.messages;
          if (!messages) return undefined;
          const head = getCurrentSystemMessage(messages);
          if (!head) return undefined;
          const text = memoryTextOf(ctx);
          if (!text) return undefined;
          const prompt = getSystemMessageText(head);
          if (prompt.includes(text)) return undefined;
          // Idle triggerTurn skips before_agent_start in pi 0.87.x. Use its
          // public transcript hook, not provider-specific payload rewriting.
          // Match the forced-prompt path: one head with the replayed prompt and
          // tool loadout, followed by the conversation. Never edit stored entries.
          return { messages: [
            { role: "system" as const, content: prompt + "\n\n" + text,
              ...(head.toolsAdded ? { toolsAdded: head.toolsAdded } : {}), timestamp: head.timestamp },
            ...messages.filter(message => message.role !== "system"),
          ] };
        } catch {
          // Snapshot injection is best-effort; never block a provider request.
          return undefined;
        }
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
              reapOrphanRuns({ db, globalDb }).then(r => { if (r.error) logFailure("reaper", r.error); })
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
