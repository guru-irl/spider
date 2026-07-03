// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type ActionCtx, type SpiderArgs } from "./dispatch";
import { registerHooks } from "./hooks";
import { registerContextActions, runImport } from "@spider/context";
import { toToolResult } from "./result";
import { controlDoctor, controlConfig } from "./control";
import { registerRouting, DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing/index";
import { ContentStore } from "@spider/context";
import { enqueueEmbed } from "@spider/memory";
import * as models from "@spider/models";
import { resolveProject, openGlobal, openProject, type Db } from "@spider/db-core";
import {
  stageWrite, recall, listPending, approvePending, rejectPending,
  activeCharTotal, listActive, resolveEmbedder, type Embedder,
  renderRememberResult, renderRecallResult, renderPending,
} from "@spider/memory";
import { makeTodo, makeTodosCommand } from "@spider/todo";
import { registerSubagentActions } from "@spider/subagents";
import { installAgentsUI } from "./agents/agents-ui";
import { renderSpiderResult } from "./render-result";

export { registerAction };

// Lazily-cached embedder shared across recall calls (avoids re-resolving the
// model per dispatch). resolveEmbedder degrades to null → recall falls back to FTS.
let _emb: Promise<Embedder | null> | undefined;
const getEmbedder = () => (_emb ??= resolveEmbedder());

// Routing owns tool_call/tool_result, which carry NO sessionId — so we keep a
// mutable ref updated at session_start and hand routing a getter over it.
let currentSessionId = "";

/** DEFAULT_ROUTING_CONFIG merged with any overrides stored under routing.* keys.
 *  Best-effort: never throws; on any doubt returns a fresh default clone. */
function readRoutingConfig(cwd: string): RoutingConfig {
  const cfg: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG };
  try {
    const tracking = controlConfig("get", cwd, "routing.tracking");
    if (typeof tracking === "boolean") cfg.tracking = tracking;
    const secretScrub = controlConfig("get", cwd, "routing.secret_scrub");
    if (typeof secretScrub === "boolean") cfg.secretScrub = secretScrub;
    const injectionScan = controlConfig("get", cwd, "routing.injection_scan");
    if (typeof injectionScan === "boolean") cfg.injectionScan = injectionScan;
    const threshold = controlConfig("get", cwd, "routing.auto_index_threshold");
    if (typeof threshold === "number" && Number.isFinite(threshold)) cfg.autoIndexThreshold = threshold;
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG };
  }
  return cfg;
}

/** Large-output indexer handed to routing: store chunks in the content KB and
 *  enqueue their embeddings. Best-effort; swallows all errors. */
function makeIndexer(db: Db) {
  return (text: string, source: string) => {
    try {
      const store = new ContentStore(db);
      const r = store.indexContent({ content: text, source });
      const sel = db.prepare("SELECT chunk FROM content WHERE id = ?");
      for (const id of r.ids) {
        const row = sel.get(id) as { chunk?: string } | undefined;
        if (row?.chunk) enqueueEmbed(db, "content", String(id), row.chunk);
      }
    } catch {}
  };
}

// scope + per-call DB selection (ctx-native: reuse the DBs buildActionCtx resolved).
const scopeOf = (a: any) => (a?.scope === "global" ? "global" : "project");
const dbFor = (scope: "global" | "project", ctx: ActionCtx | undefined) =>
  scope === "global" ? ctx!.globalDb : ctx!.db;

interface PiToolAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
    execute(toolCallId: string, params: SpiderArgs, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
  }): void;
  registerCommand?(name: string, def: unknown): void;
  on(name: string, fn: (...args: unknown[]) => unknown): void;
}

