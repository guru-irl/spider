// packages/host/src/control-bind.ts
import type { Db } from "@spider/db-core";
import { bindSession, unbindSession } from "@spider/db-core";
import { registerAction } from "./dispatch";

export interface BindResult {
  ok: boolean;
  message?: string;
  path?: string;
}

export interface UnbindResult {
  ok: boolean;
  message?: string;
}

const SCOPE_RULE = `"Is this still true after I delete this worktree?" → **repo**
"Is this true in every repo?" → **global**
otherwise → **worktree**`;

export function controlBind(db: Db, sessionId: string, path: string): BindResult {
  try {
    bindSession(db, sessionId, path);
    
    const message = `Session bound to ${path}

Memory scope rule:
${SCOPE_RULE}`;

    return { ok: true, message, path };
  } catch (error) {
    return { ok: false, message: `Failed to bind session: ${(error as Error).message}` };
  }
}

export function controlUnbind(db: Db, sessionId: string): UnbindResult {
  try {
    unbindSession(db, sessionId);
    return { ok: true, message: "Session unbound" };
  } catch (error) {
    return { ok: false, message: `Failed to unbind session: ${(error as Error).message}` };
  }
}

/** Register bind/unbind actions with the dispatcher */
export function registerControlBindActions(): void {
  // Note: bind/unbind are handled via handleControl in extension.ts
  // This registration is for test isolation
}
