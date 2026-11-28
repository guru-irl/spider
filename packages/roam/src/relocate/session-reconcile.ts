import type { MachineId } from "@spider/db-core/roam/types";
import type { Clock } from "../contracts";
import type { StopMachinePorts } from "./adapters";
import { sameManagedHome } from "./home";
import type { SessionOperations } from "./session-operations";
import { hasStopProof } from "./session-stop-store";
import type { SessionStopStore, SessionTransition, StopMode, StopObservation } from "./session-stop-types";
import type { HomeStore, SessionId, StoppedHome, V0RefusalCode } from "./types";

export interface SessionReconcilePorts {
  operations: SessionOperations;
  store: SessionStopStore;
  homes: Pick<HomeStore, "read">;
  withSession<T>(id: SessionId, run: () => Promise<T>): Promise<T>;
  machines: StopMachinePorts;
  clock: Clock;
  readyMs: number;
  localMachineId: MachineId;
  mayContact(observer: MachineId): boolean;
}

export interface SessionReconciler {
  reconcile(home: StoppedHome): Promise<void>;
  afterPeerSync(peer: MachineId): void;
  resume(): void;
  close(): Promise<void>;
}

type StopRecord = Exclude<SessionTransition, { action: "start" }>;
type Intent = "publish" | "contact" | "poll";
type Contact = {
  home: StoppedHome;
  observer: MachineId;
  flight?: Promise<void>;
  cancelTimer?: () => void;
  sentMode?: StopMode;
};

const pollMs = 10_000;
const unreachable = "Stop pending: the box is unreachable and may still be running";
const oldAgent = "Stop pending: update roaming on the box. It may still be running.";
const disabled = "Stop pending: roaming replication is disabled on the box. It may still be running.";
const unverified = "Stop pending: the box did not return verifiable Stop evidence.";

function expects(record: StopRecord, observer: MachineId): boolean {
  return record.committed.machineId === observer || record.displaced.includes(observer);
}

function accepts(contact: Contact, observation: StopObservation, previous?: StopObservation): boolean {
  if (observation.sessionId !== contact.home.sessionId || observation.machineId !== contact.observer) return false;
  // Only a contradiction may name a missing or different replica.
  if (observation.evidence.kind !== "pending" && !sameManagedHome(observation.home, contact.home)) return false;
  if (!previous || previous.bootId !== observation.bootId || previous.observedAt === null) return true;
  if (observation.observedAt === null || observation.observedAt < previous.observedAt) return false;
  if (observation.observedAt > previous.observedAt) return true;
  // Two checks can share a millisecond. Favor negative evidence over proof at a tie.
  return observation.evidence.kind === "pending" ||
    previous.evidence.kind === "confirmed" && observation.evidence.kind === "checking";
}

