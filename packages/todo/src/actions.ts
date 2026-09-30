import type { Db } from "@spider/db-core";
import type { Component } from "@spider/ui";
import {
  listTodos,
  addTodo,
  toggleTodo,
  removeTodo,
  resolveSession,
  clearTodos,
  sessionSummaries,
  viewSession,
} from "./store";
import { renderTodos, renderSessions, renderView } from "./renderers";

export interface TodoDeps {
  projectDb: Db;
  getSessionId: () => string;
}

export interface ActionResult {
  display?: Component | string;
  details: unknown;
  isError?: boolean;
}

/**
 * Build the `todo` action handler. Session + DB are resolved per-call: prefer
 * the runtime ctx (supplied by the host) and fall back to the closure deps
 * (used by the fakePi test, which passes an empty ctx).
 */
export function makeTodo(deps?: TodoDeps) {
  return async (args: any, ctx: any): Promise<ActionResult> => {
    const db: Db | undefined = ctx?.db ?? deps?.projectDb;
    const sessionId: string = ctx?.sessionId ?? deps?.getSessionId?.() ?? "";
    if (!db) throw new Error("todo action: no db available (ctx.db or deps.projectDb required)");
    const op = args?.op ?? "list";
    const fail = (error: string): ActionResult => ({ display: error, details: { error }, isError: true });

    switch (op) {
      case "add": {
        if (typeof args.text !== "string" || !args.text.trim()) return fail("todo add: text must be a non-blank string");
        const t = addTodo(db, sessionId, args.text);
        return { display: renderTodos(listTodos(db, sessionId)), details: t };
      }
      case "toggle":
      case "remove": {
        const selector = args.session == null ? sessionId : String(args.session).trim();
        if (!selector.trim()) return fail(`todo ${op}: session selector must not be blank (id ${String(args.id)})`);
        if (args.session != null && selector === "all") {
          return fail(`todo ${op}: session "all" is ambiguous because ids are per session; select one session (id ${String(args.id)})`);
        }
        const target = args.session == null ? sessionId : resolveSession(db, selector);
        if (!target) return fail(`todo ${op}: session "${selector}" is unresolved or ambiguous (id ${String(args.id)})`);
        const id = typeof args.id === "string" ? args.id.trim().replace(/^#/, "") : args.id;
        const seq = typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id)) ? Number(id) : NaN;
        if (!Number.isSafeInteger(seq) || seq < 1) {
          return fail(`todo ${op}: invalid id "${String(args.id)}" in session "${target}"`);
        }
        const t = op === "toggle" ? toggleTodo(db, target, seq) : removeTodo(db, target, seq);
        if (!t) {
          if (!listTodos(db, target).length) return fail(`todo ${op}: session "${target}" has no todos (id ${String(args.id)})`);
          return fail(`todo ${op}: id "${String(args.id)}" not found in session "${target}"`);
        }
        const row = db.prepare("SELECT name FROM sessions WHERE id = ?").get(target) as { name: string | null } | undefined;
        const name = row?.name ?? undefined;
        const label = name ? `${target} (${name})` : target;
        return {
          display: op === "remove" ? `Removed #${t.seq} ${t.text} from session ${label}` : `Toggled #${t.seq} ${t.text} to ${t.done ? "done" : "open"} in session ${label}`,
          details: { ...t, session: target, ...(name !== undefined ? { name } : {}) },
        };
      }
      case "clear": {
        if (args.session !== undefined) return fail("todo clear: session selectors are not supported; clear applies only to the current session");
        const counts = clearTodos(db, sessionId, args.force === true);
        return { display: `Removed ${counts.removed} todos; kept ${counts.kept} open todos`, details: counts };
      }
      case "sessions": {
        const s = sessionSummaries(db, sessionId);
        return { display: renderSessions(s), details: s };
      }
      case "view": {
        const selector = String(args?.session ?? "all").trim();
        if (!selector.trim()) return fail("todo view: session selector must not be blank");
        const g = viewSession(db, selector, sessionId);
        if (selector !== "all" && !g.length) return fail(`todo view: session "${selector}" is unresolved or ambiguous`);
        if (selector !== "all" && !g[0].todos.length) return fail(`todo view: session "${g[0].session}" has no todos`);
        return { display: renderView(g), details: g };
      }
      case "list": {
        const t = listTodos(db, sessionId);
        return { display: renderTodos(t), details: t };
      }
      default:
        return fail(`todo: unknown op "${String(op)}"; valid ops: add, list, toggle, remove, clear, sessions, view`);
    }
  };
}
