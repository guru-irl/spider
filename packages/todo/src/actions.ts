import type { Db } from "@spider/db-core";
import type { Component } from "@spider/ui";
import {
  listTodos,
  addTodo,
  toggleTodo,
  clearTodos,
  sessionSummaries,
  viewSession,
} from "./store.js";
import { renderTodos, renderSessions, renderView } from "./renderers.js";

export interface TodoDeps {
  projectDb: Db;
  getSessionId: () => string;
}

export interface ActionResult {
  display?: Component | string;
  details: unknown;
}

/**
 * Build the `todo` action handler. Session + DB are resolved per-call: prefer
 * the runtime ctx (supplied by the host) and fall back to the closure deps
 * (used by the fakePi test, which passes an empty ctx).
 */
export function makeTodo(deps: TodoDeps) {
  return async (args: any, ctx: any): Promise<ActionResult> => {
    const sessionId = ctx?.sessionId ?? deps.getSessionId();
    const db: Db = ctx?.db ?? deps.projectDb;
    const op = args?.op ?? "list";

    switch (op) {
      case "add": {
        const t = addTodo(db, sessionId, String(args.text));
        return { display: renderTodos(listTodos(db, sessionId)), details: t };
      }
      case "toggle": {
        const t = toggleTodo(db, sessionId, Number(args.id));
        return { display: renderTodos(listTodos(db, sessionId)), details: t };
      }
      case "clear": {
        clearTodos(db, sessionId);
        return { details: { ok: true } };
      }
      case "sessions": {
        const s = sessionSummaries(db, sessionId);
        return { display: renderSessions(s), details: s };
      }
      case "view": {
        const g = viewSession(db, String(args?.session ?? "all"), sessionId);
        return { display: renderView(g), details: g };
      }
      case "list":
      default: {
        const t = listTodos(db, sessionId);
        return { display: renderTodos(t), details: t };
      }
    }
  };
}
