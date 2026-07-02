import { importSessions, type ImportCtx, type ImportOpts } from "../import.js";

export async function runImport(args: any, ctx: ImportCtx) {
  const s = await importSessions(ctx, args as ImportOpts);
  const text = `import: ${s.imported} imported, ${s.skipped} skipped, ${s.staged} staged, ${s.committed} committed`;
  return { text, details: s };
}

export function registerImportAction(register: (name: string, handler: (a: any, c: any) => any) => void) {
  register("import", runImport);
}
