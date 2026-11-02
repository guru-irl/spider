import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isProcessGroupAlive, killProcessGroup } from "../kill-process";
import { killRun } from "../kill";
import { RunStore } from "../run-store";
import { freshDb, testScratchPath } from "./helpers/testutil";

// The supervisor stays outside the group and owns every member, so it can reap
// them all after the assertions. Reaping the leader leaves only zombie members.
const helper = String.raw`
import json, os, signal, sys, time
children = []
def cleanup(*args):
    for pid in children:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    for pid in children:
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGALRM, cleanup)
signal.alarm(45)
try:
    read, write = os.pipe()
    leader = os.fork()
    if leader == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        os.close(read)
        os.setpgid(0, 0)
        os.write(write, b'1')
        os.close(write)
        while True: signal.pause()
    children.append(leader)
    os.close(write)
    os.read(read, 1)
    os.close(read)
    read, write = os.pipe()
    member = os.fork()
    if member == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        os.close(read)
        os.setpgid(0, leader)
        os.write(write, b'1')
        os.close(write)
        if sys.argv[1] == 'live':
            while True: signal.pause()
        os._exit(0)
    children.append(member)
    os.close(write)
    os.read(read, 1)
    os.close(read)
    if sys.argv[1] != 'live':
        # Observe exit without reaping: the group must contain a real zombie.
        import subprocess
        deadline = time.monotonic() + 10
        while True:
            stat = subprocess.check_output(['ps', '-p', str(member), '-o', 'stat='], timeout=2).decode().strip()
            if stat.startswith('Z'): break
            if time.monotonic() > deadline: raise RuntimeError('member did not become a zombie')
            time.sleep(.01)
    os.kill(leader, signal.SIGKILL)
    if sys.argv[1] != 'zombie-leader':
        os.waitpid(leader, 0)
        children.remove(leader)
    else:
        # Keep the dead leader unreaped too, to exercise identity-loss guards.
        import subprocess
        deadline = time.monotonic() + 10
        while True:
            stat = subprocess.check_output(['ps', '-p', str(leader), '-o', 'stat='], timeout=2).decode().strip()
            if stat.startswith('Z'): break
            if time.monotonic() > deadline: raise RuntimeError('leader did not become a zombie')
            time.sleep(.01)
    print(json.dumps({'pgid': leader, 'member': member}), flush=True)
    sys.stdin.readline()
finally:
    cleanup()
`;

async function group(mode: "zombie" | "zombie-leader" | "live") {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-u", "-c", helper, mode]);
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`helper timed out: ${stderr}`)), 15_000);
      child.stdout.setEncoding("utf8").on("data", chunk => {
        text += chunk;
        if (text.includes("\n")) { clearTimeout(timer); resolve(text.split("\n")[0]); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); reject(new Error(`helper exited ${code}: ${stderr}`)); });
    });
    const { pgid, member } = JSON.parse(line) as { pgid: number; member: number };
    return {
      pgid, member,
      async cleanup() {
        child.stdin.end("\n");
        await closed;
        expect(() => process.kill(child.pid!, 0)).toThrow();
        expect(() => process.kill(member, 0)).toThrow();
        expect(() => process.kill(pgid, 0)).toThrow();
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    await closed;
    throw error;
  }
}

const darwin = process.platform === "darwin";
describe.skipIf(process.platform === "win32")("real zombie process groups", () => {
  it("recognizes macOS zombie-only groups as dead without changing Linux probes", async () => {
    const fixture = await group("zombie");
    try {
      expect(isProcessGroupAlive(fixture.pgid)).toBe(!darwin);
    } finally { await fixture.cleanup(); }
  });

  it("does not fail to kill a zombie-only group", async () => {
    const fixture = await group("zombie");
    try {
      await expect(killProcessGroup(fixture.pgid, { graceMs: 1 })).resolves.toBe(darwin ? "already-dead" : "forced");
    } finally { await fixture.cleanup(); }
  });

  it.skipIf(!darwin)("does not report lost identity for an unreaped zombie-only group", async () => {
    const fixture = await group("zombie-leader");
    try {
      await expect(killProcessGroup(fixture.pgid, { graceMs: 1, canSignal: () => false })).resolves.toBe("already-dead");
    } finally { await fixture.cleanup(); }
  });

  it.skipIf(!darwin)("reconciles a pid-only zombie run instead of reporting unconfirmed identity", async () => {
    const fixture = await group("zombie-leader");
    const db = freshDb();
    try {
      const store = new RunStore(db);
      const { id } = store.create({ sessionId: "zombie-owner", agent: "worker" });
      store.start(id);
      store.setPid(id, fixture.pgid, process.pid, "old-start");
      const result = await killRun({ db, store, probeStartTime: () => "different-start" }, "zombie-owner", store.get(id)!);
      expect(result.outcome).toBe("no-process");
      expect(store.get(id)?.status).toBe("cancelled");
    } finally { db.close(); await fixture.cleanup(); }
  });

  it.skipIf(!darwin)("fails closed on EPERM when ps cannot be executed", async () => {
    const fixture = await group("zombie");
    const emptyPath = mkdtempSync(testScratchPath("group-no-ps-"));
    try {
      vi.stubEnv("PATH", emptyPath);
      expect(isProcessGroupAlive(fixture.pgid)).toBe(true);
      await expect(killProcessGroup(fixture.pgid, { graceMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
      await expect(killProcessGroup(fixture.pgid, { canSignal: () => false })).rejects.toThrow(/identity unconfirmed/i);
    } finally {
      vi.unstubAllEnvs();
      rmSync(emptyPath, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it.skipIf(!darwin)("preserves EPERM when the inventory reports a live member", async () => {
    const fixture = await group("zombie");
    const hasLiveGroupMembers = () => true;
    try {
      expect(isProcessGroupAlive(fixture.pgid, process.kill, hasLiveGroupMembers)).toBe(true);
      await expect(killProcessGroup(fixture.pgid, { hasLiveGroupMembers })).rejects.toMatchObject({ code: "EPERM" });
    } finally { await fixture.cleanup(); }
  });

  it("recognizes and terminates a group with a live member after the leader exits", async () => {
    const fixture = await group("live");
    try {
      expect(isProcessGroupAlive(fixture.pgid)).toBe(true);
      await expect(killProcessGroup(fixture.pgid, { graceMs: 50 })).resolves.toBe(darwin ? "terminated" : "forced");
      const stat = execFileSync("ps", ["-p", String(fixture.member), "-o", "stat="], { encoding: "utf8", timeout: 1000 }).trim();
      expect(stat.startsWith("Z")).toBe(true);
      expect(isProcessGroupAlive(fixture.pgid)).toBe(!darwin);
    } finally { await fixture.cleanup(); }
  });
});
