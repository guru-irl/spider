import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { createTransport } from "@spider/roam/transport";
import { DEFAULT_LIMITS, disabledIntercom } from "@spider/roam/contracts";
import { createClientFixture } from "../../../../herdr/src/__tests__/testutil";
import * as liveness from "../../../../herdr/src/client/liveness";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
afterEach(() => vi.restoreAllMocks());

it.each([true, false])("a remote workspace-map uses the enrolled Pi without ambient Pi (available=%s)", async available => {
  const f = await createClientFixture();
  const root = join(f.root, "global"); mkdirSync(root, { mode: 0o700 });
  const db = openDb(join(root, "spider.db")); migrate(db, "global", { machineId: BOX, globalRoot: root });
  db.prepare("UPDATE roam_meta SET store_key='global'").run();
  try {
    vi.spyOn(liveness, "requireCoreAvailable").mockResolvedValue(undefined);
    const pi = join(f.root, available ? "configured-pi" : "missing-pi"), core = join(f.root, "remote-core.cjs");
    const mapped = join(f.root, "workspace");
    mkdirSync(mapped, { mode: 0o700 });
    mkdirSync(join(root, "roam"), { mode: 0o700 });
    if (available) writeFileSync(pi, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: BOX, hubMachineId: HUB,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() }), { mode: 0o600 });
    db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES(?,?,?)").run("fixture", "workspace-a", mapped);
    writeFileSync(core, `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));
else if(args[0]==='machine') console.log(JSON.stringify({machines:[{name:'box-1.invalid',id:'remote-core',state:'connected'}]}));
else if(args[0]==='exec') { const cmd=args.slice(args.indexOf('--')+1); const env={...process.env,PATH:'/usr/bin:/bin'}; delete env.SPIDER_ROAM_PI; const c=spawnSync(cmd[0],cmd.slice(1),{env,encoding:'utf8'}); process.stdout.write(c.stdout||'');process.stderr.write(c.stderr||'');process.exit(c.status??1); }
else process.exit(2);
`);
    chmodSync(core, 0o700);
    mkdirSync(join(root, "herdr"), { mode: 0o700 });
    writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: root,
      core: { binary: core, config: join(f.root, "core.json") }, agentDirectory: join(f.root, "agent"),
      shellRc: join(f.root, "shell.rc"), machines: [] }), { mode: 0o600 });
    const peer = { machineId: BOX, alias: "box-1.invalid", node: process.execPath, pi, cli: resolve("dist/roam/cli.mjs"), core, globalRoot: root };
    const transport = createTransport({ binary: core, env: f.localEnv, enrolled: [peer] });
    const request = { id: "map-a", kind: "move-workspace-map", machineId: BOX, expectedEpoch: null,
      args: { sessionId: "session-a", moveId: "move-a", sourceMachine: HUB, repoKey: "fixture", workspaceId: "workspace-a" } };
    const result = JSON.parse((await transport.exec(await transport.resolve(peer), ["roam", "agent", JSON.stringify(request)],
      { timeoutMs: 10000, maxBytes: DEFAULT_LIMITS.replyBytes })).toString());
    if (available) expect(result).toMatchObject({ code: 0, operationId: "map-a", value: { kind: "mapped", path: mapped } });
    else {
      expect(result).toMatchObject({ code: 1, reason: "participant-pi-unavailable", causeCode: "participant-pi-unavailable", operationId: "map-a", value: null });
      const inspect = { ...request, id: "inspect-a", kind: "session-inspect", expectedEpoch: 1,
        args: { sessionId: "session-a", moveId: "move-a", sourceMachine: HUB } };
      const failed = JSON.parse((await transport.exec(await transport.resolve(peer), ["roam", "agent", JSON.stringify(inspect)],
        { timeoutMs: 10000, maxBytes: DEFAULT_LIMITS.replyBytes })).toString());
      expect(failed).toMatchObject({ code: 1, causeCode: "participant-pi-unavailable", epoch: 1, operationId: "inspect-a" });
    }
  } finally { db.close(); await f.close(); }
});
