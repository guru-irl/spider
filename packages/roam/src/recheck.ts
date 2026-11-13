import { type Db, validateRoamLayout } from "@spider/db-core";
import { repairTodoSequenceIndex } from "@spider/db-core/roam/layout";

export function recheckWorktree(db: Db): void {
  const meta = db.prepare("SELECT roamable,problem FROM roam_meta WHERE id=1").get() as { roamable: number; problem: string | null } | undefined;
  if (!meta) throw new Error("Missing roaming store metadata");
  if (meta.roamable === 0 && meta.problem?.startsWith("Duplicate todo sequence for row IDs ")) repairTodoSequenceIndex(db);
  const layout = validateRoamLayout(db, "worktree");
  if (!layout.captureSafe) throw new Error("Worktree store is not safe for roaming");
}
