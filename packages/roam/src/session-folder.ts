import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { MoveCompositionError } from "./move-failure";

/** Check on the source machine before seeding, homing or freezing a move. */
export async function assertStandardSessionFile(file: string, sessionsDir: string): Promise<void> {
  let transcript: string, folder: string;
  try { transcript = await realpath(file); }
  catch { throw new MoveCompositionError("participant-header-invalid"); }
  try { folder = await realpath(sessionsDir); }
  catch (error) {
    throw new MoveCompositionError((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "move-session-dir-unsupported" : "participant-config-unavailable");
  }
  const child = relative(folder, transcript);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new MoveCompositionError("move-session-dir-unsupported");
}
