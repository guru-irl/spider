import type { Db } from "@spider/db-core";
import { listTodos } from "./store.js";

const GLYPH = "🕸";

/**
 * Deps for the `/todos` command. DB + session are resolved per-invocation from
 * the pi ExtensionCommandContext so the command reflects the caller's cwd/session.
 */
export interface TodosCommandDeps {
  getDb: (ctx: any) => Db;
  getSessionId: (ctx: any) => string;
}

/**
 * Build the `/todos` command definition for pi's real `registerCommand` contract:
 * `{ description, handler(args, ctx) }`. The handler is fire-once — it renders by
 * calling `ctx.ui.notify(message, "info")` and returns void. There is no
 * run()/render()/handleInput().
 *
 * TODO(phase5): interactive LiveWidget viewer (press 'a' to toggle all sessions).
 */
export function makeTodosCommand(deps: TodosCommandDeps) {
  return {
    description: `${GLYPH} view this session's todos`,
    async handler(_args: string, ctx: any): Promise<void> {
      const sessionId: string =
        ctx?.sessionManager?.getSessionId?.() ?? deps.getSessionId(ctx);
      const db = deps.getDb(ctx);
      const todos = listTodos(db, sessionId);
      const text = todos.length
        ? todos.map((t) => `${t.done ? "[x]" : "[ ]"} #${t.seq} ${t.text}`).join("\n")
        : "(no todos)";
      if (ctx?.ui?.notify) ctx.ui.notify(text, "info");
    },
  };
}

export type TodosCommand = ReturnType<typeof makeTodosCommand>;
