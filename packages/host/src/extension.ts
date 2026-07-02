// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type ActionCtx, type SpiderArgs } from "./dispatch.js";
import { registerHooks } from "./hooks.js";
import { controlDoctor, controlConfig } from "./control.js";
import * as models from "@spider/models";
import { resolveProject, openGlobal, openProject } from "@spider/db-core";

export { registerAction };

interface PiToolAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, args: SpiderArgs, ctx: unknown): Promise<unknown>;
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

/** control routing lives in-host (doctor/config work in Phase 0). */
async function handleControl(args: SpiderArgs): Promise<unknown> {
  const command = String(args.command ?? "");
  const cwd = String(args.cwd ?? process.cwd());
  switch (command) {
    case "doctor":
      return controlDoctor(cwd);
    case "config": {
      const op = (args.op as "get" | "set") ?? "get";
      return controlConfig(op, cwd, args.key as string | undefined, args.value);
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

/** Build ONE ActionCtx per dispatch (A2): both DBs, the resolved project, and the
 *  @spider/models router. A handler routes via
 *  `ctx.models.pick(ctx.models.catalog(() => enumerate(ctx.pi as PiToolAPI)), profile)`. */
export function buildActionCtx(pi: PiToolAPI, args: SpiderArgs, sessionId: string): ActionCtx {
  const cwd = String((args as { cwd?: unknown }).cwd ?? process.cwd());
  const project = resolveProject(cwd);
  return { db: openProject(project.projectKey), globalDb: openGlobal(), project, sessionId, cwd, pi, models };
}

export default function spiderExtension(pi: PiToolAPI): void {
  // control is owned by the host from Phase 0.
  registerAction("control", (args) => handleControl(args as SpiderArgs));

  pi.registerTool({
    name: "spider",
    label: "spider",
    description:
      "spider 🕸 — unified memory, context/search, todos, subagents, and skills on one shared DB. Use `action` for everyday verbs; `action:'control'` + `command` for admin.",
    parameters: SPIDER_PARAMETERS,
    async execute(_toolCallId, args, ctx) {
      const sessionId = String((ctx as { sessionId?: unknown })?.sessionId ?? "");
      return dispatch(args, buildActionCtx(pi, args as SpiderArgs, sessionId));
    },
  });

  registerHooks(pi);
}
