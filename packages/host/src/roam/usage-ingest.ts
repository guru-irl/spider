import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { discoverUsageSources, type UsageRoots } from "../usage/discovery.js";
import { ingestOnce } from "../usage/ingest.js";
import { acquireUsageLease } from "../usage/lease.js";
import { openUsageLedger } from "../usage/ledger.js";

const CHUNK = 4 * 1024 * 1024;
const LEASE_MS = 120_000;

/** A bounded synchronous ledger writer, run only after the activation's worker drains. */
export function createUsageIngestThrough(roots: UsageRoots, sessionId: string, machineId: string): (file: string, size: number) => Promise<void> {
  return async (file, size) => {
    if (!isAbsolute(file) || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024 * 1024 || !sessionId || !machineId)
      throw new Error("Invalid frozen usage source");
    const path = await realpath(file);
    if (path !== resolve(file)) throw new Error("Unsafe frozen usage source");
    const before = await stat(path);
    if (!before.isFile() || before.size !== size) throw new Error("Frozen usage source changed");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, bytesRead).indexOf(10);
      if (end < 0 || end > 64 * 1024) throw new Error("Frozen usage source identity unavailable");
      const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)));
      if (!header || typeof header !== "object" || Array.isArray(header) || (header as Record<string, unknown>).type !== "session" ||
          (header as Record<string, unknown>).id !== sessionId) throw new Error("Frozen usage source identity unavailable");
    } finally { await handle.close(); }
    const discovery = await discoverUsageSources(roots);
    const source = discovery.sources.find(item => item.path === path);
    if (!source || source.roaming?.localMachine !== machineId) throw new Error("Frozen usage source identity unavailable");
    const ledger = openUsageLedger(roots.ledgerFile);
    let lease: ReturnType<typeof acquireUsageLease>;
    try { lease = acquireUsageLease(ledger, "ingest", `${process.pid}:${randomUUID()}`, Date.now, LEASE_MS); }
    catch (error) { ledger.close(); throw error; }
    if (!lease) { ledger.close(); throw new Error("Usage ingest lease unavailable"); }
    try {
      const limit = 16 + Math.ceil(size / CHUNK) * 4;
      for (let attempt = 0; attempt < limit; attempt++) {
        if (!lease.renew(Date.now)) throw new Error("Usage ingest lease lost");
        const previous = ledger.getImportState(path);
        await ingestOnce(ledger, discovery, Date.now(), new AbortController().signal,
          { sourcePaths: [path], maxBytes: CHUNK, skipShared: true, commitGuard: () => lease.isCurrent(Date.now) });
        const state = ledger.getImportState(path), after = await stat(path);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== size || after.mtimeMs !== before.mtimeMs)
          throw new Error("Frozen usage source changed");
        if (state && state.inode === `${before.dev}:${before.ino}` && state.size === size && state.offset === size) return;
        if (!state || previous && state.offset === previous.offset && state.generation === previous.generation) throw new Error("Usage ingest did not reach the frozen boundary");
      }
      throw new Error("Usage ingest exceeded the frozen boundary budget");
    } finally { try { lease.release(); } finally { ledger.close(); } }
  };
}