const SPIDER_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "search", "remember", "recall", "exec", "exec_file", "batch",
        "index", "fetch", "run", "wait", "todo", "skill", "import", "message", "control",
      ],
      description: "The spider verb to run.",
    },
    // control
    command: { type: "string", description: "Sub-command when action='control' (e.g. 'doctor','config','memory')." },
    op: { type: "string", enum: ["get", "set"], description: "control config op." },
    key: { type: "string", description: "control config key." },
    value: { description: "control config value (for op='set')." },
    sub: { type: "string", description: "control memory sub-command." },
    uuid: { type: "string", description: "pending-memory uuid for approve/reject." },
    // scope / cwd (most actions)
    scope: { type: "string", enum: ["global", "project"], description: "Memory/registry scope (default project)." },
    cwd: { type: "string", description: "Working-directory override." },
    // search / recall
    query: { type: "string", description: "Query text for action 'search' or 'recall'." },
    category: { type: "string", description: "Memory category (remember) or filter (recall)." },
    limit: { type: "number", description: "Max results (search/recall)." },
    // remember
    content: { type: "string", description: "Text to store for action 'remember' (or index/fetch body)." },
    link: { type: "string", description: "Optional link/url to attach to a remembered item." },
    auto: { type: "boolean", description: "Mark a remembered item as auto-captured." },
    // run / subagents
    agent: { type: "string", description: "SINGLE-mode agent/role for action 'run' (e.g. 'scout','worker','reviewer')." },
    name: { type: "string", description: "SINGLE-mode display name for the spawned subagent (surfaced in the UI; defaults to a slug of the task)." },
    task: { type: "string", description: "SINGLE-mode task text for action 'run'." },
    tasks: {
      type: "array",
      description: "PARALLEL-mode: subagents to run concurrently. Give each a short descriptive `name`.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          name: { type: "string", description: "Short display name surfaced in the UI." },
          task: { type: "string" },
          count: { type: "integer", minimum: 1 },
          model: { type: "string" },
          context: { type: "string", enum: ["fresh", "fork"] },
        },
        required: ["agent", "task"],
      },
    },
    chain: {
      type: "array",
      description: "CHAIN-mode: sequential steps ({previous} passed forward).",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          name: { type: "string", description: "Short display name surfaced in the UI." },
          task: { type: "string" },
          model: { type: "string" },
          context: { type: "string", enum: ["fresh", "fork"] },
        },
      },
    },
    pipeline: { type: "array", description: "PIPELINE-mode stages (advanced push-based auto-wake).", items: { type: "object" } },
    concurrency: { type: "integer", minimum: 1, description: "PARALLEL max concurrent (default 4)." },
    model: { type: "string", description: "Model override for spawned subagent(s)." },
    skill: { type: "string", description: "Skill the spawned subagent should follow." },
    context: { type: "string", enum: ["fresh", "fork"], description: "Child context: fresh, or fork from this session." },
    async: { type: "boolean", description: "Run subagent(s) in the background and return immediately." },
    // wait
    id: { type: "string", description: "Run id/prefix for action 'wait' (also a todo id)." },
    all: { type: "boolean", description: "action 'wait': wait for ALL active runs." },
    timeoutMs: { type: "integer", minimum: 1, description: "Give up after N ms (wait/message)." },
    // message
    to: { type: "string", description: "Target session name/id for action 'message'." },
    message: { type: "string", description: "Message body for action 'message'." },
    // todo
    text: { type: "string", description: "Todo text for action 'todo' (add)." },
    // exec
    code: { type: "string", description: "Code to run for action 'exec'/'exec_file'." },
    language: { type: "string", description: "Language for action 'exec'." },
    // index / fetch
    url: { type: "string", description: "URL for action 'fetch'." },
    source: { type: "string", description: "Source label for action 'index'/'fetch'." },
    path: { type: "string", description: "File/dir path for action 'index'/'exec_file'." },
  },
  required: ["action"],
  additionalProperties: true,
};

