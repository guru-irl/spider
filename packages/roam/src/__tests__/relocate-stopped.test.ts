import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createReplica } from "@spider/db-core/testutil";
import * as hc from "@spider/herdr/client/hc";
import { DEFAULT_LIMITS, disabledIntercom, type Peer, type RoamConfig, type Transport } from "../contracts";
import { createRelocateJournal } from "../relocate/journal";
import { seedLocalPlacement } from "../relocate/local";
import * as processes from "../relocate/local-process";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import { createV0Runtime, type V0Runtime } from "../relocate/runtime";
import { createSessionStopStore } from "../relocate/session-stop-store";
import type { StopObservation } from "../relocate/session-stop-types";
import type { RelocateAdapterOptions, RelocateId, SessionId, SessionPlacement, StoppedHome } from "../relocate/types";
import { createStorePort } from "../stores";

const mac = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const destination = "33333333-3333-4333-8333-333333333333";
const id = "stopped-move" as SessionId;
const key = "worktree:fixture-repo:fixture-workspace";
const repoKey = "fixture-repo", workspaceId = "fixture-workspace";
const request = { sessionId: id, destinationMachine: destination };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

const runGit: RelocateAdapterOptions["git"]["run"] = async (cwd, argv, options) => execFileSync(argv[0], argv.slice(1), {
  cwd, input: options?.stdin, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    ...options?.env },
});

