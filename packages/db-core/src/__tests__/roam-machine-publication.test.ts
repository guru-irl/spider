import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { loadMachineIdentity, readMachineIdentity } from "../roam/machine";

const roots: string[] = [];
function fixtureRoot(): string {
  const scratch = join(process.cwd(), ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "machine-publication-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function refusal(action: () => unknown): string {
  try { action(); } catch (error) { return String(error); }
  throw new Error("Expected a refusal");
}

describe("machine identity publication", () => {
  it("leaves no final file if Windows stops immediately after exclusive creation", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, openSync: (path: string, flags: string | number, mode?: number) => {
      const fd = fs.openSync(path, flags, mode);
      if (typeof flags === "number" && (flags & fs.constants.O_EXCL)) {
        fs.closeSync(fd);
        throw new Error("simulated crash after create");
      }
      return fd;
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("simulated crash after create");
    expect(existsSync(file)).toBe(false);
  }, 5000);

  it("recovers after a Windows writer is killed immediately after creating its temp file", async () => {
    const root = fixtureRoot(), roam = join(root, "roam"), file = join(roam, "machine.json");
    const moduleUrl = new URL("../roam/machine.ts", import.meta.url).href;
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync;
      fs.openSync = (path, flags, mode) => {
        const fd = open(path, flags, mode);
        if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
          process.stdout.write('created');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return fd;
      };
      syncBuiltinESMExports();
      const { loadMachineIdentity } = await import(process.argv[1]);
      loadMachineIdentity(process.argv[2], { platform: 'win32' });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, moduleUrl, root], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("writer exited before creation"); })]);
      expect(existsSync(file)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    expect(existsSync(file)).toBe(false);
    const [temp] = readdirSync(roam);
    expect(temp).toMatch(/^\.machine-.*\.tmp$/);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(roam, temp), old, old);
    const id = loadMachineIdentity(root, { platform: "win32" });
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(id);
    expect(readdirSync(roam)).toEqual(["machine.json"]);
  }, 5000);

  it("does not expose a Windows identity before a failed flush", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let writer = -1, observed: string | null = null;
    vi.doMock("node:fs", () => ({ ...fs,
      openSync: (path: string, flags: string | number, mode?: number) => {
        const fd = fs.openSync(path, flags, mode);
        if (typeof flags === "number" && (flags & fs.constants.O_EXCL)) writer = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === writer) {
          if (existsSync(file)) observed = JSON.parse(readFileSync(file, "utf8")).machineId;
          throw new Error("flush failed");
        }
        fs.fsyncSync(fd);
      },
    }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("flush failed");
    expect(observed).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(root, "roam"))).toEqual([]);
    vi.doUnmock("node:fs"); vi.resetModules();
    const id = loadMachineIdentity(root, { platform: "win32" });
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(id);
  }, 5000);

  it("preserves a concurrent winner when another Windows writer fails to flush", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const winner = "11111111-1111-4111-8111-111111111111";
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let writer = -1;
    vi.doMock("node:fs", () => ({ ...fs,
      openSync: (path: string, flags: string | number, mode?: number) => {
        const fd = fs.openSync(path, flags, mode);
        if (typeof flags === "number" && (flags & fs.constants.O_EXCL)) writer = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === writer) {
          if (!existsSync(file)) writeFileSync(file, JSON.stringify({ machineId: winner }), { flag: "wx" });
          throw new Error("flush failed");
        }
        fs.fsyncSync(fd);
      },
    }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("flush failed");
    expect(existsSync(file)).toBe(true);
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(winner);
    expect(loadMachineIdentity(root, { platform: "win32" })).toBe(winner);
  }, 5000);

  it("uses the winner when publication loses the hard-link race", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const winner = "11111111-1111-4111-8111-111111111111";
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, linkSync: (source: string, destination: string) => {
      writeFileSync(file, JSON.stringify({ machineId: winner }), { flag: "wx" });
      fs.linkSync(source, destination);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(isolated.loadMachineIdentity(root, { platform: "win32" })).toBe(winner);
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(winner);
    expect(readdirSync(join(root, "roam"))).toEqual(["machine.json"]);
  }, 5000);

  it("cleans the temp file and propagates a hard-link failure other than EEXIST", async () => {
    const root = fixtureRoot(), roam = join(root, "roam"), file = join(roam, "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, linkSync: () => {
      throw Object.assign(new Error("link denied"), { code: "EACCES" });
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("link denied");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(roam)).toEqual([]);
    vi.doUnmock("node:fs"); vi.resetModules();
    const id = loadMachineIdentity(root, { platform: "win32" });
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(id);
  }, 5000);

  it("propagates a missing-temp link error if no winner exists", async () => {
    const root = fixtureRoot(), roam = join(root, "roam"), file = join(roam, "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, linkSync: () => {
      throw Object.assign(new Error("link missing"), { code: "ENOENT" });
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("link missing");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(roam)).toEqual([]);
  }, 5000);

  it("does not remove an old temp until a final identity is available", async () => {
    const root = fixtureRoot(), roam = join(root, "roam");
    mkdirSync(roam);
    const slow = join(roam, ".machine-11111111-1111-4111-8111-111111111111.tmp");
    writeFileSync(slow, "unfinished");
    const old = new Date(Date.now() - 120_000); utimesSync(slow, old, old);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let visibleBeforePublication = false;
    vi.doMock("node:fs", () => ({ ...fs, linkSync: (source: string, destination: string) => {
      visibleBeforePublication = existsSync(slow);
      fs.linkSync(source, destination);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const id = isolated.loadMachineIdentity(root, { platform: "win32" });
    expect(visibleBeforePublication).toBe(true);
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(id);
    expect(existsSync(slow)).toBe(false);
  }, 5000);

  it("uses the winner if cleanup removes a slow writer's temp before it links", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const winner = "11111111-1111-4111-8111-111111111111";
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, linkSync: (source: string, destination: string) => {
      const old = new Date(Date.now() - 120_000); utimesSync(source, old, old);
      writeFileSync(file, JSON.stringify({ machineId: winner }), { flag: "wx" });
      loadMachineIdentity(root, { platform: "win32" });
      fs.linkSync(source, destination);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(isolated.loadMachineIdentity(root, { platform: "win32" })).toBe(winner);
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(winner);
    expect(readdirSync(join(root, "roam"))).toEqual(["machine.json"]);
  }, 5000);

  it("removes stale own temp files but leaves recent and unrelated files alone", () => {
    const root = fixtureRoot(), roam = join(root, "roam");
    mkdirSync(roam);
    const stale = join(roam, ".machine-11111111-1111-4111-8111-111111111111.tmp");
    const recent = join(roam, ".machine-22222222-2222-4222-8222-222222222222.tmp");
    const other = join(roam, ".machine-not-ours.tmp");
    const target = join(root, "target");
    const link = join(roam, ".machine-33333333-3333-4333-8333-333333333333.tmp");
    for (const file of [stale, recent, other, target]) writeFileSync(file, "unfinished");
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old); utimesSync(other, old, old);
    symlinkSync(target, link); lutimesSync(link, old, old);
    const id = loadMachineIdentity(root, { platform: "win32" });
    expect(readMachineIdentity(root, { platform: "win32" })).toBe(id);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(readFileSync(recent, "utf8")).toBe("unfinished");
    expect(existsSync(other)).toBe(true);
    expect(readFileSync(other, "utf8")).toBe("unfinished");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("unfinished");
    writeFileSync(stale, "unfinished"); utimesSync(stale, old, old);
    expect(loadMachineIdentity(root, { platform: "win32" })).toBe(id);
    expect(existsSync(stale)).toBe(false);
  }, 5000);

  it.each(["linux", "win32"] as const)("returns the published %s identity even when temp cleanup is denied", async platform => {
    const root = fixtureRoot();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, unlinkSync: (path: string) => {
      if (path.endsWith(".tmp")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      fs.unlinkSync(path);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const id = isolated.loadMachineIdentity(root, { platform });
    expect(readMachineIdentity(root, { platform })).toBe(id);
    expect(loadMachineIdentity(root, { platform })).toBe(id);
  }, 5000);

  it("preserves a flush error when temp cleanup is also denied", async () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let writer = -1;
    vi.doMock("node:fs", () => ({ ...fs,
      openSync: (path: string, flags: string | number, mode?: number) => {
        const fd = fs.openSync(path, flags, mode);
        if (typeof flags === "number" && (flags & fs.constants.O_EXCL)) writer = fd;
        return fd;
      },
      fsyncSync: (fd: number) => { if (fd === writer) throw new Error("flush failed"); fs.fsyncSync(fd); },
      unlinkSync: () => { throw new Error("cleanup denied"); },
    }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    expect(() => isolated.loadMachineIdentity(root, { platform: "win32" })).toThrow("flush failed");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(root, "roam"))).toHaveLength(1);
  }, 5000);

  it("reports the path and repair for malformed files and symbolic links", () => {
    const root = fixtureRoot(), roam = join(root, "roam"), file = join(roam, "machine.json");
    mkdirSync(roam); writeFileSync(file, "bad");
    const invalid = refusal(() => loadMachineIdentity(root));
    expect(invalid).toContain(file);
    expect(invalid).toMatch(/invalid machine identity/i);
    expect(invalid).toMatch(/fix|remove|repair/i);
    rmSync(file); symlinkSync(join(root, "missing"), file);
    const linked = refusal(() => loadMachineIdentity(root));
    expect(linked).toContain(file);
    expect(linked).toMatch(/symlink|link/i);
    expect(linked).toMatch(/remove|fix/i);
    rmSync(file); rmSync(roam, { recursive: true }); symlinkSync(join(root, "missing"), roam);
    const linkedDirectory = refusal(() => loadMachineIdentity(root));
    expect(linkedDirectory).toContain(roam);
    expect(linkedDirectory).toMatch(/symlink|link/i);
    expect(linkedDirectory).toMatch(/remove|fix/i);
  }, 5000);

  it("reports the path and repair for a foreign-owned identity root", () => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    loadMachineIdentity(root);
    const message = refusal(() => readMachineIdentity(root, { platform: "linux", uid: lstatSync(root).uid + 1 }));
    expect(message).toContain(root);
    expect(message).toMatch(/foreign-owned/i);
    expect(message).toMatch(/fix.*ownership/i);
    expect(existsSync(file)).toBe(true);
  }, 5000);

  it.each(["load", "read"] as const)("reports path and repair when the identity root cannot be traversed before %s", action => {
    const root = fixtureRoot(), notDirectory = join(root, "file");
    writeFileSync(notDirectory, "contents");
    const blocked = join(notDirectory, "root");
    const identity = action === "load" ? loadMachineIdentity : readMachineIdentity;
    const message = refusal(() => identity(blocked));
    expect(message).toContain(blocked);
    expect(message).toMatch(/link|regular/i);
    expect(message).toMatch(/remove|fix/i);
    expect(readFileSync(notDirectory, "utf8")).toBe("contents");
  }, 5000);

  it.each(["load", "read"] as const)("reports path and repair for a looping identity root before %s", action => {
    const root = fixtureRoot(), loop = join(root, "loop");
    symlinkSync("loop", loop);
    const identity = action === "load" ? loadMachineIdentity : readMachineIdentity;
    const message = refusal(() => identity(loop));
    expect(message).toContain(loop);
    expect(message).toMatch(/link|regular/i);
    expect(message).toMatch(/remove|fix/i);
    expect(lstatSync(loop).isSymbolicLink()).toBe(true);
  }, 5000);

  it.each(["ELOOP", "ENOTDIR"] as const)("turns Windows directory %s failures into path-specific repair advice", async code => {
    const root = fixtureRoot(), roam = join(root, "roam");
    mkdirSync(roam);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, statSync: (path: string) => {
      if (path === roam) throw Object.assign(new Error(code), { code });
      return fs.statSync(path);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const message = refusal(() => isolated.loadMachineIdentity(root, { platform: "win32" }));
    expect(message).toContain(roam);
    expect(message).toMatch(/link|regular/i);
    expect(message).toMatch(/remove|fix/i);
  }, 5000);

  it.each(["ELOOP", "ENOTDIR"] as const)("reports the path and repair for %s while creating a temp identity", async code => {
    const root = fixtureRoot(), roam = join(root, "roam");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, openSync: (path: string, flags: string | number, mode?: number) => {
      if (typeof flags === "number" && (flags & fs.constants.O_EXCL)) throw Object.assign(new Error(code), { code });
      return fs.openSync(path, flags, mode);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const message = refusal(() => isolated.loadMachineIdentity(root, { platform: "win32" }));
    expect(message).toContain(roam);
    expect(message).toContain(".tmp");
    expect(message).toMatch(/remove|fix/i);
    expect(existsSync(join(roam, "machine.json"))).toBe(false);
  }, 5000);

  it.each(["ELOOP", "ENOTDIR"] as const)("reports the path and repair for %s while linking an identity", async code => {
    const root = fixtureRoot(), roam = join(root, "roam"), file = join(roam, "machine.json");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, linkSync: () => { throw Object.assign(new Error(code), { code }); } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const message = refusal(() => isolated.loadMachineIdentity(root, { platform: "win32" }));
    expect(message).toContain(file);
    expect(message).toMatch(/remove|fix/i);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(roam)).toEqual([]);
  }, 5000);

  it.each(["ELOOP", "ENOTDIR"] as const)("turns %s no-follow failures into path-specific repair advice", async code => {
    const root = fixtureRoot(), file = join(root, "roam", "machine.json");
    mkdirSync(join(root, "roam")); writeFileSync(file, "contents");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...fs, openSync: (path: string, flags: string | number, mode?: number) => {
      if (path === file) throw Object.assign(new Error(code), { code });
      return fs.openSync(path, flags, mode);
    } }));
    vi.resetModules();
    const isolated = await import("../roam/machine");
    const message = refusal(() => isolated.loadMachineIdentity(root, { platform: "linux" }));
    expect(message).toContain(file);
    expect(message).toMatch(/link|regular/i);
    expect(message).toMatch(/remove|fix/i);
    expect(readFileSync(file, "utf8")).toBe("contents");
  }, 5000);
});
