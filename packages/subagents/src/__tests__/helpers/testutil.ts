import { openDbAt, paths, type Db } from "@spider/db-core";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function freshDb(): Db {
  return openDbAt(join(paths.scratch("project", process.cwd()), `subagents-${randomUUID()}.db`), "project");
}
