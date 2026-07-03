// packages/host/src/dispatch.ts
import type { Db, ProjectInfo } from "@spider/db-core";

export type SpiderAction =
  | "search" | "remember" | "recall" | "exec" | "exec_file" | "batch"
  | "index" | "fetch" | "run" | "todo" | "skill" | "import" | "message" | "control";

export interface SpiderArgs { action: SpiderAction; [k: string]: unknown; }

// Canonical action context (amendment A2 v2). Phase 0 OWNS this shape; later phases
// IMPORT it and author handlers against `(args, ctx)`. `@spider/models` is authored in
// Task 18 — the type import below resolves under `tsc -b` project references (models
// builds before host; see Task 1 host refs + Task 18 tsconfig).
export interface ActionCtx {
  db: Db;                    // project DB (openProject, resolved for cwd)
  globalDb: Db;              // global DB (registry, message_mirror, model_stats, insights)
  project: ProjectInfo;      // { projectKey, realPath, gitCommonDir?, dbPath, name? }
  sessionId: string;         // pi native session id, verbatim
  cwd: string;
  pi: unknown;               // pi ExtensionAPI (events, sendMessage, on, registerTool)
  auxModel?: string;         // cheap aux-model id hint from config (digest routing)
  models: typeof import("@spider/models");  // model router: catalog()/pick()/complete()
}
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<unknown> | unknown;

const VALID: ReadonlySet<string> = new Set<SpiderAction>([
  "search", "remember", "recall", "exec", "exec_file", "batch",
  "index", "fetch", "run", "todo", "skill", "import", "message", "control",
]);

const handlers = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler): void {
  handlers.set(name, handler);
}

export function getAction(name: string): ActionHandler | undefined {
  return handlers.get(name);
}

/** Test-only: reset the registry between cases. */
export function clearActions(): void {
  handlers.clear();
}

export async function dispatch(args: SpiderArgs, ctx: ActionCtx): Promise<unknown> {
  const name = args?.action;
  if (!name || !VALID.has(name)) return { error: `unknown action: ${String(name)}` };
  const handler = handlers.get(name);
  if (!handler) return { error: `action '${name}' is not yet implemented (Phase 0 stub)` };
  return handler(args, ctx);
}
