// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile, access, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { SSH_DESCRIPTOR_ENV } from '../../../herdr/src/ssh/shim.js';
import { CACHE_VALID_MS } from '../../../herdr/src/ssh/cache.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';

async function shell(env: Readonly<NodeJS.ProcessEnv>, command: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
async function twoSessions(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode); const mounts: HerdrMount[] = [];
  try {
    await h.start();
    expect(h.localSocket).not.toBe(h.remoteSocket); expect(h.localCoreId).not.toBe(h.remoteCoreId);
    expect(Buffer.byteLength(h.localSocket)).toBeLessThan(104); expect(Buffer.byteLength(h.remoteSocket)).toBeLessThan(104);
    await mkdir(join(h.root, 'dist/herdr'), { recursive: true });
    await copyFile(resolve('dist/herdr/cli.mjs'), join(h.root, 'dist/herdr/cli.mjs'));
    await copyFile(resolve('dist/herdr/remote-runtime.mjs'), join(h.root, 'dist/herdr/remote-runtime.mjs'));
    await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
    // Both sessions use the real global lookup. Their core machine inventories differ.
    const configPath = standardHerdrConfigPath(h.directories.global);
    await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    await writeFile(configPath, JSON.stringify({ enabled: true, app: { binary: join(h.root, 'no-app'), home: h.directories.app },
      core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global,
      shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: [], nodePath: process.execPath,
        runtime: { cwd: null, directory: join(h.directories.remote, 'programs'), commands: {} } }], admin: { wrappers: [] } }));
    await writeFile(join(h.directories.app, 'settings.json'), '{}\n');
    execFileSync('git', ['init', '-q', h.directories.local]);
    const setupPorts = configFixtureCwd(createProductionHerdrCliPorts(h.root, h.localEnv), h.directories.local);
    try {
      const request = await setupPorts.request();
      const parts = await setupPorts.setupParts(request);
      await setupHerdr(request, { ...parts,
        // No app window or cutover. File generation, runtime writes and bootstrap are production code.
        preflight: async () => ({ fingerprint: 'ssh-fixture', coreIdentity: h.owner!.terminal,
          mods: ['panel'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })),
          targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ checks: [], failures: [], warnings: [], probes: [] }),
      });
      const runtime = (await readJournal(request.journalRoot)).runtimes[0];
      expect(runtime.path).toMatch(/spider-remote-runtime-[a-f0-9]{16}\.mjs$/);
      expect(await h.hc.fileRead('remote.invalid' as never, runtime.path)).toEqual(await readFile(join(h.root, 'dist/herdr/remote-runtime.mjs')));
      await access(join(h.directories.app, 'mods/spider-panel/main.js'));
      await expect(access(join(h.directories.app, 'mods/spider-machines/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await setupPorts.dispose(); }
    const firstBinaryDirectory = join(h.root, 'first-bin'), secondBinaryDirectory = join(h.root, 'second-bin');
    for (const [directory, marker] of [[firstBinaryDirectory, 'FIRST-SSH'], [secondBinaryDirectory, 'SECOND-SSH']]) {
      await mkdir(directory); await writeFile(join(directory, 'ssh'), `#!/bin/sh\nprintf '${marker} %s\\n' "$1"\n`, { mode: 0o700 });
    }
    const secondTerminal = await h.remoteHc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: {}, background: true, noNotify: true, outliveParent: true });
    const envs = [
      { ...h.localEnv, PATH: `${firstBinaryDirectory}:${h.localEnv.PATH}` },
      { ...h.remoteEnv, HC_TERMINAL_ID: secondTerminal.address, HC_TERMINAL_SOCKET: h.remoteSocket, PATH: `${secondBinaryDirectory}:${h.remoteEnv.PATH}` },
    ];
    const starts: (() => Promise<void>)[] = [];
    for (const [index, env] of envs.entries()) {
      execFileSync('git', ['init', '-q', join(h.root, index ? 'second-repo' : 'first-repo')]);
      const cwd = join(h.root, index ? 'second-repo' : 'first-repo');
      const dbPath = join(h.root, `runs-${index}.db`), globalPath = join(h.root, `global-${index}.db`);
      openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
      const hooks = new Map<string, Function[]>(), errors: unknown[] = [];
      const pi = { on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, sendMessage() {} };
      const ctx = { cwd, mode: 'rpc', hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => `ssh-session-${index}`, getSessionFile: () => undefined } };
      const mount = mountHerdr(pi as never, { packageRoot: h.root, actionContext: () => ({}), reportError: error => errors.push(error),
        views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
        dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
          readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
      mounts.push(mount);
      starts.push(async () => {
        for (const [key, value] of Object.entries(env)) if (value !== undefined) vi.stubEnv(key, value);
        vi.stubEnv('PI_SUBAGENT_CHILD', '0');
        for (const hook of hooks.get('session_start') ?? []) await hook({}, ctx);
        expect(errors).toEqual([]); expect(mount.enabled()).toBe(true);
      });
    }
    await starts[0]();
    const envA = mounts[0].execution().environmentPolicy(envs[0]);
    expect((await shell(envA, 'ssh remote.invalid uname')).code).toBe(126);
    await starts[1]();
    const envB = mounts[1].execution().environmentPolicy(envs[1]);
    // The regression: installing B must not send A's managed endpoint to raw SSH.
    expect(await shell(envA, 'ssh remote.invalid uname')).toMatchObject({ code: 126, stdout: '' });
    expect(await shell(envB, 'ssh remote.invalid uname')).toMatchObject({ code: 0, stdout: 'SECOND-SSH remote.invalid\n' });
    expect(await shell(envA, 'ssh unmanaged.invalid uname')).toMatchObject({ code: 0, stdout: 'FIRST-SSH unmanaged.invalid\n' });
    await mounts[1].dispose();
    const descriptorB = JSON.parse(envB[SSH_DESCRIPTOR_ENV]!);
    const snapshotB = JSON.parse(await readFile(descriptorB.cacheDescriptor.path, 'utf8'));
    snapshotB.fetchedAt = Date.now() - CACHE_VALID_MS - 1;
    await writeFile(descriptorB.cacheDescriptor.path, JSON.stringify(snapshotB));
    expect(await shell(envA, 'ssh unmanaged.invalid uname')).toMatchObject({ code: 0, stdout: 'FIRST-SSH unmanaged.invalid\n' });
    expect((await shell(envA, 'ssh remote.invalid uname')).code).toBe(126);
    console.log(`two-session ${mode}: independent cores, managed refusal, per-session real SSH, stale peer isolation proved`);
  } finally {
    await Promise.all(mounts.map(mount => mount.dispose())); vi.unstubAllEnvs();
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    console.log(`two-session ${mode}: ${JSON.stringify(h.cleanupProof)}`);
  }
}

test('two host sessions never borrow another core SSH descriptor', () => twoSessions('fake'), 60000);
const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
test.skipIf(!realHc)('two host sessions on real isolated hc cores keep their own SSH routing', () => twoSessions('hc'), 60000);
