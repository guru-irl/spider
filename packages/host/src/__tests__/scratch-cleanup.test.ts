import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const vitestCli = resolve(checkout, "node_modules/vitest/vitest.mjs");
const probeConfig = resolve(checkout, "packages/host/src/__tests__/fixtures/scratch-probe.vitest.config.mjs");
const roots = ["db-core", "host", "subagents", "superpowers"].map((pkg) =>
  pkg === "superpowers" && process.env.SUPERPOWERS_TEST_SCRATCH_ROOT
    ? resolve(checkout, process.env.SUPERPOWERS_TEST_SCRATCH_ROOT)
    : resolve(checkout, "packages", pkg, ".spider", "scratch"),
);

function nestedVitest(args: string[], env = process.env): { status: number; output: string } {
  const child = spawnSync(process.execPath, [vitestCli, ...args], {
    cwd: checkout, encoding: "utf8", env, stdio: "pipe", timeout: 20_000,
  });
  return {
    status: child.status ?? -1,
    output: `stdout:\n${child.stdout ?? ""}\nstderr:\n${child.stderr ?? ""}${child.error ? `\nprocess error: ${child.error}` : ""}`,
  };
}

function runProbe(fail: "none" | "test" | "hook", config = probeConfig): { pid: string; status: number; output: string } {
  const out = resolve(checkout, ".spider", "scratch", `scratch-cleanup-probe-${randomUUID()}.txt`);
  const result = nestedVitest(["run", "--config", config], {
    ...process.env, SPIDER_SCRATCH_PROBE_OUT: out, SPIDER_SCRATCH_PROBE_FAIL: fail,
  });
  try {
    if (!existsSync(out)) throw new Error(`probe wrote no PID (status ${result.status})\n${result.output}`);
    return { pid: readFileSync(out, "utf8"), ...result };
  } finally {
    rmSync(out, { force: true });
  }
}

function withSiblings(check: (siblingPid: string) => void): void {
  const siblingPid = String(900_000_000 + process.pid);
  const siblings = roots.map((root) => join(root, siblingPid));
  const created: string[] = [];
  try {
    for (const dir of siblings) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "keep.txt"), "another process");
        created.push(dir);
      }
    }
    check(siblingPid);
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
}

function checkProbe(fail: "none" | "test" | "hook"): void {
  withSiblings((siblingPid) => {
    // Snapshot existing neighbours so neither the test nor its cleanup removes leftovers.
    const prior = roots.map((root) => new Set(existsSync(root) ? readdirSync(root) : []));
    const probe = runProbe(fail);
    const neighbour = `${probe.pid}000000000`;
    try {
      expect(probe.status, probe.output).toBe(fail === "none" ? 0 : 1);
      if (fail === "test") expect(probe.output, probe.output).toContain("intentional probe failure");
      if (fail === "hook") expect(probe.output, probe.output).toContain("intentional afterAll failure");
      for (const root of roots) {
        expect(existsSync(join(root, probe.pid)), `${root} leaked the child PID folder\n${probe.output}`).toBe(false);
        expect(existsSync(join(root, siblingPid, "keep.txt")), `${root} deleted another PID's folder\n${probe.output}`).toBe(true);
        expect(existsSync(join(root, neighbour, "keep.txt")), `${root} deleted a same-prefix PID folder\n${probe.output}`).toBe(true);
      }
    } finally {
      for (const [index, root] of roots.entries()) {
        if (!prior[index]!.has(neighbour)) rmSync(join(root, neighbour), { recursive: true, force: true });
      }
    }
  });
}

describe("test PID scratch cleanup", () => {
  it("subagent fixture teardown preserves sibling scratch", () => {
    const sibling = resolve(checkout, "packages", ".spider", "scratch", String(900_000_000 + process.pid));
    const created = !existsSync(sibling);
    try {
      if (created) {
        mkdirSync(sibling, { recursive: true });
        writeFileSync(join(sibling, "keep.txt"), "another process");
      }
      const result = nestedVitest([
        "run", "packages/subagents/src/__tests__/pi-args.test.ts",
        "packages/subagents/src/__tests__/pi-args-escalation.test.ts", "--maxWorkers=1",
      ]);
      expect(result.status, result.output).toBe(0);
      expect(existsSync(join(sibling, "keep.txt"))).toBe(true);
    } finally {
      if (created) rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("a probe without a PID reports the child failure", () => {
    expect(() => runProbe("none", resolve(checkout, "missing-scratch-probe-config.mjs")))
      .toThrow(/failed to load config.*missing-scratch-probe-config\.mjs/s);
  });

  it("a passing probe removes its PID folders and preserves siblings", () => checkProbe("none"));
  it("a failing test probe still removes its PID folders", () => checkProbe("test"));
  it("a failing file afterAll probe still removes its PID folders", () => checkProbe("hook"));
});
