// packages/db-core/src/__tests__/paths.test.ts
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../paths.js";

describe("paths (zero temp-dir)", () => {
  it("roots the global tree under ~/.pi/agent/spider", () => {
    expect(paths.globalRoot).toBe(join(homedir(), ".pi", "agent", "spider"));
    expect(paths.models).toBe(join(homedir(), ".pi", "agent", "spider", "models"));
  });

  it("roots a project tree under <cwd>/.spider", () => {
    expect(paths.projectRoot("/repo/x")).toBe(join("/repo/x", ".spider"));
  });

  it("scratch dirs never touch /tmp or $TMPDIR", () => {
    const g = paths.scratch("global");
    const p = paths.scratch("project", "/repo/x");
    for (const s of [g, p]) {
      expect(s).not.toMatch(/(^|\/)tmp(\/|$)/);
      expect(s).not.toContain("/var/tmp");
    }
    expect(g).toBe(join(paths.globalRoot, "scratch"));
    expect(p).toBe(join("/repo/x", ".spider", "scratch"));
  });

  it("logs dirs live under the matching root", () => {
    expect(paths.logs("global")).toBe(join(paths.globalRoot, "logs"));
    expect(paths.logs("project", "/repo/x")).toBe(join("/repo/x", ".spider", "logs"));
  });
});
