// packages/host/src/dispatch.ts
import type { Db, ProjectInfo } from "@spider/db-core";

export type SpiderAction =
  | "search" | "remember" | "recall" | "exec" | "exec_file" | "batch"
  | "index" | "fetch" | "run" | "todo" | "skill" | "import" | "message" | "control" | "kill";

export interface SpiderArgs { action: SpiderAction; [k: string]: unknown; }

// Canonical action context (amendment A2 v2). Phase 0 OWNS this shape; later phases
// IMPORT it and author handlers against `(args, ctx)`. `@spider/models` is authored in
// Task 18 — the type import below resolves under `tsc -b` project references (models
// builds before host; see Task 1 host refs + Task 18 tsconfig).
export interface ActionCtx {
  db: Db;                    // worktree DB (openProject, resolved for cwd) — sessions, runs, content, todos
  repoDb: Db;                // repo DB (openRepo, resolved for repo_key) — memory, skills, curator_state
  globalDb: Db;              // global DB (registry, message_mirror, model_stats, insights)
  project: ProjectInfo;      // { projectKey, realPath, gitCommonDir?, repoKey?, dbPath, name? }
  sessionId: string;         // pi native session id, verbatim
  cwd: string;
  pi: unknown;               // pi ExtensionAPI (events, sendMessage, on, registerTool)
  auxModel?: string;         // cheap aux-model id hint from config (digest routing)
  models: typeof import("@spider/models");  // model router: catalog()/pick()/complete()
  /** Streams a cumulative, capped output snapshot to the UI while a command is still
   *  running. Set by the host from pi's `onUpdate`; undefined for non-streaming callers
   *  (subagents, tests), which is why every consumer must treat it as optional. */
  onPartial?: (text: string) => void;
  /** pi's ModelRegistry, taken from the ExtensionContext (NOT from the extension API --
   *  it does not live there). Undefined for hosts/tests that do not supply one. */
  modelRegistry?: unknown;
  /** Fully-qualified active model from ExtensionContext; used by auxiliary work. */
  parentModel?: string;
  /** The persisted `models.defaults` role->ref map (control models set), resolved once per
   *  dispatch by buildActionCtx. Subagents cannot import @spider/host to read config
   *  directly, so this is how packages/subagents/src/actions/run.ts sees it: explicit
   *  `model:` on a call -> modelDefaults[<agent role>] -> inherit the parent's model. */
  modelDefaults?: Record<string, string>;
  /** AbortSignal for the in-flight tool call. pi's real `ToolDefinition.execute(toolCallId,
   *  params, signal, onUpdate, ctx)` supplies this as its 3rd positional arg (Escape mid-run
   *  fires it); the host threads it through here so exec's runExec -> Executor.execute ->
   *  #spawn can killTree the child instead of running to completion. Undefined for callers
   *  without one (subagents, non-exec actions, legacy tests). */
  signal?: AbortSignal;
}
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<unknown> | unknown;

const VALID: ReadonlySet<string> = new Set<SpiderAction>([
  "search", "remember", "recall", "exec", "exec_file", "batch",
  "index", "fetch", "run", "todo", "skill", "import", "message", "control", "kill",
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
  if (!handler) {
    if (process.env.PI_SUBAGENT_CHILD === "1" && ["run", "message", "kill"].includes(name)) {
      return {
        code: "unavailable_in_child",
        error: `spider ${name} is unavailable inside a one-shot subagent child. The parent owns orchestration; report progress or ESCALATION[severity] in your response instead.`,
      };
    }
    return { error: `action '${name}' has no registered handler in this extension instance` };
  }
  return handler(args, ctx);
}