async function fixture() {
  const hub = createReplica("global", mac), from = createReplica("global", source), to = createReplica("global", destination);
  const worktree = createReplica("worktree", source), sourceRepo = createReplica("repo", source), targetRepo = createReplica("repo", destination);
  cleanup.push(hub.close, from.close, to.close, worktree.close, sourceRepo.close, targetRepo.close);
  const checkout = join(from.root, "checkout"), repository = join(to.root, "repo"), file = join(from.root, "exact.jsonl");
  mkdirSync(checkout);
  const git = (cwd: string, ...args: string[]) => runGit(cwd, ["git", ...args]);
  await git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "fixture.txt"), "base\n");
  await git(checkout, "add", "fixture.txt");
  await git(checkout, "commit", "-m", "base");
  await git(to.root, "clone", checkout, repository);
  writeFileSync(join(checkout, "fixture.txt"), "stopped work\n");
  const stamp = "2020-01-01T00:00:00Z";
  const body = JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: stamp,
    message: { role: "user", content: [{ type: "text", text: "same stopped session" }] } }) + "\n";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: checkout, timestamp: stamp }) + "\n" + body);
  const placement: SessionPlacement = { sessionId: id, machineId: source, repoKey, workspaceId, repository: checkout,
    cwd: checkout, file, stores: ["global", sourceRepo.storeKey, worktree.storeKey], historyMachine: source };
  const stopped: StoppedHome = { sessionId: id, machineId: source, epoch: 8, state: "stopped", destination: null,
    moveId: null, updatedAt: 100 };
  const running = { ...stopped, epoch: 7, state: "running" as const, updatedAt: 99 };
  for (const [replica, path, repo] of [[from, checkout, sourceRepo], [to, repository, targetRepo]] as const) {
    replica.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES (?,?,NULL)").run(repoKey, path);
    writeLocal(replica.db, "mapping-redirect", repo.storeKey, repo.db.raw.name);
  }
  for (const replica of [hub, from, to]) replica.db.exec("UPDATE roam_meta SET capture_enabled=1");
  from.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run(repoKey, workspaceId, checkout);
  writeLocal(from.db, "mapping-redirect", key, worktree.db.raw.name);
  recordLocation(from.db, { sessionId: id, stores: placement.stores, file, cwd: checkout, home: stopped });
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,8,'active')").run(id);
  hub.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,7,99,'running')").run(id, source);

  const calls: { machine: string; input: RelocateAgentRequest }[] = [];
  const launchEffects: string[] = [];
  const nodes = new Map<string, V0Runtime>();
  let now = 100_000, failMovingRead = false;
  let confirmDestination = false;
  let proofFault: "receipt" | "stale" | "older" | null = null;
  let cachedAtPublication: ReturnType<typeof cache.current> | undefined;
  const unused = async () => { throw new Error("Unexpected transport operation"); };
  const transport: Transport = {
    bootstrapProbe: unused, run: unused, write: unused,
    async read(_peer, file) { return readFileSync(file); },
    async resolve(peer) { return peer; },
    async exec(peer, argv, options) {
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      const machine = peer.machineId, agent = nodes.get(machine)!;
      const input = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      calls.push({ machine, input });
      if (input.kind === "start") return Buffer.from(JSON.stringify({ ok: false,
        refusal: { code: "home-conflict", message: "The fixture does not launch pi.", nextStep: "Inspect the saved home." } }));
      const home = await agent.homes.read(id);
      if (failMovingRead && machine === source && input.kind === "home" && home?.state === "moving") {
        failMovingRead = false;
        throw new Error("lost moving publication acknowledgement");
      }
      if (input.kind === "session-observation") {
        if (machine === source && input.home.epoch === 8 && proofFault) {
          const observation = { ...proof, ...(proofFault === "stale" ? { home: running } : { observedAt: proof.observedAt! - 1 }) };
          return Buffer.from(JSON.stringify({ ok: true, value: proofFault === "receipt"
            ? { version: 1, pending: true } : { version: 1, observation } }));
        }
        if (home?.state === "stopped" && home.epoch === 10 && (machine === source || confirmDestination)) {
          await agent.adapters.stop.enforceLocal(home); // One fixture supervisor check, without starting a service.
        }
      }
      if (machine === destination && input.kind === "home" && home?.state === "stopped") cachedAtPublication ??= cache.current(id);
      return Buffer.from(JSON.stringify(await handleRelocateAgent(input, agent.options)));
    },
  };
  const peer = (machineId: string, globalRoot: string): Peer => ({ machineId, globalRoot, alias: machineId, node: "node", pi: "pi", cli: "spider", core: "core" });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac,
    peers: [peer(source, from.root), peer(destination, to.root)], discoveryRoots: [], coreUnit: "fixture", syncMs: 120_000,
    limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] }, intercom: disabledIntercom() };
  const clock = { now: () => now, later: () => () => {} };
  vi.stubEnv("PI_CODING_AGENT_DIR", join(to.root, "agent"));
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.stubEnv("HC_SOCKET", join(hub.root, "fixture-hc.sock"));
  vi.stubEnv("HC_SESSION", "stopped-move-fixture");
  vi.spyOn(processes, "locklessPiInCheckout").mockResolvedValue([]);
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_binary, argv) => {
    if (argv[0] === "ls") return { terminals: [] };
    if (argv[0] === "run") launchEffects.push(argv.join(" "));
    throw new Error(`Unexpected Core operation: ${argv[0]}`);
  });
  const make = (replica: typeof hub, config: RoamConfig, liveHub: boolean) => {
    const runtime = createV0Runtime(replica.root, { clock, transport, gitRun: runGit, liveHub,
      openCore: () => ({ config, root: replica.root, db: replica.db, close() {} }) });
    nodes.set(config.machineId, runtime);
    cleanup.push(() => runtime.close());
    return runtime;
  };
  const src = make(from, { ...config, role: "box", machineId: source, peers: [] }, false);
  const target = make(to, { ...config, role: "box", machineId: destination, peers: [] }, false);
  const runtime = make(hub, config, true);
  const cache = createSessionStopStore(hub.db);
  await seedLocalPlacement(placement, 8, src.options);
  expect(await runtime.homes.compareAndSwap(running, stopped)).toEqual({ kind: "applied", home: stopped });
  await runtime.sync.sync(source);
  const proof = await src.adapters.stop.enforceLocal(stopped);
  expect(proof.evidence).toEqual({ kind: "confirmed", owner: null });
  function saveStop(observations: readonly StopObservation[], displaced: readonly string[] = []) {
    cache.write({ action: displaced.length ? "force" : "stop", operationId: "fixture-stop",
      expected: { ...running, machineId: displaced[0] ?? running.machineId },
      committed: stopped, mode: "hard", displaced, observations, contactReason: null });
  }
  saveStop([proof]);
  calls.length = 0;
  const moveJournal = createRelocateJournal(runtime.options.journal, mac);
  function membership(runtime: V0Runtime) {
    const stores = createStorePort(runtime.options.config, runtime.options.globalDb);
    try { return stores.openStore(key).db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id); }
    finally { stores.close(); }
  }
  return { runtime, src, target, cache, proof, stopped, calls, body, saveStop, membership, moveJournal,
    async relocate(machine = destination) { return runtime.services.relocate({ ...request, destinationMachine: machine }); },
    failMovingPublication() { failMovingRead = true; },
    faultAtCommit(fault: "before" | "after") {
      const compare = runtime.homes.compareAndSwap;
      runtime.homes.compareAndSwap = async (...args) => {
        if (args[1].machineId === destination && args[1].epoch === 10) {
          runtime.homes.compareAndSwap = compare;
          if (fault === "after") await compare(...args);
          throw new Error("lost commit reply");
        }
        return compare(...args);
      };
    },
    corruptSourceProof(fault: typeof proofFault) { proofFault = fault; },
    observeDestinationExit() { confirmDestination = true; now += 1; },
    get activationOrLaunchEffects() {
      return [...launchEffects, ...calls.flatMap(({ input }) => ["activate", "start"].includes(input.kind) ? [input.kind] : [])];
    },
    get copies() {
      return calls.filter(({ input }) => {
        if (input.kind === "capture" || input.kind === "install") return true;
        if (input.kind !== "artifact") return false;
        const { operation } = input.input as { operation: { args: { kind: string } } };
        return operation.args.kind === "session" || operation.args.kind === "workspace";
      });
    },
    get recordAtPublication() { return cachedAtPublication; },
  };
}

