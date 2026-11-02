// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import type { HerdrHarness } from '../testutil.js';
import { createMachineCache } from '../../ssh/cache.js';
import { createSshPolicy } from '../../ssh/policy.js';
import { createTransportPolicy } from '../../ssh/admin.js';
import { createExecutionEnvironmentPolicy, installSshShim } from '../../ssh/shim.js';

export async function acceptanceE(h: HerdrHarness): Promise<void> {
  const cache = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'ssh-cache') });
  try {
    await cache.ready;
    const entry = join(h.root, 'ssh-entry.ts'), shimProgram = join(h.root, 'ssh-cli.mjs');
    await writeFile(entry, `import { runSshShim } from ${JSON.stringify(fileURLToPath(new URL('../../ssh/shim.ts', import.meta.url)))}; process.exitCode = await runSshShim(process.argv.slice(3));`);
    const bundle = await rolldown({ input: entry, platform: 'node' }); try { await bundle.write({ file: shimProgram, format: 'esm' }); } finally { await bundle.close(); }
    const options = { shimDirectory: join(h.root, 'ssh-bin'), realSshBinary: h.sshBinary, cacheDescriptor: cache.descriptor, shimProgram };
    await installSshShim(options); const env = createExecutionEnvironmentPolicy(options)(h.localEnv);
    const policy = createTransportPolicy(createSshPolicy(cache), () => env);
    assert.equal((await policy.checkShell('/usr/bin/ssh remote.invalid')).kind, 'refuse');
    assert.equal((await policy.checkShell('true; ssh remote.invalid | cat')).kind, 'refuse');
    assert.equal((await policy.checkShell('scp local remote.invalid:/path')).kind, 'refuse');
    assert.equal((await policy.checkShell('git clone https://example.invalid/repo')).kind, 'allow');
    await h.scenario({ ssh: { exitCode: 17, stdout: 'ok\n' } });
    const execute = (binary: string, argv: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(binary, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
      child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; }); child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    });
    // Arbitrary programs' ordinary subprocesses use the PATH shim, not the parsed guard.
    const nested = await execute(h.nodeBinary, ['-e', 'const r=require("child_process").spawnSync("ssh",["remote.invalid"],{stdio:"inherit"});process.exit(r.status??1)']);
    assert.notEqual(nested.code, 0); assert.match(nested.err, /spider exec/);
    const connections = async () => (await readFile(join(h.root, 'ssh-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.deepEqual(await connections(), []);
    const other = await execute('/bin/sh', ['-c', 'ssh elsewhere.invalid echo ok']); assert.equal(other.code, 17); assert.equal(other.out, 'ok\n');
    assert.deepEqual(await connections(), [['elsewhere.invalid', 'echo', 'ok']]);
    // Deliberately use ONLY the fake real-SSH. An absolute helper inside a program is a documented policy bypass.
    const bypass = await execute(h.nodeBinary, ['-e', `const r=require("child_process").spawnSync(${JSON.stringify(h.sshBinary)},["remote.invalid"],{stdio:"inherit"});process.exit(r.status??1)`]);
    assert.equal(bypass.code, 17); assert.deepEqual(await connections(), [['elsewhere.invalid', 'echo', 'ok'], ['remote.invalid']]);
    await writeFile(join(h.root, 'ssh-policy-limitation.json'), JSON.stringify({ nestedAbsolutePathBypass: true, transport: 'fake-only' }));
  } finally { await cache.dispose(); }
}
