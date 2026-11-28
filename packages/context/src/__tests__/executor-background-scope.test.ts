import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { PolyglotExecutor } from "../executor";
import { detectRuntimes } from "../runtime";
import { readManifestSafe } from "../background-job";
import { inspectLocalBackgroundJobs } from "../../../roam/src/relocate/local-writers";
import { processStartIdentity } from "../../../herdr/src/jobs/handoff";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for job fixture");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function identity(pid: number): string | null {
  if (process.platform !== "win32") return processStartIdentity(pid);
  try { process.kill(pid, 0); return String(pid); } catch { return null; }
}

describe("background jobs and the owning terminal scope", () => {
  it("survives the owner's scope reaper and remains a live manifest job", async () => {
    const scratch = paths.scratch("project", process.cwd());
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, ".scope-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const payloadEnvPath = join(root, "payload-env.json");
    const releasePath = join(root, "release");
    const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const captureSpawn: typeof spawn = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      launches.push({ args: [command, ...args], env: { ...options.env } });
      return spawn(command, args, options);
    }) as typeof spawn;
    const ownerScope = "owner-scope-test";
    vi.stubEnv("HC_SCOPE", ownerScope);
    vi.stubEnv("HC_TERMINAL_ID", "owner-terminal");
    vi.stubEnv("HC_TERMINAL_SOCKET", "/owned/core.sock");
    vi.stubEnv("SCOPE_TEST_SENTINEL", "retained");
    let supervisorPid: number | undefined;
    let childPid: number | undefined;
    try {
      const exec = new PolyglotExecutor({ projectRoot: root, ownerSessionId: "owner-session", spawn: captureSpawn, runtimes: { ...detectRuntimes(), javascript: process.execPath } });
      const foreground = await exec.execute({ language: "javascript", code: "console.log('foreground')" });
      expect(foreground.exitCode).toBe(0);
      expect(foreground.stdout).toContain("foreground");
      expect(launches[0].args).toEqual([exec.runtimes.javascript, expect.stringMatching(/[/\\]script\.cjs$/)]);
      expect(launches[0].env).toMatchObject({ HC_SCOPE: ownerScope, HC_TERMINAL_ID: "owner-terminal", HC_TERMINAL_SOCKET: "/owned/core.sock", SCOPE_TEST_SENTINEL: "retained" });

      const result = await exec.execute({
        language: "javascript", background: true, timeout: 150,
        code: `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(payloadEnvPath)}, JSON.stringify(process.env));
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.exit(0); } }, 25);`,
      });
      expect(result.backgrounded).toBe(true);
      const job = result.backgroundJob!;
      supervisorPid = result.pid;
      await waitFor(() => existsSync(payloadEnvPath) && Boolean(readManifestSafe(job.manifest)?.childPid));
      const manifest = readManifestSafe(job.manifest)!;
      expect(manifest.supervisorPid).toBe(supervisorPid);
      expect(manifest.ownerSessionId).toBe("owner-session");
      childPid = manifest.childPid;
      const payloadEnv = JSON.parse(readFileSync(payloadEnvPath, "utf8")) as NodeJS.ProcessEnv;
      const supervisorEnv = launches[1].env;
      const identities = [
        { pid: manifest.supervisorPid!, env: supervisorEnv },
        { pid: manifest.childPid!, env: payloadEnv },
      ];
      const births = identities.map(process => identity(process.pid));
      expect(births.every(Boolean)).toBe(true);
      // Stand in for Herdr's native cleanup: only the owner's scope is killed.
      const killed = identities.filter(identity => identity.env.HC_SCOPE === ownerScope);
      for (const identity of killed) process.kill(identity.pid, "SIGKILL");
      const surviving = identities.filter(identity => !killed.includes(identity)).map(identity => identity.pid);
      const jobs = await inspectLocalBackgroundJobs("owner-session" as never, root);
      expect(surviving).toEqual([manifest.supervisorPid, manifest.childPid]);
      expect(identities.map(process => identity(process.pid))).toEqual(births);
      expect(jobs.map(job => job.id)).toEqual([job.id]);
      expect(jobs[0].excludedRoots).toEqual([manifest.supervisorPid, manifest.childPid]);
      expect(payloadEnv).toMatchObject({ HC_TERMINAL_ID: "owner-terminal", HC_TERMINAL_SOCKET: "/owned/core.sock", SCOPE_TEST_SENTINEL: "retained" });
      expect(supervisorEnv).toMatchObject({ HC_TERMINAL_ID: "owner-terminal", HC_TERMINAL_SOCKET: "/owned/core.sock", SCOPE_TEST_SENTINEL: "retained" });
      expect(existsSync(job.receipt)).toBe(false);
      writeFileSync(releasePath, "release");
      await waitFor(() => existsSync(job.receipt));
      expect(JSON.parse(readFileSync(job.receipt, "utf8"))).toMatchObject({ state: "exited", exitCode: 0, signal: null });
    } finally {
      if (process.platform === "win32") {
        for (const pid of [childPid, supervisorPid]) {
          if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
        }
      } else if (supervisorPid) {
        try { process.kill(-supervisorPid, "SIGKILL"); } catch { /* already exited */ }
      }
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
