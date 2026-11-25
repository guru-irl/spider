import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Db } from "@spider/db-core";
import { ensurePrivateDirectory, parseJobJournal, type JobJournal, type JournalJob } from "@spider/herdr/jobs/store";
import type { FederationBlockers, SessionAddress } from "@spider/intercom/protocol";
import { readLocalBackgroundJobs, type BlockerActivity, type BlockerPorts, type BridgeSettlement, type LocalRoute } from "./blockers.js";

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const JOB_BYTES = 1024 * 1024;
async function directory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("Unsafe evidence directory");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function readJournal(file: string, sessionId: string): Promise<JobJournal | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(JOB_BYTES)) throw new Error("Invalid job journal");
    const data = Buffer.alloc(JOB_BYTES + 1), { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > JOB_BYTES) throw new Error("Job journal exceeds limit");
    const journal = parseJobJournal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead))), sessionId as never);
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw new Error("Job journal changed during inspection");
    return journal;
  } finally { await handle.close(); }
}

/** Unlike handoff recovery, inventory never swallows a corrupt child journal. */
export async function readHostJobJournals(roots: readonly string[], sessionId: string): Promise<{ top: readonly JournalJob[]; children: readonly JournalJob[] }> {
  if (!Array.isArray(roots) || !roots.length || !ID.test(sessionId)) throw new Error("Job journal roster unavailable");
  const top: JournalJob[] = [], children: JournalJob[] = [];
  for (const root of new Set(roots)) {
    try { await ensurePrivateDirectory(root, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const sessions = join(root, "sessions"), own = join(sessions, sessionId), runs = join(own, "runs");
    if (!await directory(sessions) || !await directory(own)) continue;
    const journal = await readJournal(join(own, "jobs.json"), sessionId);
    if (journal) { if (journal.child) throw new Error("Foreign top-level journal"); top.push(...journal.jobs); }
    if (!await directory(runs)) continue;
    for (const entry of await readdir(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name) || !await directory(join(runs, entry.name))) throw new Error("Invalid child journal directory");
      const child = await readJournal(join(runs, entry.name, "jobs.json"), sessionId);
      if (!child) continue;
      if (child.child?.id !== entry.name) throw new Error("Foreign child journal");
      children.push(...child.jobs);
    }
  }
  return { top, children };
}

interface MirrorRow { id: number; from_session: string | null; to_session: string | null; kind: string | null; body: string | null; created_at: number }
async function route(db: Db, row: MirrorRow): Promise<{ kind: "local" | "bridge"; messageId: string } | null> {
  const root = join(dirname(db.raw.name), "intercom-routes");
  if (!await directory(root)) return null;
  const digest = createHash("sha256").update(JSON.stringify([db.raw.name, row.id, row.from_session, row.to_session, row.kind, row.body, row.created_at])).digest("hex");
  const file = join(root, `${row.id}-${digest}.json`);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) return null;
    const bytes = Buffer.alloc(1025), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    return (item.kind === "local" || item.kind === "bridge") && typeof item.messageId === "string" && item.messageId.length > 0 && item.messageId.length <= 256
      ? { kind: item.kind, messageId: item.messageId } : null;
  } catch { return null; } finally { await handle.close(); }
}

export interface BridgeSettlementQuery {
  messageId: string; fromSessionId: string | null; toSessionId: string | null; scopeId: string | null;
}
export type BridgeSettlementEvidence = BridgeSettlement & BridgeSettlementQuery;

/** Read pending mirror rows without constructing MessageStore, which can migrate routes. */
export async function readLocalRoutes(stores: readonly Db[], sessionId: string,
  settlement: (query: BridgeSettlementQuery) => Promise<BridgeSettlementEvidence | null>, scopeId: string | null = null): Promise<readonly LocalRoute[]> {
  if (!stores.length || !sessionId || typeof settlement !== "function") throw new Error("Route evidence unavailable");
  const result: LocalRoute[] = [];
  for (const db of stores) {
    const rows = db.prepare("SELECT id,from_session,to_session,kind,body,created_at FROM message_mirror WHERE delivered_at IS NULL AND (from_session=? OR to_session=?) ORDER BY id").all(sessionId, sessionId) as MirrorRow[];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id < 1 || !(row.from_session === null || typeof row.from_session === "string" && row.from_session.length) ||
          !(row.to_session === null || typeof row.to_session === "string" && row.to_session.length) || !Number.isSafeInteger(row.created_at)) throw new Error("Invalid route mirror");
      const observed = await route(db, row), fromSessionId = row.from_session, toSessionId = row.to_session;
      if (!observed) {
        const source = createHash("sha256").update(db.raw.name).digest("hex").slice(0, 12);
        result.push({ id: `mirror-${source}-${row.id}`, route: "unknown", fromSessionId, toSessionId });
      } else if (observed.kind === "local") result.push({ id: observed.messageId, route: "local", fromSessionId, toSessionId });
      else {
        const query = { messageId: observed.messageId, fromSessionId, toSessionId, scopeId };
        const proof = await settlement(query);
        const valid = proof && proof.messageId === query.messageId && proof.fromSessionId === fromSessionId && proof.toSessionId === toSessionId &&
          proof.scopeId === scopeId && ["receipt", "outcome", "delivered"].includes(proof.kind);
        result.push({ id: observed.messageId, route: "bridge", fromSessionId, toSessionId,
          ...(valid ? { settlement: { messageId: proof.messageId, kind: proof.kind } } : {}) });
      }
    }
  }
  return result;
}

/** The live activation supplies its existing tracker and read-only intercom views. */
export function createBlockerPorts(input: {
  sessionId: string; address: SessionAddress; activity: BlockerActivity; routeStores: readonly Db[];
  jobRoots: readonly string[]; scratchRoots: readonly string[];
  broker(address: SessionAddress): Promise<FederationBlockers>;
  bridge(address: SessionAddress): FederationBlockers | Promise<FederationBlockers>;
  settlement(query: BridgeSettlementQuery): Promise<BridgeSettlementEvidence | null>;
}): BlockerPorts {
  return {
    sessionId: input.sessionId, address: input.address, activity: input.activity,
    broker: input.broker, bridge: input.bridge,
    localRoutes: () => readLocalRoutes(input.routeStores, input.sessionId, input.settlement, input.address.scopeId),
    topLevelJobs: async () => (await readHostJobJournals(input.jobRoots, input.sessionId)).top,
    childJobs: async () => (await readHostJobJournals(input.jobRoots, input.sessionId)).children,
    localJobs: () => readLocalBackgroundJobs(input.scratchRoots),
  };
}