/** control routing lives in-host (doctor/config work in Phase 0; memory in Phase 1). */
async function handleControl(args: SpiderArgs, ctx?: ActionCtx): Promise<unknown> {
  const command = String(args.command ?? "");
  const cwd = String(args.cwd ?? process.cwd());
  switch (command) {
    case "doctor":
      return controlDoctor(cwd);
    case "config": {
      const op = (args.op as "get" | "set") ?? "get";
      return controlConfig(op, cwd, args.key as string | undefined, args.value);
    }
    case "memory": {
      const scope = scopeOf(args);
      const db = dbFor(scope, ctx);
      switch (args.sub) {
        case "pending": {
          const recs = listPending(db, scope);
          return { display: renderPending(recs), details: recs };
        }
        case "approve":
          return { details: approvePending(db, scope, args.uuid as string) };
        case "reject":
          rejectPending(db, scope, args.uuid as string);
          return { details: { ok: true, uuid: args.uuid } };
        case "consolidate":
          return { details: { entries: listActive(db, scope), usage: activeCharTotal(db, scope) } };
        default:
          return { error: `control memory sub '${String(args.sub)}' unknown` };
      }
    }
    case "migrate": {
      if (!ctx) return { error: "migrate requires an action context" };
      return runImport(args as any, ctx as any);
    }
    default:
      return { error: `control command '${command}' is not yet implemented (Phase 0)` };
  }
}

// enumerate = pi's model surface ∩ availability (VALIDATE-FIRST A6: confirm listModels/availableModels).
export function enumerate(pi: PiToolAPI): Array<{ provider: string; id: string; available: boolean; reasoning: boolean; vision: boolean; ctx: number }> {
  const list = (pi as any).listModels?.() ?? (pi as any).availableModels ?? [];
  return list.map((m: any) => ({
    provider: m.provider ?? m.providerId, id: m.id,
    available: m.available !== false, reasoning: !!m.reasoning, vision: !!m.vision, ctx: m.contextWindow,
  }));
}

/** Extract the pi native session id from a tool-execute ExtensionContext. Real pi
 *  `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` passes ExtensionContext
 *  as its 5th arg; its read-only `sessionManager.getSessionId()` is the session id source (A6). */
export function sessionIdOf(ctx: unknown): string {
  const sm = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager;
  return sm?.getSessionId?.() ?? "";
}

/** The authoritative working directory from a tool-execute ExtensionContext (types.d.ts:216). */
export function cwdOf(ctx: unknown): string | undefined {
  const c = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof c === "string" ? c : undefined;
}

/** Build ONE ActionCtx per dispatch (A2): both DBs, the resolved project, and the
 *  @spider/models router. A handler routes via
 *  `ctx.models.pick(ctx.models.catalog(() => enumerate(ctx.pi as PiToolAPI)), profile)`. */
export function buildActionCtx(pi: PiToolAPI, args: SpiderArgs, sessionId: string, ctxCwd?: string): ActionCtx {
  const cwd = String((args as { cwd?: unknown }).cwd ?? ctxCwd ?? process.cwd());
  const project = resolveProject(cwd);
  return { db: openProject(project.projectKey), globalDb: openGlobal(), project, sessionId, cwd, pi, models };
}

