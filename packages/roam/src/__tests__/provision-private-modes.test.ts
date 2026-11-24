import { afterEach, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { BOOTSTRAP_SETTINGS_SCRIPT } from "../bootstrap-script";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";
import { createHcProvisionAdapter } from "../provision-adapter";
import { inspectAgentPrivateModes } from "../selected-files";
import { DEFAULT_LIMITS, type Peer } from "../contracts";

const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "p-")); roots.push(root);
  const home = join(root, "home"), agentDir = join(home, "agent"), globalRoot = join(home, "global"), npmPrefix = join(home, "prefix"), unitDir = join(home, "units");
  for (const path of [home, agentDir, globalRoot, npmPrefix, unitDir, join(globalRoot, "roam")]) mkdirSync(path, { mode: 0o700 });
  const peer: Peer = { alias: "box-1.invalid", machineId: "11111111-1111-4111-8111-111111111111", globalRoot, node: process.execPath,
    pi: join(npmPrefix, "bin/pi"), cli: join(npmPrefix, "dist/cli.mjs"), core: join(home, "core"), agentDir };
  writeFileSync(join(globalRoot, "roam/machine.json"), JSON.stringify({ version: 1, machineId: peer.machineId, label: "box-1.invalid" }), { mode: 0o600 });
  let prelude = "";
  function run(script: string, request: unknown) {
    const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", prelude + script], {
      input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 4000,
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  }
  const destination = { home, agentDir, npmPrefix, supervisor: join(npmPrefix, "dist/supervisor.mjs") };
  const adapter = createHcProvisionAdapter({ peer, operationId: "op-1", destination, unitDir, limits: DEFAULT_LIMITS, piProviders: [], transport: {
    transport: { async resolve(p: Peer) { return p; } } as never,
    async executeProvision(_peer: Peer, request: Record<string, unknown>) {
      const reply = run(PROVISION_REMOTE_SCRIPT, request);
      if (reply.error) throw Object.assign(new Error("refused"), { code: reply.error, details: reply.details });
      return reply.value;
    },
  } as never });
  return { root, home, agentDir, globalRoot, peer, run, adapter,
    setPrelude(value: string) { prelude = value; },
    preview() { return run(BOOTSTRAP_SETTINGS_SCRIPT, { home, agentDir, maximum: 1024, paths: [] }); } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function withSocket(path: string, test: () => Promise<void>): Promise<void> {
  const server = createServer(client => client.end("alive"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  try { await test(); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function expectLive(path: string): Promise<void> {
  const response = await new Promise<string>((resolve, reject) => {
    const client = createConnection(path); let data = "";
    client.setEncoding("utf8"); client.on("data", chunk => { data += chunk; });
    client.once("end", () => resolve(data)); client.once("error", reject);
  });
  expect(response).toBe("alive");
}
function socketIdentity(path: string) {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
function repair(f: ReturnType<typeof fixture>): Promise<unknown> {
  return (f.adapter as unknown as { repairAgentDirectory(peer: Peer): Promise<unknown> }).repairAgentDirectory(f.peer);
}

it("previews sign-in-created settings and folders read-only even with no settings selected", () => {
  const f = fixture(), settings = join(f.agentDir, "settings.json"), auth = join(f.agentDir, "auth.json"), folder = join(f.agentDir, "sessions");
  writeFileSync(settings, "{}", { mode: 0o600 }); chmodSync(settings, 0o664);
  writeFileSync(auth, "{}", { mode: 0o600 }); chmodSync(auth, 0o664);
  mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o775);
  const reply = f.preview();
  expect(reply).toMatchObject({ kind: "settings-preview", value: { agentModes: { authPresent: true, repairs: [
    { path: auth, before: 0o664, after: 0o600 }, { path: folder, before: 0o775, after: 0o700 }, { path: settings, before: 0o664, after: 0o600 },
  ] } } });
  expect(lstatSync(settings).mode & 0o7777).toBe(0o664); expect(lstatSync(folder).mode & 0o7777).toBe(0o775);
});

it("repairs through the generated installer and retains the JSON evidence on retry", async () => {
  const f = fixture(), settings = join(f.agentDir, "settings.json"), folder = join(f.agentDir, "sessions");
  writeFileSync(settings, "{\"theme\":\"sample\"}", { mode: 0o600 }); chmodSync(settings, 0o664);
  mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o775);
  const repair = (f.adapter as unknown as { repairAgentDirectory(p: Peer): Promise<unknown> }).repairAgentDirectory?.bind(f.adapter);
  expect(repair).toBeTypeOf("function");
  const expected = [{ path: folder, uid: process.getuid!(), before: 0o775, after: 0o700 }, { path: settings, uid: process.getuid!(), before: 0o664, after: 0o600 }];
  expect(await repair!(f.peer)).toEqual(expected);
  expect(lstatSync(settings).mode & 0o7777).toBe(0o600); expect(lstatSync(folder).mode & 0o7777).toBe(0o700);
  expect(readFileSync(settings, "utf8")).toBe("{\"theme\":\"sample\"}");
  expect(await repair!(f.peer)).toEqual(expected);
});

it("preserves a live private broker through preview and two generated repairs", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
  mkdirSync(directory, { mode: 0o700 });
  await withSocket(socket, async () => {
    const before = socketIdentity(socket);
    expect(lstatSync(socket).isSocket()).toBe(true); expect(before.mode).toBe(0o600);
    const preview = f.preview();
    expect(preview.error).toBeUndefined();
    expect(preview).toMatchObject({ kind: "settings-preview", value: { agentModes: { repairs: [] } } });
    expect(socketIdentity(socket)).toEqual(before);
    await expectLive(socket);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await repair(f)).toEqual([]);
      expect(socketIdentity(socket)).toEqual(before);
      await expectLive(socket);
    }
  });
});

it.each(["foreign owner", "wrong mode", "executable socket", "unsafe parent", "foreign parent", "parent symlink", "socket symlink", "unrelated socket"])(
  "refuses a live broker with %s without changing it", async condition => {
    const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
    const outside = join(f.home, "outside"), actual = condition === "socket symlink" ? join(f.home, "target.sock")
      : condition === "unrelated socket" ? join(f.agentDir, "other.sock") : socket;
    if (condition === "parent symlink") { mkdirSync(outside, { mode: 0o700 }); symlinkSync(outside, directory); }
    else mkdirSync(directory, { mode: 0o700 });
    const listener = condition === "parent symlink" ? join(outside, "broker.sock") : actual;
    await withSocket(listener, async () => {
      let failure: Record<string, unknown>;
      if (condition === "foreign owner" || condition === "foreign parent") {
        const path = condition === "foreign owner" ? socket : directory, uid = process.getuid!() + 1;
        f.setPrelude(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.lstatSync; fs.lstatSync=(file,...args)=>{const s=original(file,...args); if(file===${JSON.stringify(path)}) Object.defineProperty(s,'uid',{value:${uid}}); return s;}; syncBuiltinESMExports();\n`);
        failure = { path, uid, problem: "owner" };
      } else if (condition === "wrong mode" || condition === "executable socket") {
        const mode = condition === "wrong mode" ? 0o640 : 0o700;
        chmodSync(listener, mode); failure = { path: socket, mode, problem: "socket-mode" };
      } else if (condition === "unsafe parent") {
        chmodSync(directory, 0o755); failure = { path: directory, mode: 0o755, problem: "owner-mode" };
      } else if (condition === "parent symlink") failure = { path: directory, problem: "symlink" };
      else if (condition === "socket symlink") { symlinkSync(listener, socket); failure = { path: socket, problem: "symlink" }; }
      else failure = { path: listener, problem: "type" };
      const before = socketIdentity(listener), parentMode = lstatSync(directory).mode & 0o7777;
      expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: failure });
      await expect(repair(f)).rejects.toMatchObject({ code: "unsafe-destination", details: failure,
        ...(condition === "wrong mode" || condition === "executable socket" ? { message: expect.stringContaining("Set mode 0600") } : {}) });
      expect(socketIdentity(listener)).toEqual(before);
      expect(lstatSync(directory).mode & 0o7777).toBe(parentMode);
      await expectLive(listener);
    });
  },
);

it("refuses an unsafe broker parent before direct repair can change it", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
  mkdirSync(directory, { mode: 0o700 });
  await withSocket(socket, async () => {
    chmodSync(directory, 0o755); const before = socketIdentity(socket);
    expect(() => inspectAgentPrivateModes(f.agentDir, true)).toThrow();
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
    expect(socketIdentity(socket)).toEqual(before);
    await expectLive(socket);
  });
});

it("refuses a broker parent that becomes unsafe during preview", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
  mkdirSync(directory, { mode: 0o700 });
  await withSocket(socket, async () => {
    const before = socketIdentity(socket);
    f.setPrelude(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.lstatSync; let calls=0; fs.lstatSync=(file,...args)=>{if(file===${JSON.stringify(socket)} && ++calls===2) fs.chmodSync(${JSON.stringify(directory)},0o755); return original(file,...args);}; syncBuiltinESMExports();\n`);
    expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: { path: directory, mode: 0o755, problem: "owner-mode" } });
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
    expect(socketIdentity(socket)).toEqual(before);
    await expectLive(socket);
  });
});

