import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import type { GitPorts, Journal } from "./contracts";
import { MoveCompositionError } from "./move-failure";

export type MoveCheckout = { kind: "mapped" | "create"; path: string };
export function checkoutName(value: string, fallback: "repo" | "checkout"): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || fallback;
}
export function moveCheckoutPath(root: string, repoKey: string, repository: string, workspaceId: string, sourceName: string): string {
  return join(root, "roam", "checkouts", `${checkoutName(basename(repository), "repo")}-${createHash("sha256").update(repoKey).digest("hex").slice(0, 12)}`,
    `${checkoutName(sourceName, "checkout")}-${workspaceId.slice(0, 8)}`);
}
function conflict(): never { throw new MoveCompositionError("move-checkout-conflict"); }
function directory(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return conflict(); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) conflict();
  return true;
}
/** Only pre-stage creates directories. Existing roots and mapping paths are never migrated. */
export function checkoutParents(root: string, path: string, create = false): void {
  if (!isAbsolute(root) || resolve(root) !== root || !directory(root) || !path.startsWith(`${root}/roam/checkouts/`)) conflict();
  const parents = path.slice(root.length + 1).split("/").slice(0, -1);
  let current = root;
  for (const part of parents) {
    current = join(current, part);
    if (create) try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") conflict(); }
    if (!directory(current)) return;
    if ((lstatSync(current).mode & 0o077) !== 0) conflict();
  }
}
/** An absent workspace is a typed creation plan, not permission to occupy a native checkout. */
export async function resolveMoveCheckout(input: {
  globalDb: Db; root: string; repoKey: string; workspaceId: string; sourceName?: unknown; moveId: string;
  git: Pick<GitPorts, "run">; journal: Journal;
}): Promise<MoveCheckout> {
  const { globalDb, root, repoKey, workspaceId, sourceName, moveId, git, journal } = input;
  try { storeScope(`worktree:${repoKey}:${workspaceId}`); } catch { conflict(); }
  const mapped = globalDb.prepare("SELECT path,snapshot_json FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(repoKey, workspaceId) as { path: string; snapshot_json: string | null } | undefined;
  const repo = globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key=?").get(repoKey) as { path: string } | undefined;
  const registered = async (repository: string, path: string): Promise<void> => {
    let listed: Buffer;
    try { listed = await git.run(repository, ["git", "worktree", "list", "--porcelain", "-z"]); } catch { conflict(); }
    if (!listed.toString("utf8").split("\0").includes(`worktree ${path}`)) conflict();
  };
  if (mapped) {
    if (!isAbsolute(mapped.path) || !directory(mapped.path)) conflict();
    if (sourceName !== undefined && (!repo || !isAbsolute(repo.path))) throw new MoveCompositionError("move-workspace-unmapped");
    if (repo && isAbsolute(repo.path)) await registered(repo.path, mapped.path);
    if (sourceName !== undefined && mapped.snapshot_json === null) {
      // A crash between map publication and baseline persistence may resume its own preparation.
      const prepared = journal.read(moveId).some(row => {
        if (row.action !== "workspace-prepared" || row.result.root !== mapped.path || typeof row.result.snapshotJson !== "string") return false;
        try {
          const snapshot = JSON.parse(row.result.snapshotJson);
          return snapshot.repoKey === repoKey && snapshot.workspaceId === workspaceId && snapshot.moveId === moveId;
        } catch { return false; }
      });
      if (!prepared) conflict();
    }
    return { kind: "mapped", path: mapped.path };
  }
  if (!repo || !isAbsolute(repo.path) || sourceName === undefined) throw new MoveCompositionError("move-workspace-unmapped");
  if (typeof sourceName !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(sourceName) || !/^[A-Za-z0-9._-]{1,160}$/.test(workspaceId)) conflict();
  const path = moveCheckoutPath(root, repoKey, repo.path, workspaceId, sourceName);
  checkoutParents(root, path);
  if (directory(path)) {
    const occupying = globalDb.prepare("SELECT repo_key,workspace_id FROM roam_workspace_maps WHERE path=?").get(path);
    if (occupying) conflict();
    await registered(repo.path, path);
    const ownSnapshot = journal.read(moveId).some(row => {
      if (!["workspace-prepare-start", "workspace-prepared"].includes(row.action) || row.result.root !== path || typeof row.result.snapshotJson !== "string") return false;
      try {
        const snapshot = JSON.parse(row.result.snapshotJson);
        return snapshot.repoKey === repoKey && snapshot.workspaceId === workspaceId && snapshot.moveId === moveId &&
          typeof snapshot.root === "string" && checkoutName(basename(snapshot.root), "checkout") === sourceName;
      } catch { return false; }
    });
    if (!ownSnapshot) conflict();
  }
  return { kind: "create", path };
}
