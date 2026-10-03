import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbAt } from "@spider/db-core";
import { Runner, type ChildHandle } from "../runner";
import { defaultSpawner } from "../spawn-default";
import { makeMessageHandler } from "../actions/message";
import { makeAsyncNotifier } from "../actions/run";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { getChild, teardownAllAsync } from "../coordinators";

it("real pi: runner reports swallowed steers as accepted but not confirmed and normal/transformed steers as delivered", async () => {
  const scratch = resolve(".spider/scratch/steer-delivery/real-pi"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")), agentDir = join(root, "agent"), home = join(root, "home");
  mkdirSync(agentDir); mkdirSync(home);
  const release = join(root, "release"); writeFileSync(release, "hold");
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const db = openDbAt(join(root, "project.db"), "worktree"), store = new RunStore(db);
  const notifications: any[] = [], events: any[] = [], tools: any[] = [];
  let ready!: () => void, queued!: () => void, completed!: () => void;
  const streaming = new Promise<void>(r => { ready = r; }), allQueued = new Promise<void>(r => { queued = r; }), completion = new Promise<void>(r => { completed = r; });
  let handle: ChildHandle | undefined;
  const notify = makeAsyncNotifier({ db, pi: { sendMessage(m: any) { notifications.push(m); } } });
  const runner = new Runner(db, "offline-owner", root, { store, tailer: new RunEventTailer(db), scratchRoot: join(root, "runs"), dbPath: join(root, "project.db"), childMode: "rpc",
    onComplete: (row, status, result) => { notify(row, status, result); completed(); },
    spawn: spec => {
      const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, SPIDER_GLOBAL_ROOT: join(root, "global"), STEER_RELEASE_FILE: release, PI_TELEMETRY: "0" };
      for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key as keyof typeof env];
      handle = defaultSpawner({ ...spec, env: env as Record<string, string>, cwd: root, argv: [process.execPath, join(piRoot, "dist/cli.js"), "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-builtin-tools", "--provider", "spider-offline", "--model", "fixture", "-e", fileURLToPath(new URL("./helpers/offline-steer-extension.ts", import.meta.url))],
        onRpcEvent: e => { events.push(e); spec.onRpcEvent?.(e); if (e.type === "message_start" && e.message?.role === "assistant") ready(); if (e.type === "queue_update" && e.steering?.includes("INJECT_THEN_PASS marker")) queued(); } });
      const child = handle;
      return { ...child, wait: async () => {
        const outcome = await child.wait();
        const finalMessage = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
        return { ...outcome, result: finalMessage?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") };
      } };
    },
  });
  const row = runner.runAsync({ agent: "worker", task: "offline initial task", context: "fresh" });
  const bounded = async (p: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Offline pi did not reach boundary: ${JSON.stringify(events)}`)), 15000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await bounded(streaming);
    const texts = ["SWALLOW_STEER marker", "normal instruction", "TRANSFORM_STEER marker", "INJECT_THEN_PASS marker"];
    const pendingTools = texts.map(message => makeMessageHandler()({ to: row.id, message }, { db, sessionId: "offline-owner" }));
    await bounded(allQueued);
    const slash = await makeMessageHandler()({ to: row.id, message: "/skill:test" }, { db, sessionId: "offline-owner" });
    expect(slash.isError).toBe(true); expect(slash.content).toContain("expanded by the child as a skill or prompt template");
    writeFileSync(release, "release"); await bounded(completion);
    tools.push(...await Promise.all(pendingTools));
    for (const [index, result] of tools.entries()) {
      expect(result.isError).toBe(false);
      expect(result.details.delivery).toBe(index === 0 ? "accepted but not confirmed" : "delivered");
      expect(result.details.delivered).toBe(index !== 0);
      expect(result.details.queued).toBe(false);
    }
    expect(await handle!.wait()).toEqual({ exitCode: 0 });
    const evidence = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='steer_delivery' ORDER BY id").all(row.id) as Array<{ payload: string }>;
    const latest = new Map<string, any>(); for (const e of evidence) { const p = JSON.parse(e.payload); latest.set(p.steer, p); }
    expect(latest.get("SWALLOW_STEER marker")).toMatchObject({ accepted: true, delivered: false, delivery: "accepted but not confirmed" });
    expect(latest.get("normal instruction")).toMatchObject({ delivered: true, delivery: "delivered", transformed: false });
    expect(latest.get("TRANSFORM_STEER marker")).toMatchObject({ delivered: true, delivery: "delivered", transformed: true, observedText: "transformed instruction" });
    expect(latest.get("INJECT_THEN_PASS marker")).toMatchObject({ delivered: true, delivery: "delivered", transformed: false, observedText: "INJECT_THEN_PASS marker" });
    const injectedIndex = events.findIndex(e => e.type === "message_start" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("unrelated injected"));
    const exactIndex = events.findIndex(e => e.type === "message_start" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("INJECT_THEN_PASS marker"));
    expect(injectedIndex).toBeGreaterThan(-1); expect(exactIndex).toBeGreaterThan(injectedIndex);
    expect(events.slice(0, injectedIndex + 1).some(e => e.type === "steer_delivery" && e.steer === "INJECT_THEN_PASS marker" && e.delivered)).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].content).toContain("3 steer(s) delivered.");
    expect(notifications[0].content).toContain("1 steer(s) accepted but not confirmed.");
    expect(notifications[0].content).toContain("1 steer(s) refused.");
    expect(store.get(row.id)?.status).toBe("done"); expect(getChild("offline-owner", row.id)).toBeUndefined();
    if (process.env.SPIDER_STEER_EVIDENCE === "1") writeFileSync(join(scratch, "evidence.json"), JSON.stringify({ piVersion: JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, tools, deliveryEvents: evidence.map(e => JSON.parse(e.payload)), completion: notifications[0].content }, null, 2));
  } finally {
    // Independent last-resort cleanup, even if a lifecycle assertion fails.
    if (handle?.pid) { try { process.kill(process.platform === "win32" ? handle.pid : -handle.pid, "SIGKILL"); } catch {} }
    await teardownAllAsync({ graceMs: 25 });
    if (handle) await handle.wait();
    db.close(); rmSync(root, { recursive: true, force: true });
  }
}, 25000);
