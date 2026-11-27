import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { readLocal } from "@spider/db-core/roam/local-state";
import { inspectSession } from "../session-file";
import { parsePlacement } from "./journal";
import { refusal } from "./remote";
import { readAvailableProjectDb, skippedProjectDbNotice } from "./session-catalog";
import type { LocalSource } from "./local";
import type { RelocateAdapterOptions, SessionId, V0Result } from "./types";

/** Ordinary Mac startup registers a project but does not enable box capture. */
export async function discoverOrdinarySource(id: SessionId, options: RelocateAdapterOptions): Promise<V0Result<LocalSource>> {
  if (options.config.role !== "hub" || options.config.machineId !== options.config.hubMachineId || !options.config.enabled) return refusal("session-not-found", "The session has no local location.");
  const home = await options.homes.read(id);
  if (home && (home.machineId !== options.config.machineId || !(home.epoch === 1 && home.moveId === null || home.state === "moving" && home.epoch === 2))) return refusal("home-conflict", "An existing home cannot be rediscovered as an ordinary source.");
  const projects: { root: string; workspaceId: string | null }[] = [];
  let skipped = 0;
  for (const row of options.globalDb.prepare("SELECT DISTINCT db_path FROM projects").all() as { db_path: string }[]) {
    const project = readAvailableProjectDb(row.db_path, db => {
      const session = db.prepare("SELECT origin_machine FROM sessions WHERE id=?").get(id) as { origin_machine: string | null } | undefined;
      if (!session) return null;
      const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string } | undefined;
      if (session.origin_machine !== options.config.machineId || meta?.machine_id !== options.config.machineId) return refusal("home-conflict", "The ordinary session is not locally owned.");
      const member = db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id) as { epoch: number; state: string } | undefined;
      if (member && (member.epoch !== 1 || member.state !== "active")) return refusal("home-conflict", "The ordinary session already has conflicting capture state.");
      return { ok: true, value: readLocal<string>(db, "workspace", "id") ?? null } as const;
    });
    if (project === undefined) { skipped++; continue; }
    if (!project) continue;
    if (!project.ok) return project;
    projects.push({ root: await realpath(dirname(dirname(row.db_path))), workspaceId: project.value });
  }
  if (projects.length === 0 && skipped > 0) return refusal("session-not-found", `No registered local project contains the session. ${skippedProjectDbNotice(skipped)}`, "Restore the session's project database, then retry.");
  if (projects.length !== 1) return refusal(projects.length ? "ambiguous-session" : "session-not-found", "The session needs exactly one registered local project.");
  const sessions = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
  const files: string[] = []; let visited = 0;
  for (const directory of await readdir(sessions, { withFileTypes: true })) {
    if (++visited > 10000) throw new Error("Session discovery limit exceeded");
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    for (const file of await readdir(join(sessions, directory.name), { withFileTypes: true })) {
      if (++visited > 10000) throw new Error("Session discovery limit exceeded");
      if (file.isFile() && !file.isSymbolicLink() && file.name.endsWith(`_${id}.jsonl`)) files.push(join(sessions, directory.name, file.name));
    }
  }
  if (files.length !== 1) return refusal(files.length ? "ambiguous-session" : "session-not-found", "The session needs exactly one native transcript.");
  const transcript = await inspectSession(files[0], id, undefined, options.limits), cwd = await realpath(transcript.cwd);
  const root = await realpath((await options.git.run(cwd, ["git", "rev-parse", "--show-toplevel"])).toString().trim());
  const relativeCwd = relative(root, cwd);
  if (root !== projects[0].root || isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) return refusal("unsupported-workspace", "The native transcript is outside its registered checkout.");
  const maps = options.globalDb.prepare("SELECT repo_key,path,worktree_command_json FROM roam_repo_maps WHERE path=?").all(root) as { repo_key: string; path: string; worktree_command_json: string | null }[];
  if (maps.length !== 1) return refusal("repo-unmapped", "The ordinary repository needs a local mapping.", "Run spider roam repo map for this repository, then retry.");
  if (maps[0].worktree_command_json !== null) return refusal("unsupported-workspace", "Configured worktree commands are not supported by v0.");
  const mapped = options.globalDb.prepare("SELECT workspace_id FROM roam_workspace_maps WHERE repo_key=? AND path=?").get(maps[0].repo_key, root) as { workspace_id: string } | undefined;
  const workspaceId = mapped?.workspace_id ?? projects[0].workspaceId ?? `v0-${createHash("sha256").update(root).digest("hex").slice(0, 32)}`;
  const placement = parsePlacement({ sessionId: id, machineId: options.config.machineId, repoKey: maps[0].repo_key, workspaceId, repository: maps[0].path, cwd, file: files[0], stores: ["global", `repo:${maps[0].repo_key}`, `worktree:${maps[0].repo_key}:${workspaceId}`], historyMachine: options.config.machineId });
  const head = (await options.git.run(root, ["git", "rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  return { ok: true, value: { placement, epoch: 1, state: "active", root, relativeCwd, head } };
}
