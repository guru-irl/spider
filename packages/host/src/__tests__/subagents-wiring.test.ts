import { describe, it, expect, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAction } from "../dispatch";
import spiderExtension from "../extension";
import { setGlobalDbPathForTests, paths } from "@spider/db-core";
import { registerSubagentActions } from "@spider/subagents";

function fakePi(): any {
  return { registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() }, getSessionName: () => "s1" };
}

describe("host wires subagent actions", () => {
  it("registers run/wait/message actions on activation", () => {
    const prev = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try {
      const scratch = paths.scratch("global");
      mkdirSync(scratch, { recursive: true });
      setGlobalDbPathForTests(join(scratch, `g-sub-${Date.now()}.db`));
      spiderExtension(fakePi());
      expect(getAction("run")).toBeTypeOf("function");
      expect(getAction("wait")).toBeTypeOf("function");
      expect(getAction("message")).toBeTypeOf("function");
    } finally {
      if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = prev;
    }
  });

  it("does NOT register orchestration actions in a subagent child (PI_SUBAGENT_CHILD=1)", () => {
    const prev = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const register = vi.fn();
      registerSubagentActions({ registerAction: register }, fakePi());
      expect(register).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = prev;
    }
  });
});
