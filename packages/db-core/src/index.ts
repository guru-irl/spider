// packages/db-core/src/index.ts
export type { Db } from "./db.js";
export { openDb, withRetry } from "./db.js";
export { paths, projectRoot } from "./paths.js";
export type { Scope } from "./paths.js";
export { migrate, SCHEMA_VERSION } from "./migrate.js";
export { GLOBAL_SCHEMA, PROJECT_SCHEMA } from "./schema.js";
export {
  resolveProject, registerProject, openGlobal, openProject, openDbAt, openProjectByPath, setGlobalDbPathForTests,
} from "./registry.js";
export type { ProjectInfo } from "./registry.js";
export { appendRunEvent, bus } from "./events.js";
export type { RunEvent } from "./events.js";
