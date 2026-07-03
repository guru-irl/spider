// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type ActionCtx, type SpiderArgs } from "./dispatch.js";
import { registerHooks } from "./hooks.js";
import { registerContextActions, runImport } from "@spider/context";
import { toToolResult } from "./result.js";
import { controlDoctor, controlConfig } from "./control.js";
import { registerRouting, DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing/index.js";
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
    command: { type: "string", description: "Sub-command when action='control'." },
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
export function enumerate(pi: PiToolAPI) {
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
    label: "spider",
    description:
      "spider 🕸 — unified memory, context/search, todos, subagents, and skills on one shared DB. Use `action` for everyday verbs; `action:'control'` + `command` for admin.",
    parameters: SPIDER_PARAMETERS,
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
