// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from './testutil.js';
import { createMachineCache } from '../ssh/cache.js';
import { createExecutionEnvironmentPolicy, installSshShim } from '../ssh/shim.js';
import { makeRunHandler } from '../../../subagents/src/actions/run.js';
import { RunEventTailer } from '../../../subagents/src/event-tailer.js';
import { defaultSpawner } from '../../../subagents/src/spawn-default.js';
import type { ChildHandle } from '../../../subagents/src/runner.js';
import { disabledHerdrEnvironment } from '../../../host/src/herdr/ports.js';

it('run action threads its environment policy into a real child bash while disabled runs preserve the inherited environment', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  const db = openDbAt(join(h.root, 'runs.db'), 'worktree'), tailer = new RunEventTailer(db), handles: ChildHandle[] = [];
  const cache = createMachineCache({ hc: h.hc, identity: h.owner!.terminal, directory: join(h.root, 'cache'), aliases: { 'remote.invalid': ['remote.invalid'] } }); await cache.ready;
  try {
    vi.stubEnv('PATH', `${h.root}:${process.env.PATH}`);
    expect(spawnSync('/bin/bash', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim()).toBe(h.sshBinary);
    await h.scenario({ ssh: { stdout: 'fixture only\n', exitCode: 17 } });
    const entry = join(h.root, 'shim-entry.ts'), shimProgram = join(h.root, 'shim.mjs');
    await writeFile(entry, `import {runSshShim} from ${JSON.stringify(resolve('packages/herdr/src/ssh/shim.ts'))};process.exitCode=await runSshShim(process.argv.slice(3));`);
    const bundle = await rolldown({ input: entry, platform: 'node' }); try { await bundle.write({ file: shimProgram, format: 'esm' }); } finally { await bundle.close(); }
    const options = { shimDirectory: join(h.root, 'shim'), realSshBinary: h.sshBinary, cacheDescriptor: cache.descriptor, shimProgram };
    await installSshShim(options); const policy = createExecutionEnvironmentPolicy(options);
    const parent = await new Promise<{ stderr: string; exitCode: number | null }>((resolve, reject) => { const child = spawn('/bin/bash', ['-c', 'ssh remote.invalid'], { env: { ...policy(h.localEnv) }, stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.on('error', reject); child.on('close', exitCode => resolve({ stderr, exitCode })); });
    expect(parent.exitCode).toBe(126); expect(parent.stderr).toContain('on:remote.invalid');
    for (const enabled of [true, false]) {
      const events: any[] = [], inheritedPath = process.env.PATH;
      const handler = makeRunHandler({ getCoordinators: () => ({ tailer, pipelines: [], children: new Map() }), spawner: spec => {
        const code = `const {spawnSync}=require('node:child_process');const resolved=spawnSync('/bin/bash',['-c','command -v ssh'],{encoding:'utf8'}).stdout.trim();if(!${JSON.stringify([h.sshBinary, join(options.shimDirectory, 'ssh')])}.includes(resolved))throw new Error('SSH fixture isolation failed');const r=spawnSync('/bin/bash',['-c',${JSON.stringify(`command -v ssh; ${enabled ? 'ssh remote.invalid' : 'true'}`)}],{encoding:'utf8'});console.log(JSON.stringify({type:'probe',stdout:r.stdout,stderr:r.stderr,exitCode:r.status,path:process.env.PATH}));`;
        const child = defaultSpawner({ ...spec, childMode: 'print', argv: [process.execPath, '-e', code], onRpcEvent: event => { events.push(event); spec.onRpcEvent?.(event); } }); handles.push(child); return child;
      } });
      await handler({ agent: 'worker', name: 'ssh probe', task: 'probe', context: 'fresh' }, { db, sessionId: h.owner!.sessionId, cwd: h.root, childMode: 'print', runDbPath: join(h.root, 'runs.db'), environmentPolicy: enabled ? policy : disabledHerdrEnvironment });
      await handles.at(-1)!.wait();
      const probe = events.find(event => event.type === 'probe'); expect(probe).toBeDefined();
      if (enabled) { expect(probe.path.split(':')[0]).toBe(options.shimDirectory); expect(probe.stdout.trim()).toBe(join(options.shimDirectory, 'ssh')); expect(probe.exitCode).toBe(126); expect(probe.stderr).toBe(parent.stderr); }
      else { expect(probe.path).toBe(inheritedPath); expect(probe.path).not.toContain(options.shimDirectory); }
    }
    const connections = (await readFile(join(h.root, 'ssh-calls.jsonl'), 'utf8').catch(() => '')).trim();
    expect(connections).toBe('');
  } finally { for (const handle of handles) { handle.kill('SIGKILL'); await handle.wait(); } tailer.stop(); db.close(); await cache.dispose(); await h.close(); vi.unstubAllEnvs(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 20000);
