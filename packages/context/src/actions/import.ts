import { importSessions, type ImportCtx, type ImportOpts } from "../import";

export async function runImport(args: any, ctx: ImportCtx): Promise<{ text: string; details: any }> {
  const s = await importSessions(ctx, args as ImportOpts);
  const text = `import: ${s.imported} imported, ${s.skipped} skipped, ${s.staged} staged, ${s.committed} committed`;
  return { text, details: s };
}

export function registerImportAction(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  register("import", runImport);
}
