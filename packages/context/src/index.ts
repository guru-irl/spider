import { registerExecActions } from "./actions/exec.js";
import { registerIndexActions } from "./actions/index-fetch.js";
import { registerSearchAction } from "./actions/search.js";
import { registerImportAction } from "./actions/import.js";

export * from "./runtime.js";
export * from "./executor.js";
export * from "./truncate.js";
export * from "./actions/exec.js";
export * from "./actions/index-fetch.js";
export * from "./fetch.js";
export * from "./chunker.js";
export * from "./fts-query.js";
export * from "./content-store.js";
export * from "./freshness.js";
export * from "./fusion.js";
export * from "./search.js";
export * from "./actions/search.js";
export * from "./digest.js";
export * from "./transcript.js";
export * from "./import.js";
export * from "./actions/import.js";
export * from "./renderers.js";

export function registerContextActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  registerExecActions(register);
  registerIndexActions(register);
  registerSearchAction(register);
  registerImportAction(register);
}
