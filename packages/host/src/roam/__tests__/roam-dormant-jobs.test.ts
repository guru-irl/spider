import { afterEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { createJobStore, type JournalJob } from "@spider/herdr/jobs/store";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { MessageStore } from "../../../../subagents/src/message-store.js";
import { createHostMoveBindings } from "../move-runtime.js";

const machine = "11111111-1111-4111-8111-111111111111";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

it("dormant inspection finds a job written at the host journal root", async () => {
  const global = createReplica("global", machine), worktree = createReplica("worktree", machine);
  fixtures.push(global, worktree); new MessageStore(global.db);
  const sessionId = "owner", key = "worktree:fixture:workspace" as const;
  worktree.db.prepare("UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1").run(key);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(sessionId, machine);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,2,'active')").run(sessionId);
  const file = join(worktree.root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: worktree.root }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  mkdirSync(join(global.root, "herdr"), { mode: 0o700 });
  mkdirSync(join(global.root, "scratch"), { mode: 0o700 });
  writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root,
    core: { binary: join(global.root, "hc"), config: join(global.root, "core.json") },
    agentDirectory: join(global.root, "agent"), shellRc: join(global.root, "shell.rc"), machines: [] }), { mode: 0o600 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: machine, hubMachineId: machine,
    peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId, transport: {} as never });
  try {
    const empty = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
    const context = { sessionId, file, cwd: worktree.root, home: null, journal, stores: [global.db, worktree.db], expectedStores: ["global", key],
      intercom: { address: { sessionId, scopeId: null }, ports: {} },
      evidence: { broker: { inspectFreezeBlockers: async () => empty }, bridge: async () => empty, settlement: async () => null },
      authorizeAbort: async () => null, authorizeRetire: async () => null, onHubRestored: () => () => {}, retryAbort: async () => {} };
    const inspect = runtime.bindings.participant!.dormant(context as never);
    const operation = { id: "inspect", kind: "session-inspect", machineId: machine, expectedEpoch: 2, args: { sessionId, moveId: "move" } };
    expect(await inspect(operation)).toMatchObject({ code: 0, value: { blockers: [] } });

    const owner = { sessionId, generation: "generation", cwd: "/fixture", sessionFile: null, name: null,
      terminal: { coreId: "core", terminalId: "terminal", address: "terminal", socket: "/fixture/socket", sessionNamespace: "fixture" } } as JournalJob["owner"];
    const job: JournalJob = { version: 1, id: "job-1" as never, owner, machine: "box.invalid" as never,
      kind: "exec", phase: { kind: "running", address: "box/terminal" as never, releasedAt: 1 }, viewer: null,
      remoteDirectory: "/fixture/remote", localDirectory: "/fixture/local", detached: true, noticeMode: "async", notice: "pending",
      nonce: "nonce", releaseDeadlineAt: 1, originalFinish: null, output: null, callerOwned: true, uncertain: false,
      evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: 1 };
    const store = createJobStore(join(global.root, "herdr", "jobs"), sessionId as never);
    await store.write({ version: 1, sessionId: sessionId as never, revision: 1, updatedAt: 1, jobs: [job] });
    expect(await inspect(operation)).toMatchObject({ code: 0, value: { blockers: [{ kind: "remote-job", id: "job-1" }] } });
  } finally { await runtime.close(); }
}, 5000);
