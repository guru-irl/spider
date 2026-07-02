// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type ActionCtx, type SpiderArgs } from "./dispatch.js";
import { registerHooks } from "./hooks.js";
import { controlDoctor, controlConfig } from "./control.js";
import * as models from "@spider/models";
import { resolveProject, openGlobal, openProject } from "@spider/db-core";
import {
  stageWrite, recall, listPending, approvePending, rejectPending,
  activeCharTotal, listActive, resolveEmbedder, type Embedder,
  renderRememberResult, renderRecallResult, renderPending,
} from "@spider/memory";
import { makeTodo, makeTodosCommand } from "@spider/todo";

export { registerAction };

// Lazily-cached embedder shared across recall calls (avoids re-resolving the
// model per dispatch). resolveEmbedder degrades to null → recall falls back to FTS.
let _emb: Promise<Embedder | null> | undefined;
const getEmbedder = () => (_emb ??= resolveEmbedder());

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
      return dispatch(args, buildActionCtx(pi, args as SpiderArgs, sessionIdOf(ctx), cwdOf(ctx)));
    },
  });

  registerHooks(pi);
}
