import { parseLocationStores } from "@spider/db-core/roam/catalog";
import type { StoreKey } from "@spider/db-core/roam/types";

/** Catalog worktrees are discovery scopes, not the complete move barrier roster. */
export function completeMoveRoster(stores: unknown, current?: { repo_key: string; workspace_id: string }): StoreKey[] {
  const required = parseLocationStores(stores);
  if (current) required.push(...parseLocationStores([`worktree:${current.repo_key}:${current.workspace_id}`]));
  const roster = new Set<StoreKey>(["global"]);
  for (const key of required) {
    if (key.startsWith("worktree:")) roster.add(`repo:${key.slice("worktree:".length, key.lastIndexOf(":"))}`);
    roster.add(key);
  }
  return [...roster];
}