export function createSessionReconciler(ports: SessionReconcilePorts): SessionReconciler {
  const { operations, store, homes, machines, clock } = ports;
  const contacts = new Map<string, Contact>();
  const localChecks = new Set<Promise<StopObservation>>();
  let closing: Promise<void> | undefined;
  const keyOf = (home: StoppedHome, observer: MachineId) => JSON.stringify([home.sessionId, home.epoch, observer]);

  function saved(home: StoppedHome): StopRecord | null {
    const record = store.current(home.sessionId);
    return record && record.action !== "start" && sameManagedHome(record.committed, home) ? record : null;
  }

  async function current({ home, observer }: Contact, active: () => boolean): Promise<StopRecord | null> {
    if (!active()) return null;
    if (!sameManagedHome(await homes.read(home.sessionId), home) || !active()) return null;
    const record = saved(home);
    return record && expects(record, observer) ? record : null;
  }

  async function save(contact: Contact, active: () => boolean, reason: string | null, observation?: StopObservation) {
    if (!active()) return;
    const { home, observer } = contact;
    await operations.enqueue(home.sessionId, async () => {
      if (!active()) return;
      await ports.withSession(home.sessionId, async () => {
        const record = await current(contact, active);
        if (!record || !active()) return;
        let observations = record.observations;
        if (observation) {
          if (!accepts(contact, observation, observations.find(item => item.machineId === observer))) return;
          observations = [...observations.filter(item => item.machineId !== observer), observation];
        }
        const contactReason = observer === home.machineId ? reason : record.contactReason;
        if (observations !== record.observations || contactReason !== record.contactReason)
          store.write({ ...record, observations, contactReason });
      });
    });
  }

  async function refusal(observer: MachineId, code: V0RefusalCode, active: () => boolean) {
    if (code === "replication-disabled") return disabled;
    if (code === "source-unreachable") return unreachable;
    // A successful Stop observation proves capability. Ask hello only after an
    // ambiguous refusal, never to infer age from a failed connection.
    if (code === "invalid-arguments" && active()) {
      const hello = await machines.stopCapability(observer);
      if (hello.ok && hello.value === "old-agent") return oldAgent;
      if (!hello.ok && hello.refusal.code === "source-unreachable") return unreachable;
    }
    return unverified;
  }

  async function round(contact: Contact, intent: Intent, active: () => boolean): Promise<Intent | undefined> {
    const { home, observer } = contact;
    if (!await current(contact, active)) return;
    const onHome = observer === home.machineId;
    const local = observer === ports.localMachineId;
    let attemptedMode: StopMode | undefined;
    async function sendMode(): Promise<V0RefusalCode | null | undefined> {
      const record = await current(contact, active);
      if (!record || !active() || !onHome || hasStopProof(home, observer, record) || attemptedMode === record.mode ||
          intent === "poll" && contact.sentMode === record.mode) return undefined;
      attemptedMode = record.mode;
      const sent = await machines.ensureStopped(home, record.mode);
      if (!active()) return undefined;
      if (sent.ok) contact.sentMode = record.mode;
      return sent.ok ? null : sent.refusal.code;
    }

    if (local) {
      const refused = await sendMode();
      if (!active()) return;
      // Unlike an RPC, this check can still be using our database after the
      // contact budget expires. Its own readyMs budget bounds shutdown drain.
      const check = machines.enforceLocal(home); // Includes a Mac displaced by force.
      localChecks.add(check);
      try { await save(contact, active, refused ? unverified : null, await check); }
      finally { localChecks.delete(check); }
      return "poll";
    }

    const published = intent === "publish" && active() ? await machines.publishStopped(home, observer) : null;
    if (!active()) return;
    // For initial contact the targeted publication includes an exact v0 home
    // read-back. On sync completion observe the replica without starting sync.
    const firstRefusal = published?.ok ? await sendMode() : null;
    if (!active()) return;
    const observed = await machines.observe(observer, home);
    if (!active()) return;
    if (!observed.ok) {
      const code = published && !published.ok && published.refusal.code === "replication-disabled"
        ? "replication-disabled" : observed.refusal.code;
      const reason = await refusal(observer, code, active);
      await save(contact, active, reason);
      return reason === unreachable ? undefined : "poll";
    }
    await save(contact, active, null, observed.value);
    if (!active()) return;
    if (!sameManagedHome(observed.value.home, home)) {
      contact.sentMode = undefined;
      return "publish";
    }
    const lastRefusal = await sendMode();
    const code = lastRefusal === undefined ? firstRefusal : lastRefusal;
    if (!code || !active()) return "poll";
    const reason = await refusal(observer, code, active);
    await save(contact, active, reason);
    return reason === unreachable ? undefined : "poll";
  }

  async function start(contact: Contact, intent: Intent): Promise<void> {
    if (contact.flight) return contact.flight;
    contact.cancelTimer?.();
    contact.cancelTimer = undefined;
    const { home, observer } = contact;
    const key = keyOf(home, observer);
    if (closing || !ports.mayContact(observer)) { contacts.delete(key); return; }
    const initialMode = saved(home)?.mode;
    let expired = false;
    const active = () => !expired && ports.mayContact(observer);
    let cancel!: () => void;
    const deadline = new Promise<undefined>(resolve => {
      cancel = clock.later(ports.readyMs, () => { expired = true; resolve(undefined); });
    });
    const work = round(contact, intent, active).catch(() => undefined);
    return contact.flight = Promise.race([work, deadline]).then(next => {
      expired = true; // Ignore replies and queued writes after the budget expires.
      cancel();
      contact.flight = undefined;
      if (closing || !ports.mayContact(observer)) { contacts.delete(key); return; }
      const record = saved(home);
      if (!record || hasStopProof(home, observer, record)) { contacts.delete(key); return; }
      if (observer === home.machineId && initialMode !== record.mode && contact.sentMode !== record.mode) {
        // A Kill now can commit while the graceful RPC is already in flight.
        void start(contact, "publish").catch(() => {});
      } else if (next !== undefined) {
        schedule(contact, next, pollMs);
      } else {
        contacts.delete(key); // The sync service owns the backoff for unreachable peers.
      }
    });
  }

  function schedule(contact: Contact, intent: Intent, ms: number) {
    if (closing || contact.flight) return;
    contact.cancelTimer?.();
    contact.cancelTimer = clock.later(ms, () => { void start(contact, intent).catch(() => {}); });
  }

  function forObservers(record: StopRecord, visit: (contact: Contact) => void, peer?: MachineId) {
    for (const observer of new Set([record.committed.machineId, ...record.displaced])) {
      if (peer !== undefined && peer !== observer || !ports.mayContact(observer)) continue;
      const home = record.committed;
      const key = keyOf(home, observer);
      let contact = contacts.get(key);
      if (!contact) contacts.set(key, contact = { home, observer });
      visit(contact);
    }
  }

  return {
    async reconcile(home) {
      if (closing) return;
      const record = saved(home);
      if (!record) return;
      const rounds: Promise<void>[] = [];
      forObservers(record, contact => rounds.push(start(contact, "publish")));
      await Promise.allSettled(rounds);
    },
    afterPeerSync(peer) {
      if (closing || !ports.mayContact(peer)) return;
      // Do not wait, or call sync, inside its completion callback. A contact
      // round already awaiting this sync owns the read-back and mode send.
      for (const record of store.list()) if (record.action !== "start" && expects(record, peer))
        forObservers(record, contact => schedule(contact, "contact", 0), peer);
    },
    resume() {
      if (closing) return;
      for (const record of store.list()) if (record.action !== "start")
        forObservers(record, contact => schedule(contact, "publish", 0));
    },
    close() {
      return closing ??= (async () => {
        for (const contact of contacts.values()) contact.cancelTimer?.();
        await Promise.allSettled([...contacts.values()].map(contact => contact.flight));
        await Promise.allSettled(localChecks);
        contacts.clear();
      })();
    },
  };
}
