import { importSessions, type ImportOpts } from "../import";
import type { Db } from "@spider/db-core";

interface ActionCtx {
  db: Db;         // worktree DB
  repoDb: Db;     // repo DB
  cwd: string;
  sessionId: string;
  project?: unknown;
  auxModel?: string;
}

export async function runImport(args: any, ctx: ActionCtx): Promise<{ text: string; details: any }> {
  const s = await importSessions(ctx, args as ImportOpts);
  const text = `import: ${s.imported} imported, ${s.skipped} skipped, ${s.staged} staged, ${s.committed} committed`;
  return { text, details: s };
}

export function registerImportAction(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  register("import", runImport);
}