it("refuses a broker whose inode changes during preview", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
  mkdirSync(directory, { mode: 0o700 });
  await withSocket(socket, async () => {
    const before = socketIdentity(socket);
    f.setPrelude(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.lstatSync; let calls=0; fs.lstatSync=(file,...args)=>{const s=original(file,...args); if(file===${JSON.stringify(socket)} && ++calls===3) Object.defineProperty(s,'ino',{value:s.ino+1}); return s;}; syncBuiltinESMExports();\n`);
    expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: { path: socket, problem: "changed" } });
    expect(socketIdentity(socket)).toEqual(before);
    await expectLive(socket);
  });
});

it("refuses a broker reached through a noncanonical ancestor", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock"), alias = join(f.root, "alias");
  mkdirSync(directory, { mode: 0o700 }); symlinkSync(f.home, alias);
  await withSocket(socket, async () => {
    const before = socketIdentity(socket);
    expect(() => inspectAgentPrivateModes(join(alias, "agent"))).toThrow();
    expect(socketIdentity(socket)).toEqual(before);
    await expectLive(socket);
  });
});

it("refuses a regular file at the broker socket path", async () => {
  const f = fixture(), directory = join(f.agentDir, "intercom"), socket = join(directory, "broker.sock");
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(socket, "not a socket", { mode: 0o600 });
  expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: { path: socket, problem: "type" } });
  await expect(repair(f)).rejects.toMatchObject({ code: "unsafe-destination", details: { path: socket, problem: "type" } });
  expect(readFileSync(socket, "utf8")).toBe("not a socket");
});

it("names the symlink path, found mode and owner in the raw preview refusal", () => {
  const f = fixture(), outside = join(f.home, "outside"), path = join(f.agentDir, "settings.json");
  writeFileSync(outside, "{}", { mode: 0o600 }); chmodSync(outside, 0o664); symlinkSync(outside, path);
  expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: { path, mode: lstatSync(path).mode & 0o7777, uid: process.getuid!(), problem: "symlink" } });
  expect(lstatSync(outside).mode & 0o7777).toBe(0o664);
});

it("names an injected foreign owner in the generated program refusal", () => {
  const f = fixture(), path = join(f.agentDir, "settings.json"), uid = process.getuid!() + 1;
  writeFileSync(path, "{}", { mode: 0o600 }); chmodSync(path, 0o664);
  f.setPrelude(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.lstatSync; fs.lstatSync=(file,...args)=>{const s=original(file,...args); if(file===${JSON.stringify(path)}) Object.defineProperty(s,'uid',{value:${uid}}); return s;}; syncBuiltinESMExports();\n`);
  expect(f.preview()).toMatchObject({ error: "unsafe-destination", details: { path, mode: 0o664, uid, problem: "owner" } });
  expect(lstatSync(path).mode & 0o7777).toBe(0o664);
});
