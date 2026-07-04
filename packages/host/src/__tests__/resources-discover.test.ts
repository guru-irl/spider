// Task 16 regression: booting the host extension must wire resources_discover to
// contribute the superpowers baseline skills dir (replacing the Phase-0 no-op).
// It MUST fail if the placeholder still returns undefined. VITEST is set, so the
// extension's registerSuperpowers skips the real ~/.pi/agent/AGENTS.md write.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { baselineSkillsDir } from "@spider/superpowers";
import spiderExtension from "../extension";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `res-disc-${process.pid}`);

type Handler = (event: unknown) => unknown;

function fakePi(): { pi: unknown; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, fn: Handler) {
      const arr = handlers.get(name) ?? [];
      arr.push(fn);
      handlers.set(name, arr);
    },
    registerTool: () => undefined,
    registerAction: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
  };
  return { pi, handlers };
}

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, "global.db"));
});

afterAll(() => {
  setGlobalDbPathForTests(null);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("resources_discover", () => {
  it("contributes the superpowers baseline skills dir", async () => {
    const { pi, handlers } = fakePi();
    spiderExtension(pi as never);

    const discover = handlers.get("resources_discover");
    expect(discover, "a resources_discover handler is registered").toBeTruthy();
    expect(discover!.length).toBeGreaterThanOrEqual(1);

    // Merge every registered handler's contribution (pi aggregates them).
    const proj = join(scratch, "proj");
    mkdirSync(proj, { recursive: true });
    const paths: string[] = [];
    for (const h of discover!) {
      const r = (await h({ type: "resources_discover", cwd: proj, reason: "startup" })) as { skillPaths?: string[] } | undefined;
      if (r?.skillPaths) paths.push(...r.skillPaths);
    }
    expect(paths).toContain(baselineSkillsDir());
  });
});
