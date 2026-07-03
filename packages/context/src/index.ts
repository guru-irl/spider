import { registerExecActions } from "./actions/exec";
import { registerIndexActions } from "./actions/index-fetch";
import { registerSearchAction } from "./actions/search";
import { registerImportAction } from "./actions/import";

export * from "./runtime";
export * from "./executor";
export * from "./truncate";
export * from "./actions/exec";
export * from "./actions/index-fetch";
export * from "./fetch";
export * from "./chunker";
export * from "./fts-query";
export * from "./content-store";
export * from "./freshness";
export * from "./fusion";
export * from "./search";
export * from "./actions/search";
export * from "./digest";
export * from "./transcript";
export * from "./import";
export * from "./actions/import";
export * from "./renderers";

export function registerContextActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  registerExecActions(register);
  registerIndexActions(register);
  registerSearchAction(register);
  registerImportAction(register);
}
