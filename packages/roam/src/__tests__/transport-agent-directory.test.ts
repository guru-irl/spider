import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";
import * as liveness from "../../../herdr/src/client/liveness";
import { createTransport } from "../transport";

afterEach(() => vi.restoreAllMocks());

it("runs agent, broker, and doctor commands in the configured destination agent directory", async () => {
  const f = await createClientFixture();
  try {
    vi.spyOn(liveness, "requireCoreAvailable").mockResolvedValue(undefined);
    const root = join(f.root, "box-state"), agentDir = join(f.root, "custom-agent");
    mkdirSync(join(root, "roam"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { mode: 0o700 });
    const machineId = "00000000-0000-4000-8000-000000000002";
    writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
    const cli = join(f.root, "remote.mjs"), core = join(f.root, "core.cjs");
    writeFileSync(cli, 'process.stdout.write(JSON.stringify({agentDir:process.env.PI_CODING_AGENT_DIR,args:process.argv.slice(2)}));');
    writeFileSync(core, `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));
else if(args[0]==='machine') console.log(JSON.stringify({machines:[{name:'box-1.invalid',id:'remote-core',state:'connected'}]}));
else if(args[0]==='exec') { const cmd=args.slice(args.indexOf('--')+1); const c=spawnSync(cmd[0],cmd.slice(1),{env:process.env,encoding:'utf8'}); process.stdout.write(c.stdout||'');process.stderr.write(c.stderr||'');process.exit(c.status??1); }
else process.exit(2);
`);
    chmodSync(core, 0o700);
    const peer = { machineId, alias: "box-1.invalid", node: process.execPath, pi: join(f.root, "prefix/bin/pi"), cli,
      core, globalRoot: root, agentDir };
    const transport = createTransport({ binary: core, env: { ...f.localEnv, PI_CODING_AGENT_DIR: join(f.root, "wrong-agent") }, enrolled: [peer] });
    const handle = await transport.resolve(peer);
    for (const argv of [["roam", "agent", "{}"], ["roam", "intercom", "start-broker"], ["roam", "intercom", "repair-units"], ["roam", "observe", "doctor"]]) {
      const reply = await transport.exec(handle, argv, { timeoutMs: 20000, maxBytes: 4096 });
      expect(JSON.parse(reply.toString())).toEqual({ agentDir, args: ["--global-root", root, ...argv] });
    }
  } finally { await f.close(); }
}, 10000);
