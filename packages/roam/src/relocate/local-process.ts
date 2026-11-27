import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";

export interface SessionProcess {
  pid: number;
  startIdentity: string;
  command: string;
}
interface ProcessRow { pid: number; parent: number; uid: number; command: string }
const execute = promisify(execFile);
const runOptions = { encoding: "utf8" as const, timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } };

export function isPiTitle(command: string): boolean {
  return /(?:^|[/\\])pi(?:\.exe)?$/.test(command);
}
export function insideDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function processes(): Promise<ProcessRow[]> {
  const { stdout } = await execute("/bin/ps", ["-ww", "-A", "-o", "pid=,ppid=,uid=,stat=,comm="], runOptions);
  return stdout.trimEnd().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Local process inventory could not be read");
    return match[4].startsWith("Z") ? [] : [{pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), command: match[5]}];
  });
}

/** Collect identities before shutdown can reparent the children. Do not assume an entire OS process group belongs to pi. */
export async function localDescendants(pid: number): Promise<readonly SessionProcess[]> {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of await processes()) {
    const siblings = byParent.get(row.parent) ?? [];
    siblings.push(row);
    byParent.set(row.parent, siblings);
  }
  const found: SessionProcess[] = [], seen = new Set([pid]);
  const remaining = [pid];
  while (remaining.length) for (const child of byParent.get(remaining.pop()!) ?? []) {
    if (seen.has(child.pid)) continue;
    seen.add(child.pid);
    if (child.uid !== process.getuid?.() || child.pid === process.pid) throw new Error("Local process tree is not owned by this user");
    const startIdentity = processStartIdentity(child.pid);
    if (startIdentity !== null) found.push({pid: child.pid, startIdentity, command: child.command});
    remaining.push(child.pid);
  }
  return found.reverse();
}

async function darwinCwds(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
  const result = new Map<number, string>();
  let output: string;
  // lsof's command field contains the executable name (often node), not the
  // mutable pi title. Use the PIDs found by ps, not `lsof -c pi`.
  try { ({stdout: output} = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-d", "cwd", "-F0pfn"], runOptions)); }
  catch (error) {
    const e = error as {code?: unknown; stdout?: string; stderr?: string};
    if (e.code !== 1 || e.stdout || e.stderr) throw error;
    return result;
  }
  let pid: number | null = null;
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n+/, "");
    if (field.startsWith("p")) pid = Number(field.slice(1));
    if (field.startsWith("n") && pid !== null) result.set(pid, field.slice(1));
  }
  return result;
}

export async function locklessPiInCheckout(checkout: string): Promise<readonly string[]> {
  const candidates = (await processes()).filter(row => row.uid === process.getuid?.() && isPiTitle(row.command));
  if (!candidates.length) return [];
  const darwin = process.platform === "darwin" ? await darwinCwds(candidates.map(row => row.pid)) : undefined;
  if (!darwin && process.platform !== "linux") throw new Error("Local pi cwd inspection is unavailable");
  const blockers: string[] = [];
  for (const row of candidates) {
    let cwd = darwin?.get(row.pid);
    if (!darwin) {
      try { cwd = await readlink(`/proc/${row.pid}/cwd`); }
      catch { /* A live PID without a readable cwd is uncertain. */ }
    }
    if (cwd && isAbsolute(cwd)) {
      if (insideDirectory(checkout, cwd)) blockers.push(`PID ${row.pid} (pi)`);
    } else {
      if (processStartIdentity(row.pid) !== null) blockers.push(`PID ${row.pid} (pi; working folder unavailable)`);
    }
  }
  return blockers;
}