it.each(["install", "lost commit reply", "undo", "rollback"] as const)("keeps stopped through install, undo, and rollback: %s", async action => {
  const f = await fixture();
  if (action === "rollback") f.failMovingPublication();
  if (action === "undo" || action === "lost commit reply") f.faultAtCommit(action === "undo" ? "before" : "after");
  let reply = await f.relocate();
  const machineId = action === "undo" || action === "rollback" ? source : destination;
  if (action === "undo") {
    expect(reply).toMatchObject({ ok: false, step: "commit-home", home: { machineId: source, epoch: 9, state: "moving" } });
    reply = await f.relocate(source);
  }
  if (action === "rollback") expect(reply).toMatchObject({ ok: false, step: "mark-moving", home: { machineId, epoch: 10, state: "stopped" } });
  if (action === "lost commit reply") expect(reply).toMatchObject({ ok: false, step: "commit-home", home: { machineId, epoch: 10, state: "stopped" } });
  const committed = await f.runtime.homes.read(id);
  expect(committed).toMatchObject({ machineId, epoch: 10, state: "stopped" });
  expect(f.cache.current(id)).toMatchObject({ action: "relocate", mode: "graceful", expected: { epoch: 9, state: "moving" }, committed });
  if (machineId === destination) {
    const checkpoint = await f.moveJournal.load(committed!.moveId as RelocateId);
    expect(checkpoint!.installed).not.toBeNull();
    const file = checkpoint!.installed!.placement.file;
    const bytes = readFileSync(file, "utf8");
    expect(bytes.slice(bytes.indexOf("\n") + 1)).toBe(f.body);
    expect(readFileSync(join(checkpoint!.installed!.placement.cwd, "fixture.txt"), "utf8")).toBe("stopped work\n");
    expect(f.membership(f.target)).toEqual({ epoch: 10, state: "frozen" });
    expect(f.membership(f.src)).toEqual({ epoch: 8, state: "frozen" });
    expect(f.recordAtPublication).toMatchObject({ committed, observations: [] });
    if (action === "install") {
      expect(reply).toMatchObject({ ok: true, value: { disposition: "relocated", stop: {
        status: "stop-pending", homeEpoch: 10, observedAt: 100_000,
      } } });
      if (reply.ok) expect(reply.value).not.toHaveProperty("terminal");
    }
    expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending", homeEpoch: 10 });
    expect(f.calls.filter(({ input }) => input.kind === "seed")).toEqual([]);
    f.observeDestinationExit();
  } else {
    if (action === "undo") expect(reply).toMatchObject({ ok: true, value: { disposition: "undone", home: committed } });
    if (action === "rollback") expect(f.copies).toHaveLength(0);
    expect(f.membership(f.src)).toEqual({ epoch: 10, state: "frozen" });
  }
  const before = f.copies;
  const repeat = await f.relocate(machineId);
  expect(repeat).toMatchObject({ ok: true, value: { home: committed, disposition: "already-home", stop: { homeEpoch: 10, status: "stopped" } } });
  if (repeat.ok) expect(repeat.value).not.toHaveProperty("terminal");
  expect(f.copies).toEqual(before);
  expect(f.activationOrLaunchEffects).toEqual([]);
  if (machineId === destination) {
    expect(await f.moveJournal.load(committed!.moveId!)).toMatchObject({
      completed: ["check", "mark-moving", "stop-source", "pull-source", "push-destination", "install-destination", "commit-home"],
      terminal: null, result: null,
    });
  }
});

it.each(["receipt", "stale", "older", "displaced"] as const)("requires source proof before copying a stopped home: %s", async evidence => {
  const f = await fixture();
  if (evidence === "displaced") {
    f.saveStop([f.proof], [mac]);
    expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stop-pending", reason: `Stopped on ${source}. ${mac} may still be running.` });
  } else {
    f.corruptSourceProof(evidence);
    expect(await f.runtime.sessionStatus(id)).toMatchObject({ status: "stopped" });
  }
  expect(await f.relocate()).toMatchObject({ ok: false, step: "check", home: f.stopped, moveId: null });
  expect(await f.runtime.homes.read(id)).toEqual(f.stopped);
  expect(f.copies).toHaveLength(0);
  expect(f.calls.filter(({ input }) => input.kind === "seed")).toEqual([]);
  expect(f.activationOrLaunchEffects).toEqual([]);
  expect(f.membership(f.src)).toEqual({ epoch: 8, state: "frozen" });
  expect(existsSync(join(f.target.options.root, "agent", "sessions", "roaming"))).toBe(false);
});
