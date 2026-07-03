import type { Db } from "@spider/db-core";
import { listTodos, viewSession } from "./store.js";
import type { SessionGroup, Todo } from "./types.js";

const GLYPH = "🕸";

/**
 * Deps for the `/todos` command. DB + session are resolved per-invocation from
 * the pi ExtensionCommandContext so the command reflects the caller's cwd/session.
 */
export interface TodosCommandDeps {
  getDb: (ctx: any) => Db;
  getSessionId: (ctx: any) => string;
}

function fmtTodo(t: Todo): string {
  return `${t.done ? "[x]" : "[ ]"} #${t.seq} ${t.text}`;
}

/** Lines for this-session view. */
function sessionLines(db: Db, sessionId: string): string[] {
  const todos = listTodos(db, sessionId);
  return todos.length ? todos.map(fmtTodo) : ["(no todos)"];
}

/** Lines for all-sessions view (grouped by session). */
function allSessionLines(db: Db, sessionId: string): string[] {
  const groups: SessionGroup[] = viewSession(db, "all", sessionId);
  if (!groups.length) return ["(no todos)"];
  const out: string[] = [];
  for (const g of groups) {
    const label = g.name ?? g.session;
    out.push(`${g.current ? "▸ " : "  "}${label}${g.current ? " (this session)" : ""}`);
    if (g.todos.length) for (const t of g.todos) out.push(`    ${fmtTodo(t)}`);
    else out.push("    (no todos)");
  }
  return out;
}

/** Model-facing / notify text for the current session (fallback path). */
function notifyText(db: Db, sessionId: string): string {
  const lines = sessionLines(db, sessionId);
  return lines.length === 1 && lines[0] === "(no todos)" ? "(no todos)" : lines.join("\n");
}

/**
 * Build the `/todos` command definition for pi's `registerCommand` contract:
 * `{ description, handler(args, ctx) }`.
 *
 * When the pi UI exposes an interactive surface (`ctx.ui.custom`), the handler opens
 * an overlay Component that lists the current session's todos and supports:
 *   - `a`        toggle between this-session and ALL-sessions view (re-query + re-render)
 *   - `q`/Esc/^C close the overlay (`done()`)
 * When `ctx.ui.custom` is absent (non-interactive/RPC modes), it degrades to the
 * previous fire-once `ctx.ui.notify` behavior so nothing breaks.
 */
export function makeTodosCommand(deps: TodosCommandDeps) {
  return {
    description: `${GLYPH} view todos (press 'a' for all sessions, 'q' to close)`,
    async handler(_args: string, ctx: any): Promise<void> {
      const sessionId: string =
        ctx?.sessionManager?.getSessionId?.() ?? deps.getSessionId(ctx);
      const db = deps.getDb(ctx);

      // Interactive overlay when available.
      if (typeof ctx?.ui?.custom === "function") {
        await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
          let allSessions = false;
          const requestRender = () => tui?.requestRender?.();
          return {
            render(width: number): string[] {
              const w = Math.max(1, width | 0);
              const title = allSessions
                ? `${GLYPH} todos — all sessions`
                : `${GLYPH} todos — this session`;
              const hint = "(a: toggle all · q: close)";
              const body = allSessions
                ? allSessionLines(db, sessionId)
                : sessionLines(db, sessionId);
              return [title, hint, "", ...body].map((l) =>
                l.length <= w ? l : l.slice(0, Math.max(0, w - 1)) + "…",
              );
            },
            invalidate() {},
            handleInput(data: string): boolean {
              if (data === "a") {
                allSessions = !allSessions;
                requestRender();
                return true;
              }
              if (data === "q" || data === "\x1b" || data === "\x03") {
                done();
                return true;
              }
              return false;
            },
            dispose() {},
          };
        });
        return;
      }

      // Non-interactive fallback: fire-once notify.
      if (ctx?.ui?.notify) ctx.ui.notify(notifyText(db, sessionId), "info");
    },
  };
}

export type TodosCommand = ReturnType<typeof makeTodosCommand>;
