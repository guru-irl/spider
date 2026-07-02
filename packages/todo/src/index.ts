export * from "./types.js";
export * from "./store.js";
export * from "./actions.js";
export * from "./renderers.js";
export * from "./command.js";

import type { Db } from "@spider/db-core";
import type { TodoDeps } from "./actions.js";
import { makeTodo } from "./actions.js";
import { makeTodosCommand } from "./command.js";

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
  pi.registerCommand?.("todos", makeTodosCommand(deps));
}

// Re-export for consumers that only need the Db type at the wiring boundary.
export type { Db };
