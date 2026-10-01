import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbAt } from "@spider/db-core";
import { Runner, type ChildHandle } from "../runner";
import { defaultSpawner } from "../spawn-default";
import { makeMessageHandler } from "../actions/message";
import { makeAsyncNotifier } from "../actions/run";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { teardownAllAsync } from "../coordinators";


async function launch() {
  const scratch = resolve(".spider/scratch/steer-delivery/real-pi-hung"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")), agentDir = join(root, "agent"), home = join(root, "home");
  mkdirSync(agentDir); mkdirSync(home);
  const release = join(root, "release"); writeFileSync(release, "hold");
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const db = openDbAt(join(root, "project.db"), "worktree"), store = new RunStore(db);
  const notifications: any[] = [], events: any[] = [];
  let ready!: () => void, completed!: () => void;
  const streaming = new Promise<void>(r => { ready = r; }), completion = new Promise<void>(r => { completed = r; });
  let handle: ChildHandle | undefined;
  const notify = makeAsyncNotifier({ db, pi: { sendMessage(m: any) { notifications.push(m); } } });
  const runner = new Runner(db, "offline-owner", root, { store, tailer: new RunEventTailer(db), scratchRoot: join(root, "runs"), dbPath: join(root, "project.db"), childMode: "rpc",
    onComplete: (row, status, result) => { notify(row, status, result); completed(); },
    spawn: spec => {
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, SPIDER_GLOBAL_ROOT: join(root, "global"), STEER_RELEASE_FILE: release, PI_TELEMETRY: "0", PI_OFFLINE: "1" };
      for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key];
      handle = defaultSpawner({ ...spec, env: env as Record<string, string>, cwd: root, argv: [process.execPath, join(piRoot, "dist/cli.js"), "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-builtin-tools", "--provider", "spider-offline", "--model", "fixture", "-e", fileURLToPath(new URL("./helpers/offline-steer-extension.ts", import.meta.url))],
        onRpcEvent: e => { events.push({ t: Date.now(), ...e }); spec.onRpcEvent?.(e); if (e.type === "message_start" && e.message?.role === "assistant") ready(); } });
      const child = handle;
      return { ...child, wait: async () => {
        const outcome = await child.wait();
        const finalMessage = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
        return { ...outcome, result: finalMessage?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") };
      } };
    },
  });
  const row = runner.runAsync({ agent: "worker", task: "offline initial task", context: "fresh" });
  const within = async <T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([p, new Promise<"TIMEOUT">(r => { timer = setTimeout(() => r("TIMEOUT"), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const send = (message: string) => makeMessageHandler()({ to: row.id, message }, { db, sessionId: "offline-owner" });
  const deliveries = () => (db.prepare("SELECT type,payload FROM run_events WHERE run_id=? AND type IN ('steer_delivery','steer') ORDER BY id").all(row.id) as Array<{ type: string; payload: string }>)
    .map(e => { const p = JSON.parse(e.payload); return { type: e.type, steer: p.steer, delivery: p.delivery, observedText: p.observedText, transformed: p.transformed, message: p.message }; });
  const summary = () => ({ deliveries: deliveries(), userStarts: events.filter(e => e.type === "message_start" && e.message?.role === "user").map(e => e.message.content.map((c: any) => c.text).join("")),
    queue: events.filter(e => e.type === "queue_update").map(e => e.steering), notification: notifications[0]?.content, status: store.get(row.id)?.status });
  const cleanup = async () => {
    if (handle?.pid) { try { process.kill(process.platform === "win32" ? handle.pid : -handle.pid, "SIGKILL"); } catch {} }
    await teardownAllAsync({ graceMs: 25 });
    if (handle) await handle.wait();
    db.close(); rmSync(root, { recursive: true, force: true });
  };
  return { row, streaming, send, release: () => writeFileSync(release, "release"), completion, within, summary, cleanup, store, handle: () => handle };
}

it("real pi: a hung input handler cannot keep a settled run or a later message open", async () => {
  const r = await launch();
  try {
    expect(await r.within(r.streaming, 15000)).not.toBe("TIMEOUT");
    const first = await r.send("HANG_STEER marker");
    expect(first.details.delivery).toBe("no reply yet, delivery unknown");
    const second = r.send("after hang"); r.release();
    expect(await r.within(r.completion, 5000)).not.toBe("TIMEOUT");
    const reply = await r.within(second, 1000);
    expect(reply).not.toBe("TIMEOUT");
    if (reply !== "TIMEOUT") expect(reply.details.delivery).toBe("refused");
    expect(r.summary()).toMatchObject({ status: "done", notification: expect.stringContaining("1 steer(s) no reply yet, delivery unknown.") });
    expect(r.summary().notification).toContain("1 steer(s) refused.");
    expect(await r.handle()!.wait()).toEqual({ exitCode: 0 });
  } finally { await r.cleanup(); }
}, 35000);
