import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function existing(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Never overwrite a command owned by another installation. */
export function linkRoamCommand(repoRoot, remove = false) {
  const entry = join(repoRoot, "dist", "roam", "cli.mjs");
  const command = join(homedir(), ".local", "bin", "spider");
  const prior = existing(command);
  const ours = prior?.isSymbolicLink() && resolve(dirname(command), readlinkSync(command)) === entry;
  if (remove) {
    if (ours) unlinkSync(command);
    return;
  }
  if (prior && !ours) throw new Error(`Refusing to replace an existing command at ${command}`);
  const target = lstatSync(entry);
  if (!target.isFile() || target.isSymbolicLink()) throw new Error("Build the roaming CLI before linking");
  accessSync(entry, constants.X_OK);
  if (!ours) {
    mkdirSync(dirname(command), { recursive: true, mode: 0o700 });
    symlinkSync(entry, command);
  }
}
