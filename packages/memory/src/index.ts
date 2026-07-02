export * from "./scanner.js";
export * from "./scrubber.js";
export * from "./types.js";
export * from "./store.js";
export * from "./overflow.js";
export * from "./staging.js";
export * from "./guardrails.js";
export * from "./aux.js";
export * from "./snapshot.js";
export * from "./embeddings/embedder.js";
export * from "./embeddings/vectors.js";
export * from "./embeddings/queue.js";
export * from "./recall.js";
export * from "./actions.js";
export * from "./hooks.js";
export * from "./renderers.js";

import type { MemoryDeps } from "./actions.js";
import { makeRemember, makeRecall, makeControl } from "./actions.js";
import { makeBeforeAgentStart, makeSessionStart } from "./hooks.js";
import { startEmbedWorker } from "./embeddings/queue.js";

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
