import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  buildChildSpawnSpec,
  SPIDER_DB_PATH_ENV,
  SUBAGENT_CHILD_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_ORCHESTRATOR_TARGET_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
} from "../pi-args";

let scratchRoot: string;

beforeAll(() => {
  // Use package-relative .spider/scratch (never /tmp)
  const pkgRoot = path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  scratchRoot = path.join(pkgRoot, ".spider", "scratch", `pi-args-${process.pid}`);
  fs.mkdirSync(scratchRoot, { recursive: true });
});

afterAll(() => {
  // Clean up test scratch
  if (scratchRoot) {
    try {
      fs.rmSync(path.dirname(path.dirname(scratchRoot)), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

const base = {
  runId: "r1",
  sessionId: "s1",
  agent: "worker",
  task: "do it",
  context: "fresh" as const,
  parentSessionId: "s1",
  childIndex: 0,
  dbPath: "", // Will be set in tests
  scratchRoot: "", // Will be set in tests
};

describe("buildChildSpawnSpec", () => {
  it("marks the child and threads the shared DB path + run id through env", () => {
    const dbPath = path.join(scratchRoot, "test.db");
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, dbPath });
    expect(spec.env[SUBAGENT_CHILD_ENV]).toBe("1");
    expect(spec.env[SPIDER_DB_PATH_ENV]).toBe(dbPath);
    expect(spec.env[SUBAGENT_RUN_ID_ENV]).toBe("r1");
  });

  it("places the session file under the scratch root as a .jsonl, never in /tmp", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    expect(spec.sessionFile.startsWith(scratchRoot)).toBe(true);
    expect(spec.sessionFile.endsWith(".jsonl")).toBe(true);
    expect(spec.sessionFile.includes("/tmp")).toBe(false);
  });

  it("references the parent session in argv when forking", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, context: "fork" });
    expect(spec.argv.includes("s1")).toBe(true);
  });

  it("propagates intercom/orchestrator env when provided", () => {
    const spec = buildChildSpawnSpec({
      ...base,
      scratchRoot,
      orchestratorTarget: "orch-session",
      intercomSessionName: "child-name",
    });
    expect(spec.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV]).toBe("orch-session");
    expect(spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe("child-name");
    expect(spec.env[SUBAGENT_CHILD_AGENT_ENV]).toBe("worker");
    expect(spec.env[SUBAGENT_CHILD_INDEX_ENV]).toBe("0");
  });

  it("loads the injected spider bundle as the child extension with discovery disabled", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, childExtensionPath: "/abs/dist/extension.js" });
    expect(spec.argv).toContain("--no-extensions");
    const i = spec.argv.indexOf("--extension");
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBe("/abs/dist/extension.js");
  });

  it("never references the unported upstream helper extensions (regression: child failed to start)", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    const joined = spec.argv.join(" ");
    expect(joined).not.toContain("subagent-prompt-runtime.ts");
    expect(joined).not.toContain("fanout-child.ts");
    // and it DOES load a child extension (defaulted to this module's own bundled entry)
    const i = spec.argv.indexOf("--extension");
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBeTruthy();
  });
});

import { thinkingFromModel, stripThinkingSuffix } from "../pi-args";
describe("thinking suffix parsing", () => {
  it("thinkingFromModel extracts a whitelisted level, else undefined", () => {
    expect(thinkingFromModel("github-copilot/claude-opus-4.8:high")).toBe("high");
    expect(thinkingFromModel("prov/m:low")).toBe("low");
    expect(thinkingFromModel("github-copilot/claude-opus-4.8")).toBeUndefined();
    expect(thinkingFromModel("prov/m:notalevel")).toBeUndefined();
    expect(thinkingFromModel(undefined)).toBeUndefined();
  });
  it("stripThinkingSuffix removes only a whitelisted level suffix", () => {
    expect(stripThinkingSuffix("github-copilot/claude-opus-4.8:high")).toBe("github-copilot/claude-opus-4.8");
    expect(stripThinkingSuffix("prov/m:notalevel")).toBe("prov/m:notalevel");
    expect(stripThinkingSuffix("prov/m")).toBe("prov/m");
  });
});
