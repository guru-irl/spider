// packages/db-core/src/index.ts
export type { Db } from "./db";
export { openDb, withRetry } from "./db";
export { paths, projectRoot } from "./paths";
export type { Scope } from "./paths";
export { migrate, SCHEMA_VERSION } from "./migrate";
export { GLOBAL_SCHEMA, PROJECT_SCHEMA } from "./schema";
export {
  resolveProject, registerProject, openGlobal, openProject, openDbAt, openProjectByPath, setGlobalDbPathForTests,
} from "./registry";
export type { ProjectInfo } from "./registry";
export { appendRunEvent, bus, appendEvent, listEvents, eventCountsByTool } from "./events";
export type { RunEvent, EventRow } from "./events";
