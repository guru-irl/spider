// packages/host/src/dispatch.ts
import type { Db, ProjectInfo } from "@spider/db-core";
import type { InjectionSnapshot } from "./injection-snapshot";

export type SpiderAction =
  | "search" | "remember" | "recall" | "exec" | "exec_file" | "batch"
  | "index" | "fetch" | "run" | "todo" | "skill" | "import" | "message" | "control" | "kill";

export interface SpiderArgs { action: SpiderAction; [k: string]: unknown; }

// Canonical action context (amendment A2 v2). Phase 0 OWNS this shape; later phases
// IMPORT it and author handlers against `(args, ctx)`. `@spider/models` is authored in
// Task 18 — the type import below resolves under `tsc -b` project references (models
// builds before host; see Task 1 host refs + Task 18 tsconfig).
export interface ActionCtx {
  db: Db;                    // run/kill/message: session worktree DB; other actions: cwd project DB
  runDbPath?: string;        // session runs DB file passed to children; may differ from project.dbPath when run has an explicit cwd
  repoDb: Db;                // repo DB (openRepo, resolved for repo_key) — memory, skills, curator_state
  globalDb: Db;              // global DB (registry, message_mirror, model_stats, insights)
  project: ProjectInfo;      // { projectKey, realPath, gitCommonDir?, repoKey?, dbPath, name? }
  sessionId: string;         // pi native session id, verbatim
  cwd: string;
  injectionCwd?: string;       // host cwd before action-context binding resolution; doctor mirrors the hook
  injectionSnapshot?: InjectionSnapshot; // captured before action context can migrate a broken DB
  pi: unknown;               // pi ExtensionAPI (events, sendMessage, on, registerTool)
  usage?: import("@spider/models").UsageSinkFactory;
  reportUsage?: (db: Db, run: import("@spider/subagents").RunRow) => void;
  auxModel?: string;         // cheap aux-model id hint from config (digest routing)
  models: typeof import("@spider/models");  // model router: catalog()/pick()/complete()
  /** Streams a cumulative, capped output snapshot to the UI while a command is still
   *  running. Set by the host from pi's `onUpdate`; undefined for non-streaming callers
   *  (subagents, tests), which is why every consumer must treat it as optional. */
  onPartial?: (text: string) => void;
  /** pi's ModelRegistry, taken from the ExtensionContext (NOT from the extension API --
   *  it does not live there). Undefined for hosts/tests that do not supply one. */
  modelRegistry?: unknown;
  /** Fully-qualified active model from ExtensionContext; used for subagent model inheritance. */
  parentModel?: string;
  /** The persisted `models.defaults` role->ref map (control models set), resolved once per
   *  dispatch by buildActionCtx. Subagents cannot import @spider/host to read config
   *  directly, so this is how packages/subagents/src/actions/run.ts sees it: explicit
   *  `model:` on a call -> modelDefaults[<agent role>] -> inherit the parent's model. */
  modelDefaults?: Record<string, string>;
  childMode?: "rpc" | "print";
  subagentOnlyExtensions?: string[];
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

const handlers = new Map<string, { handler: ActionHandler; activationOwned: boolean }>();

/** External registrations are the default; the host tags its activation closures. */
export function registerAction(name: string, handler: ActionHandler, activationOwned = false): void {
  handlers.set(name, { handler, activationOwned });
}

export function getAction(name: string): ActionHandler | undefined {
  return handlers.get(name)?.handler;
}

/** Release only this activation's closures. Omit ownership only for test reset. */
export function clearActions(owned?: ReadonlyMap<string, ActionHandler>): void {
  if (!owned) { handlers.clear(); return; }
  for (const [name, handler] of owned) {
    if (handlers.get(name)?.handler === handler) handlers.delete(name);
  }
}

export async function dispatch(args: SpiderArgs, ctx: ActionCtx, owned?: ReadonlyMap<string, ActionHandler>): Promise<unknown> {
  const name = args?.action;
  if (!name || !VALID.has(name)) return { error: `unknown action: ${String(name)}` };
  const registered = handlers.get(name);
  // A live activation never borrows another activation's closures. Direct
  // callers without an activation map retain the global dispatcher contract.
  const handler = owned?.get(name) ?? ((!owned || !registered?.activationOwned) ? registered?.handler : undefined);
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
