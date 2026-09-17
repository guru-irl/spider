import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session events carry a reason, not an ID. The current context owns identity. */
export function sessionIdOf(ctx: unknown): string {
  const sm = (ctx as Partial<Pick<ExtensionContext, "sessionManager">> | undefined)?.sessionManager;
  const id = sm?.getSessionId?.();
  return typeof id === "string" ? id : "";
}

/** Prefer the session CWD over the process CWD (sessions can switch worktrees). */
export function cwdOf(ctx: unknown): string | undefined {
  const cwd = (ctx as Partial<Pick<ExtensionContext, "cwd">> | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

export function parentModelOf(ctx: unknown): string | undefined {
  const model = (ctx as Partial<Pick<ExtensionContext, "model">> | undefined)?.model;
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}
