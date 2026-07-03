import { describe, it, expect } from "vitest";
import {
  buildChildSpawnSpec,
  SPIDER_DB_PATH_ENV,
  SUBAGENT_CHILD_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_ORCHESTRATOR_TARGET_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
} from "../pi-args.js";

const base = {
  runId: "r1",
  sessionId: "s1",
  agent: "worker",
  task: "do it",
  context: "fresh" as const,
  parentSessionId: "s1",
  childIndex: 0,
  dbPath: "/x/.spider/project.db",
  scratchRoot: "/x/.spider/scratch",
};

describe("buildChildSpawnSpec", () => {
  it("marks the child and threads the shared DB path + run id through env", () => {
    const spec = buildChildSpawnSpec({ ...base });
    expect(spec.env[SUBAGENT_CHILD_ENV]).toBe("1");
    expect(spec.env[SPIDER_DB_PATH_ENV]).toBe("/x/.spider/project.db");
    expect(spec.env[SUBAGENT_RUN_ID_ENV]).toBe("r1");
  });

  it("places the session file under the scratch root as a .jsonl, never in /tmp", () => {
    const spec = buildChildSpawnSpec({ ...base });
    expect(spec.sessionFile.startsWith("/x/.spider/scratch")).toBe(true);
    expect(spec.sessionFile.endsWith(".jsonl")).toBe(true);
    expect(spec.sessionFile.includes("/tmp")).toBe(false);
  });

  it("references the parent session in argv when forking", () => {
    const spec = buildChildSpawnSpec({ ...base, context: "fork" });
    expect(spec.argv.includes("s1")).toBe(true);
  });

  it("propagates intercom/orchestrator env when provided", () => {
    const spec = buildChildSpawnSpec({
      ...base,
      orchestratorTarget: "orch-session",
      intercomSessionName: "child-name",
    });
    expect(spec.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV]).toBe("orch-session");
    expect(spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe("child-name");
    expect(spec.env[SUBAGENT_CHILD_AGENT_ENV]).toBe("worker");
    expect(spec.env[SUBAGENT_CHILD_INDEX_ENV]).toBe("0");
  });
});
