import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerOrganism, OrganismWorker, ORGANISM_DEFAULTS, CURATOR_DEFAULTS, type DrainReport } from "../index";
import { makeOrgDb } from "./helpers/tmpdb";

let databases: ReturnType<typeof makeOrgDb> | undefined;
beforeEach(() => vi.stubEnv("PI_SUBAGENT_CHILD", "0"));
afterEach(() => { databases?.cleanup(); databases = undefined; vi.unstubAllEnvs(); });

it.each(["session_before_compact", "session_shutdown"])("%s captures prose without accessing tool output", async event => {
  databases = makeOrgDb();
  const { db, repoDb } = databases;
  let finish!: (report: DrainReport) => void, fail!: (error: unknown) => void;
  const receipt = new Promise<DrainReport>((resolve, reject) => { finish = resolve; fail = reject; });
  const worker = new OrganismWorker({
    db: repoDb, globalDb: repoDb, worktreeDb: db, project: { projectKey: "fixture", realPath: "fixture", dbPath: "fixture.db" },
    getEmbedder: async () => null, makeModel: () => null,
    org: { ...ORGANISM_DEFAULTS, passes: { ...ORGANISM_DEFAULTS.passes } }, curator: { ...CURATOR_DEFAULTS }, onDrainReport: finish,
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); } };
  registerOrganism(pi, pi, () => worker, (_phase, error) => fail(error));
  const branch = [
    { type: "message", message: { role: "user", content: "Keep the selected approach." } },
    { type: "message", message: { role: "toolResult", get content(): never { throw new Error("Excluded output was read"); } } },
    { type: "message", message: { role: "assistant", content: "Confirmed." } },
  ];
  await handlers.get(event)!({ branchEntries: branch }, { sessionManager: { getSessionId: () => "capture", getBranch: () => branch } });
  const report = await receipt;
  expect(report.inputs.messages).toBe(2);
  expect(report.errors).toEqual([]);
});
