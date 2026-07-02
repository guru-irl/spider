import { PolyglotExecutor } from "../executor.js";
import { capBytes } from "../truncate.js";

export interface ExecCtx {
  cwd: string;
}

const MAX_EXEC_OUTPUT_BYTES = 200_000;

const mk = (ctx: ExecCtx) => new PolyglotExecutor({ projectRoot: () => ctx.cwd });

const shape = (r: any) =>
  capBytes(r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : ""), MAX_EXEC_OUTPUT_BYTES);

export async function runExec(args: any, ctx: ExecCtx) {
  const res = await mk(ctx).execute({
    language: args.language,
    code: args.code,
    timeout: args.timeout,
    background: args.background,
  });
  return { text: shape(res), details: res, isError: res.exitCode !== 0 && !res.backgrounded };
}

export async function runExecFile(args: any, ctx: ExecCtx) {
  const res = await mk(ctx).executeFile({
    path: args.path,
    language: args.language,
    code: args.code,
    timeout: args.timeout,
  });
  return { text: shape(res), details: res, isError: res.exitCode !== 0 };
}

export async function runBatch(args: any, ctx: ExecCtx) {
  const ex = mk(ctx);
  const parts: string[] = [];
  let anyErr = false;
  const all: any[] = [];
  for (const [i, cmd] of (args.commands ?? []).entries()) {
    const res = await ex.execute({ language: cmd.language, code: cmd.code, timeout: cmd.timeout });
    if (res.exitCode !== 0) anyErr = true;
    all.push(res);
    parts.push(`── [${i + 1}] ${cmd.language} ──\n${res.stdout}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}`);
  }
  return { text: capBytes(parts.join("\n\n"), MAX_EXEC_OUTPUT_BYTES), details: all, isError: anyErr };
}

export function registerExecActions(register: (name: string, handler: (a: any, c: any) => any) => void) {
  register("exec", runExec);
  register("exec_file", runExecFile);
  register("batch", runBatch);
}
