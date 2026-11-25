import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { mapRepository, mapWorkspace } from "@spider/db-core/roam/repo-map";
import { openFreezeJournal } from "../journal";
import { checkoutName, moveCheckoutPath, resolveMoveCheckout } from "../move-checkout";
import { snapshotWorkspace } from "../workspace";
import { DEFAULT_LIMITS } from "../contracts";

const HUB = "00000000-0000-4000-8000-000000000001", WORKSPACE = "12345678-0000-4000-8000-000000000003";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function git(root: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }) {
  return execFileSync("git", [...argv], { cwd: root, input: options?.stdin, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", ...options?.env } });
}
async function fixture() {
  const global = createReplica("global", HUB); fixtures.push(global);
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const repository = join(global.root, "mapped-repo"); mkdirSync(repository);
  git(repository, ["init", "-q", "--initial-branch=main"]); writeFileSync(join(repository, "tracked.txt"), "original\n");
  git(repository, ["add", "."]); git(repository, ["commit", "-qm", "fixture"]);
  await mapRepository(global.db, { repoKey: "fixture-repo", path: repository });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const input = { globalDb: global.db, root: global.root, repoKey: "fixture-repo", workspaceId: WORKSPACE, sourceName: "source-checkout", moveId: "move-a", journal,
    git: { run: async (root: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }) => git(root, argv[0] === "git" ? argv.slice(1) : argv, options) } };
  const path = join(global.root, "roam", "checkouts", "mapped-repo-40080b8c38fc", "source-checkout-12345678");
  return { global, repository, input, path };
}
it("uses bounded readable names and independent identity suffixes", () => {
  expect(moveCheckoutPath("/fixture/global", "fixture-repo", "/fixture/✨", WORKSPACE, "🚀")).toBe("/fixture/global/roam/checkouts/repo-40080b8c38fc/checkout-12345678");
  expect(checkoutName("a b/c✨", "checkout")).toBe("abc");
  expect(checkoutName("a".repeat(50), "repo")).toBe("a".repeat(40));
});
it("refuses a mapped generated path that is not a registered Git checkout", async () => {
  const f = await fixture(); mkdirSync(f.path, { recursive: true, mode: 0o700 }); writeFileSync(join(f.path, "private.txt"), "untouched\n");
  await mapWorkspace(f.global.db, { repoKey: "fixture-repo", workspaceId: WORKSPACE, path: f.path });
  await expect(resolveMoveCheckout(f.input)).rejects.toMatchObject({ code: "move-checkout-conflict" });
});
it("retains a registered absolute mapping after the global root changes", async () => {
  const f = await fixture(); mkdirSync(join(f.global.root, "roam", "checkouts", "mapped-repo-40080b8c38fc"), { recursive: true, mode: 0o700 });
  git(f.repository, ["worktree", "add", "--detach", f.path]);
  await mapWorkspace(f.global.db, { repoKey: "fixture-repo", workspaceId: WORKSPACE, path: f.path });
  f.input.journal.begin({ id: "baseline", kind: "workspace-snapshot", machineId: HUB, expectedEpoch: null, args: {} });
  const baseline = await snapshotWorkspace({ root: f.path, cwd: f.path, repoKey: f.input.repoKey, workspaceId: WORKSPACE,
    moveId: "baseline", stage: "final", writers: [] }, { ...f.input.git, journal: f.input.journal, limits: DEFAULT_LIMITS,
    scratch: join(f.global.root, "roam", "git"), worktreeCommand: null });
  f.global.db.prepare("UPDATE roam_workspace_maps SET snapshot_json=? WHERE repo_key=? AND workspace_id=?")
    .run(JSON.stringify(baseline), f.input.repoKey, WORKSPACE);
  const nextRoot = join(f.global.root, "next-root"); mkdirSync(nextRoot, { mode: 0o700 });
  expect(await resolveMoveCheckout({ ...f.input, root: nextRoot })).toEqual({ kind: "mapped", path: f.path });
});
it("does not reuse another workspace with the same readable path prefix", async () => {
  const f = await fixture(); mkdirSync(join(f.global.root, "roam", "checkouts", "mapped-repo-40080b8c38fc"), { recursive: true, mode: 0o700 });
  git(f.repository, ["worktree", "add", "--detach", f.path]);
  await mapWorkspace(f.global.db, { repoKey: "fixture-repo", workspaceId: "12345678-0000-4000-8000-000000000004", path: f.path });
  await expect(resolveMoveCheckout(f.input)).rejects.toMatchObject({ code: "move-checkout-conflict" });
});
