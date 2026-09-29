// packages/db-core/src/index.ts
export type { Db } from "./db";
export { openDb, withRetry, assertTestConfigPath } from "./db";
export { paths, projectRoot, repoRoot } from "./paths";
export type { Scope } from "./paths";
export { migrate, SCHEMA_VERSION } from "./migrate";
export { sanitizeQuery, sanitizeTrigramQuery, STOPWORDS } from "./fts-query";
export { GLOBAL_SCHEMA, REPO_SCHEMA, WORKTREE_SCHEMA } from "./schema";
export {
  resolveProject, registerProject, openGlobal, openGlobalReadOnly, openProject, openRepo, openRepoReadOnly, openDbAt, openDbReadOnlyAt, openProjectByPath, setGlobalDbPathForTests, repoRoot as repoRootFromRegistry,
} from "./registry";
export type { ProjectInfo } from "./registry";
export { bindSession, unbindSession, getBinding } from "./bindings";
export { appendRunEvent, bus, appendEvent, listEvents, eventCountsByTool } from "./events";
export type { RunEvent, EventRow } from "./events";
