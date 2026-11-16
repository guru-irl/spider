import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { join } from "node:path";
import { type Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { Diagnostic } from "./contracts";
import { unboundMoveEffects, moveEffectReason, type MoveAdapterBindings } from "./move-ports";
export function recordMoveBindings(db: Db, bindings: MoveAdapterBindings): void {
  const missing = unboundMoveEffects(bindings);
  writeLocal(db, "move-bindings", "inventory", { missing });
}
export function readMoveBindingDiagnostics(root: string, file: string = join(root, "spider.db")): Diagnostic[] {
  const all = unboundMoveEffects();
  let db: Db | undefined;
  try {
    db = openDiagnosticSnapshot(file);
    const value = db ? readLocal<{ missing?: unknown }>(db, "move-bindings", "inventory") : null;
    if (!value) return [{ reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }];
    if (!Array.isArray(value.missing) || value.missing.some(effect => typeof effect !== "string" || !all.includes(effect))) throw new Error("move-binding-inventory-invalid");
    return value.missing.map(effect => ({ reason: moveEffectReason(effect), severity: "block", repairCommand: "spider roam doctor" }));
  } catch { return [{ reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }]; }
  finally { db?.close(); }
}
