import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "@spider/db-core";
import { registerSuperpowers } from "../index.js";
import { baselineSkillsDir } from "../skills-dir.js";
import { SPIDER_BLOCK_START } from "../agentsmd-content.js";

describe("registerSuperpowers", () => {
  it("writes the AGENTS.md managed block to the given path and returns a skillPaths provider", () => {
    const p = path.join(paths.scratch("project", process.cwd()), `reg-${process.pid}-${Math.random().toString(36).slice(2)}`, "AGENTS.md");
    const api = registerSuperpowers({}, {}, { agentsMdPath: p });
    expect(fs.readFileSync(p, "utf8")).toContain(SPIDER_BLOCK_START);
    expect(api.skillPaths(process.cwd())).toContain(baselineSkillsDir());
  });

  it("does not throw and skips writing when skipAgentsMd is set", () => {
    const api = registerSuperpowers({}, {}, { skipAgentsMd: true });
    expect(typeof api.skillPaths).toBe("function");
    expect(api.skillPaths(process.cwd())).toContain(baselineSkillsDir());
  });
});
