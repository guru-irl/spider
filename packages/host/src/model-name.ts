import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

type Registry = Pick<ExtensionContext["modelRegistry"], "find" | "getAll" | "getAvailable">;
type CatalogModel = NonNullable<ReturnType<Registry["find"]>>;

function modelValue<T>(registry: Registry | undefined, ref: string, value: (model: CatalogModel) => T | undefined): T | undefined {
  if (!registry || !ref) return undefined;
  try {
    const slash = ref.indexOf("/");
    const qualified = slash >= 0 ? registry.find?.(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
    if (qualified) return value(qualified);
    for (const getModels of [() => registry.getAvailable?.() ?? [], () => registry.getAll?.() ?? []]) {
      for (const model of getModels()) {
        if (model.id === ref) {
          const found = value(model);
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Resolve labels at render time so provider catalog refreshes remain visible. */
export function modelName(registry: Registry | undefined, ref: string): string | undefined {
  return modelValue(registry, ref, model => model.name && stripTerminalSequences(model.name).replace(/[\x00-\x1f\x7f]/g, " ").trim() || undefined);
}

/** Resolve a model's context window with the same catalog precedence as its name. */
export function modelContextWindow(registry: Registry | undefined, ref: string): number | undefined {
  return modelValue(registry, ref, model => {
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return undefined;
    const rounded = Math.max(1, Math.round(model.contextWindow));
    return Number.isSafeInteger(rounded) ? rounded : undefined;
  });
}
