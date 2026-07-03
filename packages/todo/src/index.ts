export * from "./types";
export * from "./store";
export * from "./actions";
export * from "./renderers";
export * from "./command";

import type { Db } from "@spider/db-core";
import type { TodoDeps } from "./actions";
import { makeTodo } from "./actions";
import { makeTodosCommand } from "./command";

export type { TodoDeps };

export interface TodoPiApi {
  registerAction(name: string, handler: (args: any, ctx: any) => any): void;
  registerCommand?(name: string, def: any): void;
  on?(event: string, handler: (...a: any[]) => any): void;
}

/**
 * Register the `todo` action + `/todos` viewer against a structural pi API.
 * Kept decoupled from real pi types so the same wiring is exercised by the
 * fakePi test and, later, the host.
 */
export function registerTodo(pi: TodoPiApi, deps: TodoDeps): void {
  pi.registerAction("todo", makeTodo(deps));
  pi.registerCommand?.(
    "todos",
    makeTodosCommand({ getDb: () => deps.projectDb, getSessionId: () => deps.getSessionId() })
  );
}

// Re-export for consumers that only need the Db type at the wiring boundary.
export type { Db };
