// spider PACKAGE shim, generated from scripts/extension-shim.mjs.
// Rebuilt files load fresh on /reload; unchanged files reuse their module instance.
import * as piHost from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, runInThisContext } from "node:vm";
import { isNativeError } from "node:util/types";
function withLoaderWarningSuppressed<T>(fn: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function(this: unknown, ...args: unknown[]) {
    const [warning, options] = args;
    const type = isNativeError(warning) ? warning.name
      : typeof options === "string" ? options
      : options && typeof options === "object" ? (options as { type?: string }).type : undefined;
    const message = isNativeError(warning) ? warning.message : warning;
    if (type === "ExperimentalWarning" && typeof message === "string"
      && /USE_MAIN_CONTEXT_DEFAULT_LOADER|vm.*dynamic.*import.*loader/i.test(message)) return;
    return Reflect.apply(original, this, args);
  } as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}
let nativeImport: ((u: string) => Promise<{ default: (pi: unknown, ports?: unknown) => unknown }>) | undefined;
let nativeSetupError: unknown;
const loaderErrorCodes = new Set([
  "ERR_MODULE_NOT_FOUND", "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
  "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG", "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_UNKNOWN_FILE_EXTENSION", "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED", "ERR_UNSUPPORTED_DIR_IMPORT",
]);
async function fallbackImport(bundle: string, original?: unknown) {
  try {
    return await import(bundle);
  } catch (fallbackError) {
    if (original !== undefined) {
      const message = (error: unknown) => error !== null && typeof error === "object" && "message" in error
        ? String(error.message) : String(error);
      throw new AggregateError([original, fallbackError],
        message(original) + " (fallback import also failed: " + message(fallbackError) + ")");
    }
    throw fallbackError;
  }
}
if (constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER !== undefined) {
  try {
    nativeImport = withLoaderWarningSuppressed(() => runInThisContext("(u) => import(u)", {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }));
  } catch (error) {
    // Unsupported VM loader: plain import still loads spider, but needs restart after rebuilds.
    nativeSetupError = error;
  }
}
export default async function spider(pi: unknown): Promise<unknown> {
  const bundle = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
  let mod;
  if (nativeImport) {
    const stat = statSync(bundle, { bigint: true });
    const url = pathToFileURL(bundle);
    url.searchParams.set("build", stat.mtimeNs.toString() + "-" + stat.size.toString());
    try {
      // Node emits the experimental warning synchronously on the first import call.
      // Restore before awaiting so unrelated asynchronous work is never filtered.
      mod = await withLoaderWarningSuppressed(() => nativeImport!(url.href));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !loaderErrorCodes.has(code)) throw error;
      mod = await fallbackImport(bundle, error);
    }
  } else {
    mod = await fallbackImport(bundle, nativeSetupError);
  }
  const AssistantMessageComponent = piHost.AssistantMessageComponent;
  const ToolExecutionComponent = piHost.ToolExecutionComponent;
  const Markdown = piTui.Markdown;
  const Spacer = piTui.Spacer;
  const copy = piHost.copyToClipboard;
  const copyButtons = typeof AssistantMessageComponent === "function" && typeof ToolExecutionComponent === "function"
    && typeof Markdown === "function" && typeof Spacer === "function" && typeof copy === "function"
    ? { host: { AssistantMessageComponent, ToolExecutionComponent, Markdown, Spacer }, copy } : undefined;
  const inputBand = typeof piHost.CustomEditor === "function" ? {
    CustomEditor: piHost.CustomEditor, UserMessageComponent: piHost.UserMessageComponent,
    CustomMessageComponent: piHost.CustomMessageComponent, ToolExecutionComponent,
    Markdown, Box: piTui.Box, Text: piTui.Text,
  } : undefined;
  const piVersion = typeof piHost.VERSION === "string" ? piHost.VERSION : undefined;
  return mod.default(pi, { ...(copyButtons ? { copyButtons } : {}), ...(inputBand ? { inputBand } : {}), ...(piVersion === undefined ? {} : { piVersion }) });
}
