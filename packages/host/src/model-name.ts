import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

type Registry = Pick<ExtensionContext["modelRegistry"], "find" | "getAll" | "getAvailable">;

/** Resolve labels at render time so provider catalog refreshes remain visible. */
export function modelName(registry: Registry | undefined, ref: string): string | undefined {
  if (!registry || !ref) return undefined;
  const clean = (name: string | undefined) => name && stripTerminalSequences(name).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  try {
    const slash = ref.indexOf("/");
    const qualified = slash >= 0 ? registry.find?.(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
    if (qualified) return clean(qualified.name) || undefined;
    for (const getModels of [() => registry.getAvailable?.() ?? [], () => registry.getAll?.() ?? []]) {
      for (const model of getModels()) {
        if (model.id === ref) {
          const name = clean(model.name);
          if (name) return name;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
