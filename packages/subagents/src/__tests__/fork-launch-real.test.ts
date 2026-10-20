import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "../pi-args";
import { defaultSpawner } from "../spawn-default";
import { Runner } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { freshDb } from "./helpers/testutil";

const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const extension = fileURLToPath(new URL("./helpers/offline-fork-launch-extension.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/fork-launch-real");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const parent = SessionManager.create(root, join(root, "parent-sessions"));
  parent.appendMessage({ role: "user", content: "Parent history marker", timestamp: Date.now() });
  parent.appendMessage(fauxAssistantMessage("Parent response marker"));
  const parentFile = parent.getSessionFile()!;
  return { root, agentDir, parentFile, parentSessionId: parent.getSessionId(), parentText: readFileSync(parentFile, "utf8") };
}
function offline(spec: ChildSpawnSpec, agentDir: string) {
  return { ...spec, argv: [process.execPath, join(piRoot, "dist/cli.js"), ...spec.argv.slice(1), "--offline", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes"],
    env: { ...spec.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: agentDir, FORK_EVIDENCE: join(agentDir, "evidence.json") } };
}
for (const childMode of ["rpc", "print"] as const) {
  it.each([false, true])(`real pi: ${childMode} ID-based fork starts with parent history and its own session (different cwd=%s)`, async elsewhere => {
    const f = fixture();
    const cwd = elsewhere ? join(f.root, "another-project") : f.root;
    if (elsewhere) mkdirSync(cwd);
    const spec = buildChildSpawnSpec({ runId: "fork-child", sessionId: f.parentSessionId, agent: "worker", task: "Fork child task", context: "fork", parentSessionId: f.parentSessionId, parentSessionFile: f.parentFile,
      childIndex: 0, dbPath: join(f.root, "project.db"), scratchRoot: f.root, cwd, childMode,
      model: "spider-offline-fork/fixture", childExtensionPath: extension });
    const events: unknown[] = [];
    const handle = defaultSpawner({ ...offline(spec, f.agentDir), onRpcEvent: event => events.push(event) });
    try {
      expect(await handle.wait(), JSON.stringify(events)).toMatchObject({ exitCode: 0 });
      const evidence = JSON.parse(readFileSync(join(f.agentDir, "evidence.json"), "utf8"));
      expect(JSON.stringify(evidence.messages)).toContain("Parent history marker");
      expect(JSON.stringify(evidence.messages)).toContain("Parent response marker");
      expect(JSON.stringify(evidence.messages)).toContain("Fork child task");
      expect(evidence.sessionFile).not.toBe(f.parentFile);
      expect(dirname(evidence.sessionFile)).toBe(join(f.root, "subagent-sessions", "fork-child"));
      const child = readFileSync(evidence.sessionFile, "utf8");
      expect(child).toContain("Parent history marker");
      expect(child).toContain("Fork child finished");
      expect(JSON.parse(child.split("\n")[0])).toMatchObject({ id: "fork-child", parentSession: f.parentFile, cwd });
      expect(readFileSync(f.parentFile, "utf8")).toBe(f.parentText);
    } finally { await handle.killAsync?.(); }
  }, 20000);

  it(`real pi: Runner reports the rejected legacy fork/session launch as failed with its error in ${childMode} mode`, async () => {
    const f = fixture();
    const db = freshDb(), store = new RunStore(db), tailer = new RunEventTailer(db);
    let handle: ReturnType<typeof defaultSpawner> | undefined;
    const runner = new Runner(db, "owner", f.root, { store, tailer, childMode, scratchRoot: f.root, dbPath: join(f.root, "project.db"),
      spawn: spec => {
        const launch = offline(spec, f.agentDir);
        // Reproduce the pre-fix argv regardless of the current fork builder.
        launch.argv.push("--fork", f.parentFile);
        handle = defaultSpawner(launch);
        return handle;
      },
    });
    try {
      const run = await runner.runForeground({ agent: "worker", task: "Rejected launch", context: "fresh" });
      expect(run.status).toBe("failed");
      expect(store.get(run.id)!.status).toBe("failed");
      expect(run.result).toContain("--fork cannot be combined with --session");
      expect(readFileSync(f.parentFile, "utf8")).toBe(f.parentText);
    } finally { await handle?.killAsync?.(); tailer.stop(); db.close(); }
  }, 20000);
}