export default function spiderExtension(pi: PiToolAPI): void {
  // control is owned by the host from Phase 0; ctx is threaded for memory routing.
  registerAction("control", (args, ctx) => handleControl(args as SpiderArgs, ctx));

  // in-process exec/exec_file/batch handlers (Phase 2 Task 4).
  // Strangler: spider owns exec/exec_file/batch/index/fetch/search/import in-process; legacy context-mode ctx_* MCP tools are deprecated (spider does not register them).
  registerContextActions(registerAction);
  // subagents runtime: run/wait/message (child-guard + shutdown teardown handled inside).
  registerSubagentActions({ registerAction }, pi);

  // memory verbs (ctx-native): use the per-call ActionCtx DBs buildActionCtx resolved.
  registerAction("remember", async (args, ctx) => {
    const scope = scopeOf(args);
    const r = stageWrite(dbFor(scope, ctx), scope, {
      category: args.category as any,
      content: args.content as string,
      link: (args.link as string | null) ?? null,
      source: args.auto ? "auto" : "user",
    });
    return { display: renderRememberResult(r), details: r };
  });

  registerAction("recall", async (args, ctx) => {
    const scope = scopeOf(args);
    const embedder = await getEmbedder();
    const recs = await recall(dbFor(scope, ctx), scope, args.query as string, embedder, {
      category: args.category as any,
      limit: args.limit as number | undefined,
    });
    return { display: renderRecallResult(recs), details: recs };
  });

  // todos (ctx-native): dispatch always supplies ctx.db + ctx.sessionId, so the
  // action needs no closure deps; the /todos command resolves db+session per call.
  registerAction("todo", makeTodo());
  pi.registerCommand?.(
    "todos",
    makeTodosCommand({
      getDb: (ctx) => openProject(resolveProject(cwdOf(ctx) ?? process.cwd()).projectKey),
      getSessionId: (ctx) => sessionIdOf(ctx),
    })
  );

  // NOTE: the background embed worker is intentionally NOT started here (no eager
  // DB opens / lingering timers at registration). recall degrades to FTS when no
  // vectors exist; the embed worker is wired in a later integration task.

  pi.registerTool({
    name: "spider",
    label: "🕸 spider",
    description:
      "spider 🕸 — unified memory, context/search, todos, and subagents on one shared DB. Set `action` to the verb. Key params by action: search/recall→query; remember→content(+category); run→ SINGLE {agent,task} · PARALLEL {tasks:[{agent,task}]} · CHAIN {chain:[{agent,task}]}, plus async:true to run in the background; wait→id|all; message→{to,message}; todo→text; control→command('doctor'|'config'|'memory'). Every `run` needs a concrete `task` string — never call run without one.",
    parameters: SPIDER_PARAMETERS,
    renderResult: renderSpiderResult,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      // Normalize the handler result into pi's AgentToolResult shape (content = model-facing
      // text blocks, details = structured payload). TUI Component rendering is separate
      // (renderResult, wired in the UI phase).
      const r = await dispatch(args, buildActionCtx(pi, args as SpiderArgs, sessionIdOf(ctx), cwdOf(ctx)));
      return toToolResult(r);
    },
  });

  registerHooks(pi);

  // Keep the mutable session id fresh: tool_call/tool_result events carry no
  // sessionId, so routing reads it via getSessionId() over this ref. pi.on
  // chains, so hooks.ts's own session_start handler still runs too.
  pi.on("session_start", (event: any) => {
    currentSessionId = String(event?.sessionId ?? currentSessionId);
    return undefined;
  });

  // Mount the live agents UI (footer + Ctrl+Shift+G grid + /agents) on session_start.
  // pi.on chains, so this runs alongside the currentSessionId updater above. The
  // mount is best-effort — never break the session if the UI can't initialize.
  let disposeAgentsUI: (() => void) | undefined;
  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      if (!ctx?.hasUI) return undefined;
      disposeAgentsUI?.();
      const cwd = cwdOf(ctx) ?? process.cwd();
      const db = openProject(resolveProject(cwd).projectKey);
      const sessionId = sessionIdOf(ctx) || currentSessionId;
      disposeAgentsUI = installAgentsUI(pi as any, ctx as any, { db, sessionId });
    } catch { /* UI mount best-effort; never break the session */ }
    return undefined;
  });
  pi.on("session_shutdown", () => {
    try { disposeAgentsUI?.(); disposeAgentsUI = undefined; } catch {}
    return undefined;
  });

  // Wire routing/safety at LOAD: the edit/write tool overrides must be registered
  // before pi builds its tool registry (registering them later would be too late).
  // Best-effort — never break extension load.
  try {
    const routingCwd = process.cwd();
    const routingDb = openProject(resolveProject(routingCwd).projectKey);
    registerRouting(pi as any, {
      db: routingDb,
      getSessionId: () => currentSessionId,
      getCwd: () => routingCwd,
      config: readRoutingConfig(routingCwd),
      indexLargeOutput: makeIndexer(routingDb),
    });
  } catch {
    /* routing is best-effort; never break extension load */
  }
}
