// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type SpiderArgs } from "./dispatch.js";
import { registerHooks } from "./hooks.js";
import { controlDoctor, controlConfig } from "./control.js";

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
      // Phase 0 stub: cast pi's raw tool ctx. Task 20 replaces this with
      // buildActionCtx(pi, args, sessionId) to carry both DBs + the @spider/models
      // router on a concrete ActionCtx (amendment A2).
      return dispatch(args, ctx as unknown as import("./dispatch.js").ActionCtx);
    },
  });

  registerHooks(pi);
}
