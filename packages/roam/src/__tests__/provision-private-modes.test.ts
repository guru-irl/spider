import { afterEach, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BOOTSTRAP_SETTINGS_SCRIPT } from "../bootstrap-script";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";
import { createHcProvisionAdapter } from "../provision-adapter";
import { DEFAULT_LIMITS, type Peer } from "../contracts";

const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "provision-private-")); roots.push(root);
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
