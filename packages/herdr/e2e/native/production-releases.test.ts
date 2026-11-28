// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it, vi } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { HerdrCliPorts } from '../../src/setup/cli.js';
import type { SetupContext } from '../../src/setup/installer.js';
import { HerdrLabelContract } from '../../src/contracts.js';
import { setupHerdr } from '../../src/setup/installer.js';
import { doctorHerdr } from '../../src/setup/doctor.js';
import { prepareNativeApp, createNativeAppDriver, verifyNativeAppSources, launchNativeApp, frontmostApp, type AppInvoke } from '../harness/app.js';
import { createFixtureRoot, createFencedDirectories, buildEnvironment, scratchRoot } from '../harness/environment.js';
import { openLedger, cleanupLedger, startWatchdog } from '../harness/resources.js';
import { startCores, realHcBinary } from '../harness/hc.js';
import { spawnOwned } from '../harness/processes.js';
import { deadline, waitFor } from '../harness/wait.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});

for (const [version, sourceBundle] of [['0.1.13', '/Applications/Herdr.app'], ['0.1.16', '/Applications/Herdr.app.new.noindex']] as const) {
  it.runIf(process.env.SPIDER_HERDR_PRODUCTION_RELEASES === '1')(`${version}: production setup and doctor on an owned native app`, async () => {
    const root = await createFixtureRoot(), ledger = openLedger(join(dirname(root), '_ledgers'), root);
    const watchdog = startWatchdog(ledger, Date.now() + 120000, join(root, 'watchdog.log'));
    const dirs = await createFencedDirectories(root), bin = join(root, 'bin'), env = buildEnvironment(process.env, dirs, { binDirectory: bin });
    let sequence = 0;
    const invoke: AppInvoke = async (binary, args, input) => {
      const environment = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
      const command = spawnOwned(ledger, { label: 'production-native-command', command: binary, args, env: environment, cwd: root, stdio: 'pipe' });
      const out: Buffer[] = [], err: Buffer[] = [];
      command.child.stdout!.on('data', data => out.push(data)); command.child.stderr!.on('data', data => err.push(data)); command.child.stdin!.end();
      const exit = await command.exited;
      const result = { exitCode: exit.code ?? 128, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
      await writeFile(join(root, `production-command-${sequence++}.json`), JSON.stringify({ binary, args, ...result }));
      return result;
    };
    let ports: (HerdrCliPorts & { dispose(): Promise<void> }) | undefined;
    const hostModule = '../../../host/src/herdr/ports.js';
    const { createProductionHerdrCliPorts } = await import(hostModule) as { createProductionHerdrCliPorts(root: string, env: Readonly<NodeJS.ProcessEnv>): HerdrCliPorts & { dispose(): Promise<void> } };
    const models = vi.spyOn(ModelRegistry.prototype, 'getAvailable').mockImplementation(function (this: ModelRegistry) { return this.getAll(); });
    try {
      const cores = await startCores(ledger, root, env, bin);
      const owned = await prepareNativeApp({ root, sourceBundle, sourceCore: join(dirname(realHcBinary()), 'herdr-core'), env: { ...cores.local.env, HC_SOCKET: cores.local.socket }, ledger, invoke });
      // These release fixtures exercise the recipe, not the bundle's shipped built-ins.
      const source = resolve(`packages/herdr/src/__tests__/fixtures/herdr-${version}`);
      await cp(join(source, 'mods'), join(owned.appHome, 'mods'), { recursive: true });
      await cp(join(source, 'layouts'), join(owned.appHome, 'layouts'), { recursive: true });
      await cp(join(source, 'keys.json'), join(owned.appHome, 'keys.json'));
      await writeFile(join(owned.appHome, 'shared.json'), JSON.stringify({ 'frame.welcomed': 'skipped' }));
      await writeFile(join(owned.appHome, 'update-notes.json'), JSON.stringify({ last_run: version, presented: [version] }));
      const launch = await launchNativeApp(owned, { invoke, ledger });
      expect(launch.after).toBe(launch.before);
      const app = createNativeAppDriver({ binary: owned.binary, env: owned.env, invoke, ownPath: path => path });
      const listed = await app.command('commands', {}) as { commands: { name: string }[] };
      const names = new Set(listed.commands.map(command => command.name));
      expect(names.has('terminal.search')).toBe(true);
      expect(names.has('window.minimize')).toBe(true);
      expect(names.has('terminal.select_all')).toBe(version === '0.1.16');
      const configPath = join(root, 'production-config.json');
      await writeFile(configPath, JSON.stringify({ app: { binary: owned.binary, home: owned.appHome }, core: { binary: cores.wrapper, config: join(dirs.XDG_CONFIG_HOME, 'herdr-core/config.toml') }, agentDirectory: dirs.PI_CODING_AGENT_DIR, globalRoot: dirs.SPIDER_GLOBAL_ROOT, shellRc: join(root, 'shellrc'), spaces: [], machines: [] }));
      const packageRoot = join(root, 'package');
      await mkdir(join(packageRoot, 'packages/herdr'), { recursive: true });
      await cp(resolve('dist'), join(packageRoot, 'dist'), { recursive: true });
      await cp(resolve('packages/herdr/assets'), join(packageRoot, 'packages/herdr/assets'), { recursive: true });
      const nativeProcesses = join(root, 'native-processes');
      await mkdir(nativeProcesses, { mode: 0o700 });
      ledger.update(value => { value.nativeProcessDirectory = nativeProcesses; });
      const reader = join(packageRoot, 'dist/herdr/feed-reader.mjs');
      const originalReader = await readFile(reader, 'utf8');
      const recordStart = `import { writeFileSync as recordNativeStart } from 'node:fs';\nimport { execFileSync as readNativeStart } from 'node:child_process';\nif (process.argv.includes('--serve')) recordNativeStart(${JSON.stringify(nativeProcesses)} + '/' + process.pid + '.json', JSON.stringify({ pid: process.pid, start: readNativeStart('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim() }), { flag: 'wx', mode: 0o600 });\n`;
      await writeFile(reader, recordStart + originalReader);
      await invoke('/usr/bin/git', ['init', '-q', root], owned.env);
      ports = createProductionHerdrCliPorts(packageRoot, owned.env);
      const location = vi.spyOn(process, 'cwd').mockReturnValue(root);
      const request = await ports.request(configPath).finally(() => location.mockRestore());
      const result = await setupHerdr(request, await ports.setupParts(request));
      await writeFile(join(root, 'production-setup.json'), JSON.stringify(result, null, 2));
      const doctor = await doctorHerdr(request, await ports.doctorParts(request));
      await writeFile(join(root, 'production-doctor.json'), JSON.stringify(doctor, null, 2));
      expect(doctor.failures).toEqual([]);
      expect(JSON.parse(await readFile(join(owned.appHome, 'layouts/Spider.json'), 'utf8')).window_blur).toBe(version === '0.1.16' ? true : undefined);
      const checks = [];
      for (const mod of ['spider-agents', 'spider-spaces', 'spider-pane', 'spider-tabs', 'spider-chrome', 'spider-menu', 'spider-picker', 'spider-panel', ...(version === '0.1.16' ? ['spider-toast'] : [])]) {
        const checked = await app.check(join(owned.appHome, 'mods', mod)); checks.push({ mod, ...checked });
        expect(checked.exitCode, checked.stderr).toBe(0);
      }
      await writeFile(join(root, 'production-mod-checks.json'), JSON.stringify(checks, null, 2));
      const output = join(scratchRoot(), 'production-staged', version);
      const parts = await ports.setupParts(request), preflight = await parts.preflight(request);
      const context: SetupContext = { labelContract: HerdrLabelContract, installed: {}, retiredTerminals: [], priorCutover: null, recordCutover: async () => {}, modProps: preflight.mods.map(copy => ({ ...copy, props: { modId: copy.directory.split('/').at(-1)!, feedRoot: join(request.config.globalRoot, 'herdr'), cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), nodePath: process.execPath, appBinary: owned.binary, configPath, labelContract: HerdrLabelContract } })) };
      const emitted = [...await parts.stageLook(request, context, 'export'), ...await parts.installFiles(request, context)];
      for (const file of emitted) if (file.path.startsWith(owned.appHome + '/') && (file.path.includes('/mods/') || file.path.endsWith('/layouts/Spider.json'))) {
        const target = join(output, file.path.slice(owned.appHome.length + 1));
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.bytes);
      }
      await writeFile(join(output, 'layout-source.json'), await readFile(join(owned.appHome, 'layouts/main.json')));
      await cp(join(owned.appHome, 'keys.json'), join(output, 'keys.json'));
      await writeFile(join(output, 'receipt.json'), JSON.stringify({ version, root, launch, doctor }, null, 2));
      if (process.env.SPIDER_HERDR_BLUR_CAPTURE === '1') {
        await app.command('space.new', { name: 'Compatibility', machine: '', argv: ['/bin/sh', '-c', 'printf "Compatibility text: neutral glass and readable terminal\\n"; exec cat'] });
        await app.command('app.theme', { name: 'spider-glass' });
        if (version === '0.1.16') {
          const executable = join(root, 'bright-backdrop'), ready = join(root, 'bright-backdrop.json');
          const compiled = await invoke('/usr/bin/swiftc', [resolve('packages/herdr/e2e/fixtures/bright-backdrop.swift'), '-o', executable], owned.env);
          let backdrop: unknown = { result: 'default backdrop', compiler: compiled.stderr };
          if (compiled.exitCode === 0) {
            spawnOwned(ledger, { label: 'bright-backdrop', command: executable, args: [String(launch.pid), ready], env: owned.env, cwd: root, stdio: { log: join(root, 'bright-backdrop.log') } });
            try { backdrop = await waitFor('owned bright backdrop', async () => JSON.parse(await readFile(ready, 'utf8').catch(() => 'null')), Boolean, deadline(5000)); }
            catch (error) { backdrop = { result: 'default backdrop', reason: String(error) }; }
          }
          await writeFile(join(root, 'backdrop.json'), JSON.stringify(backdrop, null, 2));
        }
        const shots: { option: string; result: string }[] = [];
        for (const option of version === '0.1.16' ? ['off', 'on'] : ['off']) {
          request.config.look = { autoHideTabs: true, windowBlur: option === 'on' };
          const files = await parts.stageLook(request, context, 'export');
          const layout = files.find(file => file.path.endsWith('/layouts/Spider.json'))!;
          await writeFile(join(owned.appHome, `layouts/spider-blur-${option}.json`), layout.bytes);
          await app.command('layout.switch', { name: `spider-blur-${option}` });
          await app.command('layout.select', { stack: 'panel-body', child: 'spider' });
          await app.command('layout.show', { id: 'panel' });
          const png = join(root, `window-blur-${option}.png`);
          try {
            await app.shot(png);
            if (version === '0.1.16') {
              const captured = await invoke('/usr/bin/swift', [resolve('packages/herdr/e2e/fixtures/capture-owned-window.swift'), String(launch.pid), owned.bundle, png], owned.env);
              await writeFile(join(root, `window-capture-${option}.json`), JSON.stringify(captured, null, 2));
              expect([0, 3], captured.stderr).toContain(captured.exitCode);
            }
            const text = await invoke('/usr/bin/swift', [resolve('packages/herdr/e2e/fixtures/window-text.swift'), png], owned.env);
            await writeFile(join(root, `window-blur-${option}-text.json`), text.stdout);
            expect(text.exitCode, text.stderr).toBe(0);
            expect(text.stdout).toContain('Compatibility text');
            shots.push({ option, result: 'captured' });
          } catch (error) { shots.push({ option, result: String(error) }); }
        }
        expect(shots.every(shot => shot.result === 'captured'), JSON.stringify(shots)).toBe(true);
        await writeFile(join(root, 'blur-shots.json'), JSON.stringify(shots, null, 2));
      }
      expect(await frontmostApp(invoke, owned.env)).toBe(launch.before);
      verifyNativeAppSources(owned);
      console.log(`Production ${version} evidence: ${root}`);
    } finally {
      await ports?.dispose(); models.mockRestore();
      const proof = await cleanupLedger(ledger.path, 'production-release'); watchdog.release(); await writeFile(join(root, 'cleanup-proof.json'), JSON.stringify(proof, null, 2));
      expect(proof.clean).toBe(true);
    }
  }, 120000);
}
