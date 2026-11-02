// SPDX-License-Identifier: MIT
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createHerdrHarness } from './isolated.js';

interface Probe {
  root: string;
  worker: number;
  binary: string;
  sides: { socket: string; pid: number; env: NodeJS.ProcessEnv }[];
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'win32') return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
    return true;
  } catch { return false; }
}

async function killedWorker(mode: 'fake' | 'hc') {
  const scratch = resolve('.spider/scratch/daemon-probe'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'run-'));
  const resultPath = join(root, 'ready.json'), configPath = join(root, 'vitest.config.ts'), testPath = join(root, 'worker.test.ts');
  const checkout = process.cwd();
  await writeFile(configPath, `import { defineConfig } from 'vitest/config';\nimport base from ${JSON.stringify(join(checkout, 'vitest.config.ts'))};\nexport default defineConfig({ test: { ...base.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1, testTimeout: 60000 } });\n`);
  await writeFile(testPath, `import { it } from 'vitest';\nimport { writeFile } from 'node:fs/promises';\nimport { createHerdrHarness } from ${JSON.stringify(join(checkout, 'packages/herdr/src/__tests__/isolated.ts'))};\nit('leaves cores to global teardown when the worker dies', async () => {\n  const h = await createHerdrHarness(${JSON.stringify(mode)}); await h.start();\n  const keys = ['PATH','TMPDIR','HC_SESSION','HC_SOCKET','HC_TERMINAL_SOCKET','XDG_STATE_HOME','XDG_CONFIG_HOME','HERDR_TEST_ROOT','HERDR_FAKE_ROOT','HERDR_FAKE_DAEMON','HERDR_FAKE_SCENARIO','HERDR_FAKE_REMOTE_SOCKET'];\n  const sides = []; for (const [side, env, socket] of [['local', h.localEnv, h.localSocket], ['remote', h.remoteEnv, h.remoteSocket]] as const) {\n    const status = await h.cli(['server','status','--json'], side);\n    sides.push({ socket, pid: (status as { pid: number }).pid, env: Object.fromEntries(keys.map(k => [k, env[k]]).filter(([,v]) => v !== undefined)) });\n  }\n  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({root: h.root, worker: process.pid, binary: h.hcBinary, sides}));\n  await new Promise(() => {});\n}, 60000);\n`);
  const child = spawn(process.execPath, [join(checkout, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath], { cwd: checkout, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let probe: Probe | undefined;
  try {
    await expect.poll(async () => { try { probe = JSON.parse(await readFile(resultPath, 'utf8')); return true; } catch { return false; } }, { timeout: 20000 }).toBe(true);
    expect(probe!.root.startsWith(resolve('.spider/scratch/h') + '/')).toBe(true);
    expect(probe!.sides).toHaveLength(2);
    expect(probe!.sides.every(side => side.socket.startsWith(probe!.root + '/') && alive(side.pid))).toBe(true);
    process.kill(probe!.worker, 'SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Nested Vitest did not exit: ${output}`)), 20000); })]); }
    finally { clearTimeout(timer); }
    await expect.poll(() => probe!.sides.filter(side => alive(side.pid)), { timeout: 5000 }).toEqual([]);
  } catch (error) {
    throw new Error(`Killed-worker probe failed: ${String(error)}\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    // In a red run, stop only the two sockets proved to belong to this probe.
    if (probe && probe.root.startsWith(resolve('.spider/scratch/h') + '/')) for (const side of probe.sides) {
      if (side.socket.startsWith(probe.root + '/') && alive(side.pid)) spawnSync(probe.binary, ['server', 'stop', '--json'], { env: side.env, timeout: 3000 });
    }
  }
}
it('global teardown stops fake cores after a worker is killed without stopping another run', async () => {
  const peer = await createHerdrHarness('fake');
  try {
    await peer.start();
    await killedWorker('fake');
    expect((await peer.hc.identity()).coreId).toBe(peer.localCoreId);
    expect((await peer.remoteHc.identity()).coreId).toBe(peer.remoteCoreId);
  } finally { await peer.close(); }
}, 60000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('global teardown stops real isolated hc cores after a worker is killed', () => killedWorker('hc'), 60000);
