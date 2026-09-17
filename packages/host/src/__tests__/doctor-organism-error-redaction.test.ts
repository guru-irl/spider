// packages/host/src/__tests__/doctor-organism-error-redaction.test.ts
//
// A-M4 (branch-review A-architecture.md): `extension.ts`'s two organism-diagnostics
// fallback lines (`- organism runtime unavailable: …` / `- organism diagnostics
// unavailable: …`) used a raw `String((e as Error)?.message ?? e)`, while `safeError`
// — made public on this branch specifically because it redacts credentials
// (npm_/gh[opsu]_/sk- tokens, `Bearer …`, `api_key|token|password` assignments) and
// caps at 500 chars — sits on the very next lines, unused by these two.
//
// This needs a CONTROLLABLE exception at that exact call site to prove the fix, which
// the real HostOrganismRuntime doesn't offer through any public ctx field (verified:
// its natural failure mode, "Organism needs an active pi session.", carries no
// credential to redact and can't be lengthened past safeError's 500-char cap either).
// So — isolated to this ONE file (vi.mock is hoisted/file-scoped; extension.test.ts's
// many other doctor/organism tests must never see this) — HostOrganismRuntime itself
// is replaced with a double whose `resolve()` throws a KNOWN, credential-bearing
// message, exercising the REAL extension.ts/handleControl code path around it
// unmodified.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension, { buildActionCtx } from "../extension";
import type { SpiderArgs } from "../dispatch";
import { assertPostOpenIsolation, assertPreflightIsolation, type ExpectedRoots } from "./fixture-safety";

const CREDENTIAL = "Bearer sk-abcdefghijklmnopqrstuvwxyz123456"; // deliberately fake, test-only

vi.mock("../organism-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../organism-runtime")>();
  return {
    ...original,
    HostOrganismRuntime: class {
      isWired(): boolean {
        return true;
      }
      resolve(): unknown {
        throw new Error(`${CREDENTIAL} leaked while resolving organism runtime`);
      }
      getSetupFailure(): undefined {
        return undefined;
      }
    },
  };
});

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `doctor-redact-${process.pid}`);
const EXPECTED: ExpectedRoots = { worktree: scratch, repo: scratch, global: scratch };
const probeHandles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const db of probeHandles.splice(0)) { try { db.close(); } catch { /* best-effort */ } }
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

function fakePi() {
  const tools: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: () => {},
    on: () => {},
    _tools: tools,
  };
}

describe("doctor's organism-diagnostics fallback lines redact credentials (A-M4)", () => {
  it("the 'organism runtime unavailable' fallback uses safeError, not a raw stringifier", async () => {
    mkdirSync(scratch, { recursive: true });
    execFileSync("git", ["init", "-q", scratch]);
    assertPreflightIsolation(scratch, scratch);
    setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
    const dir = join(scratch, "proj"); mkdirSync(dir, { recursive: true });

    const args = { action: "control", command: "doctor", cwd: dir } as SpiderArgs;
    const probe = buildActionCtx({} as never, args, "", dir);
    probeHandles.push(probe.db, probe.repoDb, probe.globalDb);
    assertPostOpenIsolation(probe, EXPECTED, { requireRepoKey: true });

    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("c-am4", args, {}) as { details: { ok?: boolean; lines?: string[] } };

    expect(res.details.ok).toBe(false);
    const line = res.details.lines?.find((l) => l.includes("organism runtime unavailable"));
    expect(line, `expected an "organism runtime unavailable" line in: ${JSON.stringify(res.details.lines)}`).toBeTruthy();
    // The decisive check: the raw credential must NEVER reach the doctor report...
    expect(line).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(line).not.toContain("Bearer sk-");
    // ...and safeError's own, distinctive redaction marker must be present instead of
    // it — proving THIS call site now goes through safeError, not String(e.message).
    expect(line).toMatch(/Bearer \[redacted\]/);
  });
});
