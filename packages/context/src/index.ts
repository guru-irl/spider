import { registerExecActions } from "./actions/exec.js";

export * from "./runtime.js";
export * from "./executor.js";
export * from "./truncate.js";
export * from "./actions/exec.js";

export function registerContextActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  registerExecActions(register);
}
