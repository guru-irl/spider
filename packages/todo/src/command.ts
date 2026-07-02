import type { Db } from "@spider/db-core";
import type { Component } from "@spider/ui";
import { Panel } from "@spider/ui";
import { listTodos, viewSession } from "./store.js";
import { renderTodos, renderView } from "./renderers.js";
import type { TodoDeps } from "./actions.js";

const GLYPH = "🕸";

/**
 * Interactive `/todos` viewer definition for `pi.registerCommand`.
 *
 * Gated on `ctx.hasUI`: when there is no UI surface we return a plain text
 * summary (never throw, never block). When UI is present we render a live
 * widget snapshot of the current session's todos and let `a` toggle between
 * the current-session view and the all-sessions summary.
 *
 * The interactivity here is deliberately minimal (a static Panel snapshot that
 * re-renders on key toggle); richer LiveWidget streaming is a later phase.
 */
export function makeTodosCommand(deps: TodoDeps) {
  return {
    name: "todos",
    description: `${GLYPH} view this session's todos (press 'a' to toggle all sessions)`,
    run(ctx: any): Component | string {
      const db: Db = ctx?.db ?? deps.projectDb;
      const sessionId: string = ctx?.sessionId ?? deps.getSessionId();

      // Non-UI surfaces get a compact text summary; do not attempt to render.
      if (!ctx?.hasUI) {
        const todos = listTodos(db, sessionId);
        if (!todos.length) return "(no todos)";
        return todos
          .map((t) => `${t.done ? "[x]" : "[ ]"} #${t.seq} ${t.text}`)
          .join("\n");
      }

      // Interactive-ish view state: current session vs. all sessions.
      let showAll = false;

      const snapshot = (): Component =>
        showAll
          ? renderView(viewSession(db, "all", sessionId))
          : renderTodos(listTodos(db, sessionId));

      let current = snapshot();

      return {
        render(width: number): string[] {
          const header = Panel({
            title: `${GLYPH} todos`,
            body: [showAll ? "view: all sessions" : "view: current session", "keys: a = toggle all"],
          });
          return [...header.render(width), ...current.render(width)];
        },
        handleInput(key: string): boolean {
          if (key === "a") {
            showAll = !showAll;
            current = snapshot();
            return true;
          }
          return false;
        },
      };
    },
  };
}

// A default def bound to no deps is intentionally not exported: the command
// needs a DB + session, so it is always constructed via makeTodosCommand(deps).
export type TodosCommand = ReturnType<typeof makeTodosCommand>;
