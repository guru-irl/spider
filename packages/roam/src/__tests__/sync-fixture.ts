import { unexpectedBootstrapProbe } from "./transport-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { seedSession } from "@spider/db-core/roam/seed";
import type { StoreKey } from "@spider/db-core/roam/types";
import { createStorePort } from "../stores";
import { handleAgentOperation, dispatchArtifactCommand } from "../agent";
import { DEFAULT_LIMITS } from "../contracts";
import type { AgentPorts, Clock, Journal, Operation, Peer, RoamConfig, Transport } from "../contracts";
import { openJournal } from "../journal";
export const HUB = "00000000-0000-4000-8000-000000000001";
export const BOX = "00000000-0000-4000-8000-000000000002";
export const BOX2 = "00000000-0000-4000-8000-000000000003";
export const BOX3 = "00000000-0000-4000-8000-000000000004";
type Replica = ReturnType<typeof createReplica>;
type Remote = { global: Replica; worktree: Replica; stores: ReturnType<typeof createStorePort>; ports: AgentPorts };
type Hook = ((peer: Peer, op: Operation) => Promise<void> | void) | null;
type ReplyHook = ((peer: Peer, op: Operation, bytes: Buffer) => Buffer) | null;
export interface Network {
  global: Replica; config: RoamConfig; stores: ReturnType<typeof createStorePort>; remotes: Map<string, Remote>;
  peers: Peer[]; journal: Journal; transport: Transport; calls: { machine: string; operation: Operation }[];
  unavailable: Set<string>; clock: Clock; timers: { ms: number; fn(): void; cancelled: boolean }[]; root: string;
  hook(fn: Hook): void; replyHook(fn: ReplyHook): void; seed(machine?: string, id?: string, text?: string): void; close(): void;
}
export function network(machineIds: string[] = [BOX]): Network {
  const global = createReplica("global", HUB);
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1").run();
  const cleanup: Array<() => void> = [() => global.close()];
  const peers: Peer[] = [];
  const remotes = new Map<string, { global: ReturnType<typeof createReplica>; worktree: ReturnType<typeof createReplica>;
    stores: ReturnType<typeof createStorePort>; ports: Parameters<typeof handleAgentOperation>[1] }>();
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers,
    discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] } };
  for (const [index, machineId] of machineIds.entries()) {
    const remote = createReplica("global", machineId), worktree = createReplica("worktree", machineId);
    remote.db.prepare("UPDATE roam_meta SET capture_enabled=1").run();
    const key = `worktree:fixture-repo:workspace-${index}` as StoreKey;
    worktree.db.prepare("UPDATE roam_meta SET store_key=?").run(key); worktree.storeKey = key;
    remote.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?, ?, ?,1,1)").run(`p${index}`, worktree.root, worktree.db.raw.name);
    const remoteConfig = { ...config, role: "box" as const, machineId, peers: [] };
    const stores = createStorePort(remoteConfig, remote.db);
    const ports = { config: remoteConfig, journal: openJournal(join(remote.root, "roam", "journal.db")), root: join(remote.root, "roam", "staging"), openStore: stores.openStore };
    peers.push({ machineId, alias: `box-${index + 1}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: remote.root });
    remotes.set(machineId, { global: remote, worktree, stores, ports });
    cleanup.push(() => { stores.close(); worktree.close(); remote.close(); });
  }
  const stores = createStorePort(config, global.db); cleanup.push(() => stores.close());
  const journal = openJournal(join(global.root, "roam", "journal.db"));
  const calls: { machine: string; operation: Operation }[] = [];
  const handles = new WeakSet<Peer>();
  const unavailable = new Set<string>();
  let hook: ((peer: Peer, op: Operation) => Promise<void> | void) | null = null;
  let replyHook: ((peer: Peer, op: Operation, bytes: Buffer) => Buffer) | null = null;
  const transport: Transport = {
    bootstrapProbe: unexpectedBootstrapProbe,
    async resolve(peer) { if (unavailable.has(peer.machineId)) throw new Error("unavailable"); const handle = Object.freeze({ ...peer }); handles.add(handle); return handle; },
    async exec(peer, argv, options) {
      if (!handles.has(peer)) throw new Error("unresolved handle");
      const remote = remotes.get(peer.machineId)!;
      if (argv[1] === "artifact") return dispatchArtifactCommand(argv, options.stdin, HUB, remote.ports);
      if (argv.length !== 3 || argv[0] !== "roam" || argv[1] !== "agent") throw new Error("unexpected command");
      const op = JSON.parse(argv[2]) as Operation;
      calls.push({ machine: peer.machineId, operation: op }); await hook?.(peer, op);
      const bytes = Buffer.from(JSON.stringify(await handleAgentOperation(op, remote.ports)));
      return replyHook?.(peer, op, bytes) ?? bytes;
    },
    async read(peer, file) { if (!handles.has(peer)) throw new Error("unresolved handle"); return readFileSync(file); },
    async write() { throw new Error("unused"); }, async run() { throw new Error("unused"); },
  };
  const timers: { ms: number; fn(): void; cancelled: boolean }[] = [];
  const clock: Clock = { now: () => 1_000_000, later(ms, fn) { const timer = { ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  return { global, config, stores, remotes, peers, journal, transport, calls, unavailable, clock, timers,
    root: join(global.root, "roam", "staging"),
    hook(fn: typeof hook) { hook = fn; }, replyHook(fn: typeof replyHook) { replyHook = fn; },
    seed(machine = BOX, id = "session-a", text = "portable") {
      const { worktree } = remotes.get(machine)!;
      worktree.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?,?,1)").run(id, text);
      worktree.db.prepare("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES (?,?,1,?,1)").run(`todo-${id}`, id, text);
      seedSession(worktree.db, id, 1, worktree.storeKey, 4 * 1024 * 1024);
    },
    close() { for (const fn of cleanup.reverse()) fn(); },
  };
}
