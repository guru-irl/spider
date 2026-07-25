import { execFileSync } from "node:child_process";

/**
 * Best-effort: the command line of `pid`, or null if unknown/unsupported.
 * Uses ps on POSIX; returns null on win32, when pid is gone, ps is missing,
 * or permission is denied.
 */
export function processCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
      windowsHide: true,
    });
    return output.trim();
  } catch {
    // pid gone, ps missing, EPERM, timeout, or any other error
    return null;
  }
}

/**
 * True when pid's command line still looks like a spawned subagent.
 * 
 * Spider subagents are spawned with the distinctive argv pattern:
 *   `pi --mode json -p --session <path>` (baseArgs from buildChildSpawnSpec)
 * or on Windows:
 *   `node <pi-cli-script> --mode json -p --session <path>`
 * 
 * The combination of `--mode json` and `-p` is specific enough to identify
 * a spider subagent without matching unrelated pi invocations or other programs.
 */
export function looksLikeSubagent(
  pid: number,
  probe?: (pid: number) => string | null,
): boolean {
  const cmd = probe ? probe(pid) : processCommand(pid);
  if (!cmd) return false;
  
  // Match the distinctive subagent argv signature:
  // Must contain both "--mode json" (or "--mode=json") and "-p"
  const hasJsonMode = cmd.includes("--mode json") || cmd.includes("--mode=json");
  const hasPFlag = / -p(?:\s|$)/.test(cmd);
  
  return hasJsonMode && hasPFlag;
}
