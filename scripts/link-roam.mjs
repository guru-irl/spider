import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function existing(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameEntry(command, target, entry) {
  if (target === entry) return true;
  try { return realpathSync(command) === realpathSync(entry); }
  catch { return false; }
}

function replaceableLink(command, target) {
  try { statSync(command); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return true;
    throw error;
  }
  const checkout = dirname(dirname(dirname(target)));
  if (join(checkout, "dist", "roam", "cli.mjs") !== target) return false;
  try { return JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).name === "@guru-irl/spider"; }
  catch { return false; }
}

/** Never overwrite a command owned by another installation. */
export function linkRoamCommand(repoRoot, remove = false) {
  try {
    const entry = join(repoRoot, "dist", "roam", "cli.mjs");
    const command = join(homedir(), ".local", "bin", "spider");
    const prior = existing(command);
    const target = prior?.isSymbolicLink() ? resolve(dirname(command), readlinkSync(command)) : null;
    const ours = target !== null && sameEntry(command, target, entry);
    if (remove) {
      if (ours) unlinkSync(command);
      return;
    }
    const cli = existing(entry);
    if (!cli?.isFile()) throw new Error("Build the roaming CLI before linking");
    accessSync(entry, constants.X_OK);
    if (prior && !ours) {
      if (target === null || !replaceableLink(command, target)) {
        throw new Error(`Refusing to replace an existing command at ${command}`);
      }
      unlinkSync(command);
    }
    if (!ours) {
      mkdirSync(dirname(command), { recursive: true, mode: 0o700 });
      symlinkSync(entry, command);
    }
  } catch (error) {
    console.warn(`warning: could not link the roaming command. ${error instanceof Error ? error.message : String(error)}`);
  }
}
