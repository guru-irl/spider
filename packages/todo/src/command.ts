import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Db } from "@spider/db-core";
import { listTodos, viewSession } from "./store";
import type { SessionGroup, Todo } from "./types";

const GLYPH = "🕸";

type Fg = (token: string, s: string) => string;

/** Safe theme.fg accessor — pi passes a real Theme in the overlay, but tests/non-interactive
 *  paths may pass a bare object; degrade to identity so nothing throws. */
function fgOf(theme: any): Fg {
  return typeof theme?.fg === "function" ? (t, s) => theme.fg(t, s) : (_t, s) => s;
}

function shortId(session: string): string {
  return session.length > 8 ? session.slice(0, 8) : session;
}

/** `name (abcd1234)` — friendly session label, with a ` ← current` marker for this session. */
function sessionLabel(g: { session: string; name?: string; current?: boolean }): string {
  const id = shortId(g.session);
  const base = g.name ? `${g.name} (${id})` : id;
  return g.current ? `${base} ← current` : base;
}

/** A subtle full-width `─── Title ────` rule (no 🕸 chrome — this is an overlay, not a tool result). */
function ruleHeader(fg: Fg, label: string, width: number): string {
  const title = ` ${label} `;
  const left = 3;
  const right = Math.max(0, width - visibleWidth(title) - left);
  return truncateToWidth(fg("dim", "─".repeat(left)) + fg("accent", title) + fg("dim", "─".repeat(right)), width, "");
}

/** `done/total completed` summary + one `✓/○ #id text` line per todo (done → dim). */
function todoLines(fg: Fg, todos: Todo[], width: number, indent: string): string[] {
  if (!todos.length) return [truncateToWidth(`${indent}${fg("dim", "No todos.")}`, width, "")];
  const done = todos.filter((t) => t.done).length;
  const out = [truncateToWidth(`${indent}${fg("muted", `${done}/${todos.length} completed`)}`, width, ""), ""];
  for (const t of todos) {
    const check = t.done ? fg("success", "✓") : fg("dim", "○");
    const id = fg("accent", `#${t.seq}`);
    const text = t.done ? fg("dim", t.text) : fg("text", t.text);
    out.push(truncateToWidth(`${indent}${check} ${id} ${text}`, width, ""));
  }
  return out;
}

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
      const sessionName: string | undefined = ctx?.sessionManager?.getSessionName?.();

      // Interactive overlay when available.
      if (typeof ctx?.ui?.custom === "function") {
        await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
          let allSessions = false;
          const fg = fgOf(theme);
          // force:true so a shrinking view (all→this) or closing the overlay triggers pi's
          // clearOnShrink — freed rows are cleared and the chat flows back down with the editor
          // pinned at the bottom, instead of stranding the chat bar in the middle (mirrors the
          // agents drilled-detail fix in agents-ui.ts).
          const requestRender = () => tui?.requestRender?.(true);
          return {
            render(width: number): string[] {
              const w = Math.max(1, width | 0);
              const lines: string[] = [""];
              if (!allSessions) {
                lines.push(ruleHeader(fg, "Todos", w));
                lines.push(
                  "",
                  truncateToWidth(`  ${fg("dim", "session: ")}${fg("muted", sessionLabel({ session: sessionId, name: sessionName, current: true }))}`, w, ""),
                  "",
                );
                lines.push(...todoLines(fg, listTodos(db, sessionId), w, "  "));
              } else {
                lines.push(ruleHeader(fg, "Todos · all sessions", w), "");
                const groups: SessionGroup[] = viewSession(db, "all", sessionId);
                if (!groups.length) {
                  lines.push(truncateToWidth(`  ${fg("dim", "No todos in this project yet.")}`, w, ""));
                } else {
                  for (const g of groups) {
                    lines.push(truncateToWidth(`  ${fg("accent", sessionLabel(g))}`, w, ""));
                    lines.push(...todoLines(fg, g.todos, w, "    "));
                    lines.push("");
                  }
                }
              }
              const hint = `Press "a" to toggle ${allSessions ? "current session" : "all sessions"} · "q"/Esc to close`;
              lines.push("", truncateToWidth(`  ${fg("dim", hint)}`, w, ""), "");
              return lines;
            },
            invalidate() {},
            handleInput(data: string): boolean {
              if (data === "a" || data === "A") {
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
            dispose() { requestRender(); },
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
