/**
 * Integration test for I1 (binding wiring) - must be in host package.
 * Tests that production honors session bindings when resolving projects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openGlobal, bindSession, setGlobalDbPathForTests, resolveProject } from "@spider/db-core";
import { buildActionCtx } from "../extension";
import { join } from "path";

function scratchDbPath(name: string): string {
  return join(process.cwd(), ".spider", "scratch", "test-dbs", `${name}-${Date.now()}.db`);
}

describe("I1 Production Binding Wiring", () => {
  let globalDb: ReturnType<typeof openGlobal>;

  beforeEach(() => {
    setGlobalDbPathForTests(scratchDbPath("i1-binding"));
    globalDb = openGlobal();
  });

  afterEach(() => {
    try { globalDb.close(); } catch {}
    setGlobalDbPathForTests(null);
  });

  it("buildActionCtx honors session bindings when no explicit cwd in args", () => {
    const sessionId = "test-binding-sess";
    const boundPath = process.cwd();

    // Bind the session
    bindSession(globalDb, sessionId, boundPath);

    // Build ctx WITHOUT explicit cwd (should honor binding)
    const ctx = buildActionCtx(
      { models: { catalog: () => [], pick: () => null } } as any,
      { action: "test" } as any, // NO cwd in args
      sessionId,
      "/some/other/path" // contextCwd different from binding
    );

    // Should resolve to the bound path's project key
    const expectedProject = resolveProject(boundPath, { sessionId, explicitCwd: false });
    expect(ctx.project.projectKey).toBe(expectedProject.projectKey);
  });

  it("buildActionCtx overrides binding when explicit cwd in args", () => {
    const sessionId = "test-explicit-sess";
    const boundPath = "/some/bound/path";
    const explicitPath = process.cwd();

    // Bind to a different path
    bindSession(globalDb, sessionId, boundPath);

    // Build ctx WITH explicit cwd (should override binding)
    const ctx = buildActionCtx(
      { models: { catalog: () => [], pick: () => null } } as any,
      { action: "test", cwd: explicitPath } as any, // explicit cwd
      sessionId,
      undefined
    );

    // Should resolve to the explicit path, NOT the bound path
    const expectedProject = resolveProject(explicitPath, { sessionId, explicitCwd: true });
    expect(ctx.project.projectKey).toBe(expectedProject.projectKey);
  });
});
