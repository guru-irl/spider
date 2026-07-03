// packages/db-core/src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";

export type Scope = "global" | "project";

const GLOBAL_ROOT = join(homedir(), ".pi", "agent", "spider");

export function projectRoot(cwd: string): string {
  return join(cwd, ".spider");
}

function rootFor(scope: Scope, cwd?: string): string {
  if (scope === "global") return GLOBAL_ROOT;
  if (!cwd) throw new Error("paths: project scope requires cwd");
  return projectRoot(cwd);
}

export const paths: {
  globalRoot: string;
  models: string;
  projectRoot: (cwd: string) => string;
  scratch: (scope: Scope, cwd?: string) => string;
  logs: (scope: Scope, cwd?: string) => string;
} = {
  globalRoot: GLOBAL_ROOT,
  models: join(GLOBAL_ROOT, "models"),
  projectRoot: projectRoot,
  scratch: (scope: Scope, cwd?: string): string => {
    return join(rootFor(scope, cwd), "scratch");
  },
  logs: (scope: Scope, cwd?: string): string => {
    return join(rootFor(scope, cwd), "logs");
  },
};
