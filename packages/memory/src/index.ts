export * from "./scanner";
export * from "./scrubber";
export * from "./types";
export * from "./store";
export * from "./overflow";
export * from "./staging";
export * from "./guardrails";
export * from "./aux";
export * from "./snapshot";
export * from "./embeddings/embedder";
export * from "./embeddings/vectors";
export * from "./embeddings/queue";
export * from "./recall";
export * from "./actions";
export * from "./hooks";
export * from "./renderers";

import type { MemoryDeps } from "./actions";
import { makeRemember, makeRecall, makeControl } from "./actions";
import { makeBeforeAgentStart, makeSessionStart } from "./hooks";
import { startEmbedWorker } from "./embeddings/queue";

export interface MemoryPiApi {
  registerAction(name: string, handler: (args: any, ctx: any) => any): void;
  on(event: string, handler: (...a: any[]) => any): void;
}

/**
 * Register the memory actions + hooks against a structural pi API and start the
 * background embed worker. Kept decoupled from real pi types so the same wiring
 * can be exercised by the fakePi test and the host.
 */
export function registerMemory(pi: MemoryPiApi, deps: MemoryDeps): void {
  pi.registerAction("remember", makeRemember(deps));
  pi.registerAction("recall", makeRecall(deps));
  pi.registerAction("control", makeControl(deps));

  pi.on("before_agent_start", makeBeforeAgentStart(deps));
  pi.on("session_start", makeSessionStart(deps));

  // Unref'd background worker; stop() intentionally ignored.
  startEmbedWorker(deps.projectDb, deps.getEmbedder);
}
