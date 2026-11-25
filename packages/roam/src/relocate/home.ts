import { isRoamUuid } from "@spider/db-core/roam/codec";
import { validUnicode } from "@spider/db-core/roam/hlc";
import type { MachineId } from "@spider/db-core/roam/types";
import type { HomeStore, HomeStoreOptions, RelocateHome, RelocateId, RunningHome, SessionId } from "./types";

type HomeRow = Record<string, unknown>;
const COLUMNS = "session_id, machine_id, epoch, move_id, updated_at, state, destination";

function sessionId(value: unknown): asserts value is SessionId {
  if (!validUnicode(value) || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid home session ID");
}
function machineId(value: unknown): asserts value is MachineId {
  if (!isRoamUuid(value)) throw new Error("Invalid home machine ID");
}
function epoch(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid home epoch");
}
function moveId(value: unknown): asserts value is RelocateId | null {
  if (value !== null && (typeof value !== "string" || !value.startsWith("v0-") || !isRoamUuid(value.slice(3))))
    throw new Error("Invalid home move ID");
}

/** State-null rows belong to the unchanged legacy path, not v0 admission. */
function parseHome(row: HomeRow | undefined): RelocateHome | null {
  if (!row) return null;
  if (row.state === null && row.destination === null) return null;
  sessionId(row.session_id); machineId(row.machine_id); epoch(row.epoch); moveId(row.move_id);
  if (typeof row.updated_at !== "number" || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0)
    throw new Error("Invalid home timestamp");
  const identity = { sessionId: row.session_id, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at };
  if (row.state === "moving") {
    machineId(row.destination);
    if (row.move_id === null) throw new Error("Moving home requires a move ID");
    return { ...identity, state: "moving", destination: row.destination, moveId: row.move_id };
  }
  if ((row.state === "running" || row.state === "stopped") && row.destination === null)
    return { ...identity, state: row.state, destination: null };
  throw new Error("Invalid home state or destination");
}

function row(home: RelocateHome): HomeRow {
  return { session_id: home.sessionId, machine_id: home.machineId, epoch: home.epoch,
    move_id: home.moveId, updated_at: home.updatedAt, state: home.state, destination: home.destination };
}
function same(a: RelocateHome | null, b: RelocateHome): boolean {
  return a !== null && a.sessionId === b.sessionId && a.machineId === b.machineId && a.epoch === b.epoch &&
    a.state === b.state && a.destination === b.destination && a.moveId === b.moveId && a.updatedAt === b.updatedAt;
}

export function createHomeStore(options: HomeStoreOptions): HomeStore {
  const { db, hubMachineId, localMachineId } = options;
  machineId(hubMachineId); machineId(localMachineId);
  const find = (id: SessionId) => db.prepare(`SELECT ${COLUMNS} FROM session_homes WHERE session_id=?`).get(id) as HomeRow | undefined;
  function requireHub(): void {
    if (localMachineId !== hubMachineId) throw new Error("Only the hub may mutate homes");
    const meta = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as HomeRow | undefined;
    if (meta?.machine_id !== localMachineId || (meta.store_key !== "global" && meta.store_key !== null))
      throw new Error("Home database identity does not match the hub");
  }
  return {
    async read(id) { sessionId(id); return parseHome(find(id)); },
    async list() {
      const rows = db.prepare(`SELECT ${COLUMNS} FROM session_homes ORDER BY session_id`).all() as HomeRow[];
      return rows.map(parseHome).filter((home): home is RelocateHome => home !== null);
    },
    async initialize(id, sourceMachine) {
      sessionId(id); machineId(sourceMachine);
      return db.withRetry(() => db.raw.transaction(() => {
        requireHub();
        const old = find(id);
        if (old) {
          if (old.machine_id !== sourceMachine) throw new Error("Home owner does not match the source");
          const managed = parseHome(old);
          if (managed) {
            if (managed.state !== "running") throw new Error("Home is already managed and not running");
            return managed;
          }
          if (old.move_id !== null) throw new Error("Unfinished legacy home move cannot be adopted");
          epoch(old.epoch);
          db.prepare("UPDATE session_homes SET state='running', destination=NULL, updated_at=? WHERE session_id=?").run(Date.now(),id);
        } else {
          db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?, ?, 1, NULL, ?, 'running', NULL)")
            .run(id, sourceMachine, Date.now());
        }
        return parseHome(find(id)) as RunningHome;
      }).immediate());
    },
    async compareAndSwap(expected, next) {
      if (!parseHome(row(expected)) || !parseHome(row(next))) throw new Error("CAS requires managed homes");
      if (expected.sessionId !== next.sessionId || expected.epoch === Number.MAX_SAFE_INTEGER || next.epoch !== expected.epoch + 1)
        throw new Error("Home CAS must increment exactly one safe epoch");
      return db.withRetry(() => db.raw.transaction(() => {
        requireHub();
        const current = parseHome(find(expected.sessionId));
        if (same(current, next)) return {kind:"already-applied" as const,home:current!};
        const result = db.prepare(`UPDATE session_homes SET machine_id=?, epoch=?, move_id=?, updated_at=?, state=?, destination=?
          WHERE session_id=? AND machine_id=? AND epoch=? AND state=? AND destination IS ? AND move_id IS ? AND updated_at=?`)
          .run(next.machineId,next.epoch,next.moveId,next.updatedAt,next.state,next.destination,
            expected.sessionId,expected.machineId,expected.epoch,expected.state,expected.destination,expected.moveId,expected.updatedAt);
        const home = parseHome(find(expected.sessionId));
        return result.changes === 1 ? {kind:"applied" as const,home:home!} : {kind:"conflict" as const,home};
      }).immediate());
    },
  };
}
