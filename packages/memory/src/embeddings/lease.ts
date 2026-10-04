import { openSync, closeSync, writeFileSync, readFileSync, statSync, unlinkSync, futimesSync } from "node:fs";
import { randomUUID } from "node:crypto";

const STALE_MS = 2 * 60 * 1000;

export function getEmbedLeaseState(dbPath: string): { pid?: number; ageMs: number; stale: boolean } | undefined {
  try {
    const path = `${dbPath}.embed-lock`;
    const ageMs = Math.max(0, Date.now() - statSync(path).mtimeMs);
    let pid: number | undefined;
    try { const holder = JSON.parse(readFileSync(path, "utf8")); if (Number.isSafeInteger(holder.pid)) pid = holder.pid; } catch { /* incomplete holder */ }
    let stale = ageMs > STALE_MS;
    if (pid !== undefined && pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) { stale ||= (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    return { pid, ageMs, stale };
  } catch { return undefined; }
}

/** Called inside an IMMEDIATE claim transaction to serialize stale-file reclamation.
 * A heartbeat keeps a live owner fresh; pid reuse cannot preserve an expired lease. */
export function acquireEmbedLease(dbPath: string): (() => void) | undefined {
  const path = `${dbPath}.embed-lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now(), token })); }
      catch (error) { closeSync(fd); throw error; }
      const owns = () => JSON.parse(readFileSync(path, "utf8")).token === token;
      const heartbeat = setInterval(() => {
        try { if (owns()) { const now = new Date(); futimesSync(fd, now, now); } }
        catch { /* A reclaimed lease must not refresh its replacement. */ }
      }, 5000);
      heartbeat.unref();
      let released = false;
      return () => {
        if (released) return;
        released = true; clearInterval(heartbeat);
        try { if (owns()) unlinkSync(path); }
        catch { /* The lease may already be gone. */ }
        finally { closeSync(fd); }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const before = statSync(path);
        let stale = Date.now() - before.mtimeMs > STALE_MS;
        try {
          const holder = JSON.parse(readFileSync(path, "utf8"));
          if (Number.isSafeInteger(holder.pid) && holder.pid > 0) {
            try { process.kill(holder.pid, 0); }
            catch (error) { stale ||= (error as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch { /* Incomplete files expire by mtime too. */ }
        if (!stale) return undefined;
        const current = statSync(path);
        if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) return undefined;
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
  }
  return undefined;
}
