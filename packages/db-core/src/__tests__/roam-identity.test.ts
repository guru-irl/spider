import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "../db";
import { GLOBAL_SCHEMA, REPO_SCHEMA, WORKTREE_SCHEMA } from "../schema";
import { DESCRIPTORS } from "@spider/db-core/roam/descriptors";
import { canonicalOrigin, repoIdentity } from "@spider/db-core/roam/identity";
import { loadMachineIdentity, readMachineIdentity } from "@spider/db-core/roam/machine";
import type { Entity } from "@spider/db-core/roam/types";

const roots: string[] = [];
function fixtureRoot(): string {
  const scratch = join(process.cwd(), ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "roam-identity-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("roaming identities", () => {
  it("equates HTTPS SSH and scp origins without credentials", () => {
    const urls = [
      "https://user:secret@CODE.example/org/team/repo.git?token=secret#x",
      "ssh://git@code.example:22/org/team/repo.git",
      "git@code.example:org/team/repo.git",
    ];
    expect(urls.map(canonicalOrigin)).toEqual(Array(3).fill("code.example/org/team/repo"));
    expect(canonicalOrigin("https://user:secret@HOST.invalid:443/A.git?q=secret#x")).toBe("host.invalid/A");
    for (const origin of urls) {
      expect(repoIdentity({ origin, roots: [] })).toBe("origin:6e29587e487d5ce98980a2e9f0796b6fe247fd1a181d6149e692f016d029d393");
    }
  }, 5000);

  it("canonicalizes all three service URL shapes", () => {
    const urls = [
      "https://org.legacy.example/DefaultCollection/team/_git/repo",
      "https://code.example/org/team/_git/repo",
      "git@ssh.code.example:v3/org/team/repo",
    ];
    expect(urls.map(canonicalOrigin)).toEqual(Array(3).fill("code.example/org/team/repo"));
    expect(canonicalOrigin("https://other.invalid/org/team/_git/repo")).toBe("other.invalid/org/team/_git/repo");
    expect(canonicalOrigin("git@ssh.other.invalid:v3/org/team/repo")).toBe("ssh.other.invalid/v3/org/team/repo");
  }, 5000);

  it("preserves path case and nondefault ports", () => {
    expect(canonicalOrigin("https://Host.invalid:8443/Org/Repo.git/")).toBe("host.invalid:8443/Org/Repo");
    expect(canonicalOrigin("ssh://git@Host.invalid:443/Org/Repo")).toBe("host.invalid:443/Org/Repo");
    expect(canonicalOrigin("https://[2001:DB8::1]:443/Org/Repo.git")).toBe("[2001:db8::1]/Org/Repo");
    expect(canonicalOrigin("ssh://git@[2001:db8::1]:2222/Org/Repo")).toBe("[2001:db8::1]:2222/Org/Repo");
    expect(canonicalOrigin("git@[2001:db8::1]:Org/Repo")).toBe("[2001:db8::1]/Org/Repo");
  }, 5000);

  it("decodes only unreserved escapes", () => {
    expect(canonicalOrigin("https://host.invalid/%7Euser/Repo%2fname%3F%23%25.git")).toBe("host.invalid/~user/Repo%2Fname%3F%23%25");
    for (const invalid of ["", "/local/repo", "../local/repo", "C:\\work\\repo", "file:///repo", "https://host.invalid", "https://host.invalid:99999/repo", "https://host.invalid/%zz"]) {
      expect(canonicalOrigin(invalid)).toBeNull();
    }
  }, 5000);

  it("requires an explicit key for unborn repositories", () => {
    expect(() => repoIdentity({ origin: null, roots: [] })).toThrow();
    expect(() => repoIdentity({ origin: null, roots: [], explicitKey: "" })).toThrow();
    expect(repoIdentity({ origin: null, roots: [], explicitKey: "manual-repo" })).toBe("manual-repo");
    expect(repoIdentity({ origin: "https://host.invalid/repo", roots: [], explicitKey: "manual-repo" })).toBe("manual-repo");
    expect(repoIdentity({ origin: "/local/repo", roots: ["b".repeat(40), "a".repeat(40)] })).toBe("root:04d25a78e94b819795564bae033c5e18af561f41bbbb55db30459d3e99b22aae");
    expect(repoIdentity({ origin: null, roots: ["a".repeat(40), "b".repeat(40), "a".repeat(40)] })).toBe("root:04d25a78e94b819795564bae033c5e18af561f41bbbb55db30459d3e99b22aae");
  }, 5000);

  it("never exposes an unusable origin in errors", () => {
    try {
      repoIdentity({ origin: "https://user:secret@host.invalid:99999/repo?token=secret", roots: [] });
      throw new Error("expected refusal");
    } catch (error) {
      expect(String(error)).toContain("explicit key");
      expect(String(error)).not.toContain("secret");
    }
  }, 5000);

  it("creates one private machine identity", () => {
    const root = fixtureRoot();
    const firstMachineId = loadMachineIdentity(root);
    const secondMachineId = loadMachineIdentity(root);
    expect(firstMachineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(secondMachineId).toBe(firstMachineId);
    expect(loadMachineIdentity(fixtureRoot())).not.toBe(firstMachineId);
    expect(lstatSync(join(root, "roam")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, "roam", "machine.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "roam", "machine.json"), "utf8")).toContain(firstMachineId);
  }, 5000);

  it("publishes one identity to concurrent processes", async () => {
    const root = fixtureRoot();
    const moduleUrl = new URL("../roam/machine.ts", import.meta.url).href;
    const command = "const {loadMachineIdentity} = await import(process.argv[1]); console.log(loadMachineIdentity(process.argv[2]));";
    const run = promisify(execFile);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      run(process.execPath, ["--input-type=module", "-e", command, moduleUrl, root])));
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const identities = results.flatMap(result => result.status === "fulfilled" ? [result.value.stdout.trim()] : []);
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe(loadMachineIdentity(root));
  }, 5000);

  it("refuses unsafe or malformed machine identity files", () => {
    const root = fixtureRoot();
    const roam = join(root, "roam");
    mkdirSync(roam, { mode: 0o700 });
    const file = join(roam, "machine.json");
    writeFileSync(file, "not-json", { mode: 0o600 });
    expect(() => loadMachineIdentity(root)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("not-json");
    writeFileSync(file, JSON.stringify({ machineId: "not-a-uuid" }));
    expect(() => loadMachineIdentity(root)).toThrow();
    writeFileSync(file, JSON.stringify({ machineId: "11111111-1111-4111-8111-111111111111" }));
    expect(loadMachineIdentity(root)).toBe("11111111-1111-4111-8111-111111111111");
    chmodSync(file, 0o644);
    expect(readMachineIdentity(root)).toBe("11111111-1111-4111-8111-111111111111");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    rmSync(file);
    const target = join(root, "target");
    const targetContents = JSON.stringify({ machineId: "11111111-1111-4111-8111-111111111111" });
    writeFileSync(target, targetContents, { mode: 0o600 });
    symlinkSync(target, file);
    expect(() => loadMachineIdentity(root)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(targetContents);
    rmSync(file);
    writeFileSync(file, targetContents, { mode: 0o600 });
    chmodSync(roam, 0o755);
    expect(loadMachineIdentity(root)).toBe("11111111-1111-4111-8111-111111111111");
    expect(lstatSync(roam).mode & 0o777).toBe(0o700);
    const other = fixtureRoot();
    symlinkSync(roam, join(other, "roam"));
    expect(() => loadMachineIdentity(other)).toThrow();
  }, 5000);

  it("accepts a symlinked global root and preserves the same identity", () => {
    const parent = fixtureRoot();
    const root = join(parent, "real-root");
    mkdirSync(root);
    const alias = join(parent, "root-alias");
    symlinkSync(root, alias, "dir");
    const id = loadMachineIdentity(alias);
    expect(readMachineIdentity(alias)).toBe(id);
    expect(loadMachineIdentity(root)).toBe(id);
    expect(lstatSync(join(root, "roam")).mode & 0o777).toBe(0o700);
  }, 5000);

  it("refuses a simulated foreign owner without changing its files", () => {
    const root = fixtureRoot();
    const id = loadMachineIdentity(root);
    const uid = lstatSync(root).uid;
    expect(() => loadMachineIdentity(root, { platform: "linux", uid: uid + 1 })).toThrow(/foreign-owned/i);
    expect(readMachineIdentity(root)).toBe(id);
    expect(lstatSync(join(root, "roam", "machine.json")).mode & 0o777).toBe(0o600);
  }, 5000);

  it.each(["directory", "identity"] as const)("refuses a foreign-owned %s before changing its mode", async kind => {
    const root = fixtureRoot();
    const id = loadMachineIdentity(root);
    const target = kind === "directory" ? join(root, "roam") : join(root, "roam", "machine.json");
    const wider = kind === "directory" ? 0o755 : 0o644;
    chmodSync(target, wider);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const opened = new Map<number, string>();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (file: string, flags: string | number, mode?: number) => {
        const fd = actual.openSync(file, flags, mode);
        opened.set(fd, file);
        return fd;
      },
      fstatSync: (fd: number) => {
        const stat = actual.fstatSync(fd);
        return opened.get(fd) === target ? Object.assign(Object.create(stat), { uid: stat.uid + 1 }) : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../roam/machine");
      expect(() => isolated.loadMachineIdentity(root, { platform: "linux", uid: lstatSync(root).uid })).toThrow(/foreign-owned/i);
      expect(lstatSync(target).mode & 0o777).toBe(wider);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    chmodSync(target, kind === "directory" ? 0o700 : 0o600);
    expect(readMachineIdentity(root)).toBe(id);
  }, 5000);

  it("uses exclusive creation without POSIX owner or mode checks on Windows", () => {
    const root = fixtureRoot();
    const roam = join(root, "roam");
    mkdirSync(roam, { mode: 0o755 });
    chmodSync(roam, 0o755);
    const id = loadMachineIdentity(root, { platform: "win32", uid: -1 });
    const file = join(roam, "machine.json");
    chmodSync(file, 0o644);
    expect(readMachineIdentity(root, { platform: "win32", uid: -1 })).toBe(id);
    expect(loadMachineIdentity(root, { platform: "win32", uid: -1 })).toBe(id);
    expect(lstatSync(roam).mode & 0o777).toBe(0o755);
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
    const target = join(root, "identity-copy.json");
    writeFileSync(target, readFileSync(file));
    rmSync(file);
    symlinkSync(target, file);
    expect(readMachineIdentity(root, { platform: "win32", uid: -1 })).toBe(id);
    expect(() => readMachineIdentity(root, { platform: "linux" })).toThrow();
  }, 5000);

  it("projects only portable columns", () => {
    const db = openDb(join(fixtureRoot(), "schema.db"));
    try {
      db.exec(GLOBAL_SCHEMA + REPO_SCHEMA + WORKTREE_SCHEMA + `
        ALTER TABLE global_memory ADD COLUMN machine_id TEXT;
        ALTER TABLE memory ADD COLUMN machine_id TEXT;
        ALTER TABLE sessions ADD COLUMN origin_machine TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN origin_machine TEXT NOT NULL DEFAULT '';
        ALTER TABLE todos ADD COLUMN uuid TEXT;
        ALTER TABLE run_events ADD COLUMN uuid TEXT;
        CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
          epoch INTEGER NOT NULL, move_id TEXT, updated_at INTEGER NOT NULL);
      `);
      const omissions: Record<Entity, string[]> = {
        global_memory: ["id"], memory: ["id"], sessions: ["imported_from"], todos: ["id"],
        runs: ["pid", "host_pid", "pid_start_time", "intercom_session"],
        run_events: ["id"], session_homes: [],
      };
      expect(Object.keys(DESCRIPTORS).sort()).toEqual(Object.keys(omissions).sort());
      for (const entity of Object.keys(omissions) as Entity[]) {
        const descriptor = DESCRIPTORS[entity];
        const actual = db.prepare(`PRAGMA table_info(${descriptor.table})`).all() as { name: string }[];
        expect([...descriptor.columns].sort()).toEqual(actual.map(column => column.name).filter(name => !omissions[entity].includes(name)).sort());
        expect(descriptor.columns).toContain(descriptor.key);
      }
      for (const column of ["pid", "host_pid", "pid_start_time", "intercom_session"]) {
        expect(DESCRIPTORS.runs.columns).not.toContain(column);
      }
      expect(DESCRIPTORS.sessions.columns).not.toContain("imported_from");
      expect(DESCRIPTORS.global_memory).toMatchObject({ scope: "global", key: "uuid", sessionColumn: null, immutable: ["uuid"] });
      expect(DESCRIPTORS.memory).toMatchObject({ scope: "repo", key: "uuid", sessionColumn: null, immutable: ["uuid"] });
      expect(DESCRIPTORS.sessions).toMatchObject({ scope: "worktree", key: "id", sessionColumn: "id", immutable: ["id", "origin_machine"] });
      expect(DESCRIPTORS.todos).toMatchObject({ scope: "worktree", key: "uuid", sessionColumn: "session_id", immutable: ["uuid", "session_id"] });
      expect(DESCRIPTORS.runs).toMatchObject({ scope: "worktree", key: "id", sessionColumn: "session_id", immutable: ["id", "session_id", "origin_machine"] });
      expect(DESCRIPTORS.run_events).toMatchObject({ scope: "worktree", key: "uuid", sessionColumn: "session_id", immutable: ["uuid", "session_id"] });
      expect(DESCRIPTORS.session_homes).toMatchObject({ scope: "global", key: "session_id", sessionColumn: null, immutable: ["session_id"] });
    } finally {
      db.close();
    }
  }, 5000);
});
