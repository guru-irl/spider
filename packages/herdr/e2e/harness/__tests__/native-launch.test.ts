import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openLedger } from '../resources.js';
import { spawnOwned } from '../processes.js';
import { buildEnvironment, createFencedDirectories, createFixtureRoot, fencedDirectories } from '../environment.js';
import { startCores, realHcBinary } from '../hc.js';
import { cleanupLedger, startWatchdog } from '../resources.js';
import { prepareNativeApp, validateNativeAppOwnership, readNativeAppOwnership, launchNativeApp, verifyNativeAppSources, createNativeAppDriver, type AppInvoke } from '../app.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0); });
function fixture() {
  const parent = resolve('.spider/scratch/e2'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'n-')); roots.push(root);
  const source = join(root, 'source.app'), core = join(root, 'source-core');
  mkdirSync(join(source, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(source, 'Contents/MacOS/Herdr'), 'synthetic executable', { mode: 0o700 });
  writeFileSync(join(source, 'Contents/Info.plist'), 'synthetic plist');
  writeFileSync(core, 'synthetic core', { mode: 0o700 });
  const dirs = fencedDirectories(root); for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const env = { ...dirs, PATH: '/usr/bin:/bin', HC_SESSION: 'l', HC_SOCKET: join(root, 'l.sock') };
  const ledger = openLedger(join(parent, '_ledgers'), root);
  const calls: { binary: string; argv: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }[] = [];
  const invoke: AppInvoke = async (binary, argv, environment) => {
    calls.push({ binary, argv, env: environment });
    if (binary === '/bin/cp') cpSync(argv[1]!, argv[2]!, { recursive: true });
    if (binary === '/usr/bin/plutil' && argv[0] === '-convert') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ CFBundleShortVersionString: '0.1.16', CFBundleIdentifier: 'dev.herdr.app', CFBundleExecutable: 'Herdr' }) };
    return { exitCode: 0, stderr: '', stdout: '' };
  };
  return { root, source, core, env, ledger, calls, invoke };
}

describe('isolated native app ownership', () => {
  it('records an APFS clone, copied pinned core, namespace and distinct identity', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    expect(f.calls.find(c => c.binary === '/bin/cp')!.argv[0]).toBe('-cR');
    expect(owned.binary).not.toBe(join(f.source, 'Contents/MacOS/Herdr'));
    expect(owned.appId).not.toBe('dev.herdr.app');
    expect(owned.namespace).toBe('l');
    expect(JSON.parse(readFileSync(join(owned.appHome, 'settings.json'), 'utf8'))).toMatchObject({ core: owned.coreBinary, sounds: { enabled: false } });
    expect(readFileSync(owned.coreBinary, 'utf8')).toBe('synthetic core');
    expect(f.ledger.read().appHome).toBe(owned.appHome);
    expect(validateNativeAppOwnership(owned.binary, owned.env)).toMatchObject({ binary: owned.binary });
    expect(() => verifyNativeAppSources(owned)).not.toThrow();
  });

  it('refuses original bundles, pending updates, launcher links and missing ownership', async () => {
    const f = fixture();
    for (const binary of ['/Applications/Herdr.app/Contents/MacOS/Herdr', '/Applications/Herdr.app.new.noindex/Contents/MacOS/Herdr', join(f.root, 'unowned')]) {
      expect(() => validateNativeAppOwnership(binary, f.env)).toThrow(/ownership|owned|original/);
    }
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    const link = join(f.root, 'launcher'); symlinkSync(owned.binary, link);
    expect(() => validateNativeAppOwnership(link, owned.env)).toThrow(/symlink|ownership|owned/);
    expect(() => validateNativeAppOwnership(owned.binary, { ...owned.env, HC_SESSION: 'default' })).toThrow(/namespace/);
    expect(() => validateNativeAppOwnership(owned.binary, { ...owned.env, HC_SCOPE: 'foreign' })).toThrow(/scope/);
    expect(() => validateNativeAppOwnership(owned.binary, { ...owned.env, HERDR_APP_HOME: '/unowned' })).toThrow(/home/);
    f.ledger.update(l => { l.state = 'closed'; });
    expect(() => validateNativeAppOwnership(owned.binary, owned.env)).toThrow(/ledger/);
    expect(readNativeAppOwnership(owned.binary).binary).toBe(owned.binary);
  });

  it('refuses native file targets outside the fixture before transport', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    let invoked = false;
    const driver = createNativeAppDriver({ binary: owned.binary, env: owned.env, ownPath: p => p,
      invoke: async () => { invoked = true; return { exitCode: 0, stdout: '', stderr: '' }; } });
    await expect(driver.shot(`${f.root}-outside/window.png`)).rejects.toThrow(/owned/);
    await expect(driver.check(`${f.root}-outside/mod`)).rejects.toThrow(/owned/);
    expect(invoked).toBe(false);
  });

  it('rejects malformed ownership metadata as an isolation error', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    writeFileSync(owned.env.SPIDER_HERDR_E2E_APP_OWNERSHIP!, JSON.stringify({ ...owned, env: null }));
    expect(() => validateNativeAppOwnership(owned.binary, owned.env)).toThrowError(expect.objectContaining({ code: 'isolation-unproved' }));
  });

  it('refuses changed cloned bundle metadata before starting a native process', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    writeFileSync(join(owned.bundle, 'Contents/Info.plist'), 'changed identity');
    expect(() => validateNativeAppOwnership(owned.binary, owned.env)).toThrow(/bundle.*digest/);
  });

  it('detects changed source and copied core hashes and refuses transport without ownership', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    writeFileSync(f.core, 'changed source');
    expect(() => verifyNativeAppSources(owned)).toThrow(/source/);
    writeFileSync(owned.coreBinary, 'changed copy');
    expect(() => validateNativeAppOwnership(owned.binary, owned.env)).toThrow(/core.*digest/);
    let invoked = false;
    const driver = createNativeAppDriver({ binary: '/Applications/Herdr.app/Contents/MacOS/Herdr', env: f.env, ownPath: p => p, invoke: async () => { invoked = true; throw new Error('must not run'); } });
    await expect(driver.status()).rejects.toThrow(/ownership|original/);
    expect(invoked).toBe(false);
  });

  it('launches only with explicit background Launch Services environment and unchanged frontmost identity', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    const frontmost = ['dev.fixture.editor', 'dev.fixture.editor'];
    await launchNativeApp(owned, { invoke: f.invoke, ledger: f.ledger, ready: async () => true, frontmost: async () => frontmost.shift()!, observe: async () => ({ pid: process.pid, bundlePath: owned.bundle, appId: owned.appId }) });
    const call = f.calls.find(c => c.binary === '/usr/bin/open')!;
    expect(call.argv.slice(0, 2)).toEqual(['-g', '-n']);
    for (const key of ['HERDR_APP_HOME', 'HC_SOCKET', 'HC_SESSION', 'HERDR_RELEASES_URL', 'HERDR_TELEMETRY', 'HERDR_APP_ID']) expect(call.argv).toContain(`${key}=${owned.env[key]}`);
    expect(owned.env.HERDR_RELEASES_URL).toBe('http://127.0.0.1:1');
    expect(owned.env.HERDR_TELEMETRY).toBe('0');
    expect(f.ledger.read().processes.some(p => p.label === 'native-app' && !p.group)).toBe(true);
  });

  it('refuses a checker home outside its fixture before any transport', async () => {
    const f = fixture(), outside = `${f.root}-outside`; mkdirSync(outside);
    let invoked = false;
    const driver = createNativeAppDriver({ binary: join(f.source, 'Contents/MacOS/Herdr'), env: { ...f.env, HERDR_APP_HOME: outside }, sourceCore: f.core, ownPath: p => p,
      invoke: async () => { invoked = true; return { exitCode: 0, stderr: '', stdout: '' }; } });
    await expect(driver.check(join(f.root, 'probe'))).rejects.toThrow(/owned/);
    expect(invoked).toBe(false);
  });

  it('copies a command-only checker and pins its compatible core without executing the source', async () => {
    const f = fixture();
    const source = join(f.source, 'Contents/MacOS/Herdr');
    const calls: string[][] = [];
    const driver = createNativeAppDriver({ binary: source, env: f.env, sourceCore: f.core, ownPath: p => p,
      invoke: async (binary, argv) => { calls.push([binary, ...argv]); return { exitCode: 0, stderr: '', stdout: 'checked' }; } });
    expect(await driver.check(join(f.root, 'probe'))).toMatchObject({ stdout: 'checked' });
    const checked = calls.find(call => call[1] === 'check')!;
    expect(checked[0]).not.toBe(source);
    expect(checked.slice(1)).toEqual(['check', join(f.root, 'probe'), '--print-spec']);
    expect(JSON.parse(readFileSync(join(f.env.HERDR_APP_HOME, 'settings.json'), 'utf8')).core).toBe(join(f.root, 'checker-core'));
    writeFileSync(join(f.root, 'checker-core'), 'changed copy');
    await expect(driver.check(join(f.root, 'probe'))).rejects.toThrow(/core.*digest/);
    expect(readFileSync(source, 'utf8')).toBe('synthetic executable');
  });

  it('waits for owned native IPC readiness before the final frontmost check', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    let attempts = 0; const frontmostAttempts: number[] = [];
    await launchNativeApp(owned, { invoke: f.invoke, ledger: f.ledger, ready: async () => ++attempts >= 2,
      frontmost: async () => { frontmostAttempts.push(attempts); return 'dev.fixture.editor'; },
      observe: async () => ({ pid: process.pid, bundlePath: owned.bundle, appId: owned.appId }) });
    expect(frontmostAttempts).toEqual([0, 2]);
  });

  it('fails unexpected activation rather than trying to restore live focus', async () => {
    const f = fixture();
    const owned = await prepareNativeApp({ root: f.root, sourceBundle: f.source, sourceCore: f.core, env: f.env, ledger: f.ledger, invoke: f.invoke });
    const frontmost = ['dev.fixture.editor', owned.appId];
    await expect(launchNativeApp(owned, { invoke: f.invoke, ledger: f.ledger, ready: async () => true, frontmost: async () => frontmost.shift()!, observe: async () => ({ pid: process.pid, bundlePath: owned.bundle, appId: owned.appId }) })).rejects.toThrow(/frontmost/);
    expect(f.calls.some(c => c.argv.includes('activate'))).toBe(false);
  });
});

for (const [release, sourceBundle] of [['0.1.13', '/Applications/Herdr.app'], ['0.1.16', '/Applications/Herdr.app.new.noindex']] as const) {
  it.runIf(process.env.SPIDER_HERDR_NATIVE_ISOLATION_SMOKE === '1' && process.platform === 'darwin')(`isolates native launch and window observations on ${release}`, async () => {
    const root = await createFixtureRoot();
    const ledger = openLedger(join(dirname(root), '_ledgers'), root);
    const watchdog = startWatchdog(ledger, Date.now() + 120_000, join(dirname(root), '_ledgers', `${ledger.id}.watchdog.log`));
    const dirs = await createFencedDirectories(root), bin = join(root, 'bin');
    const env = buildEnvironment(process.env, dirs, { binDirectory: bin });
    let sequence = 0;
    const invoke: AppInvoke = async (binary, argv, environment) => {
      const env = Object.fromEntries(Object.entries(environment).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
      const proc = spawnOwned(ledger, { label: 'native-smoke-command', command: binary, args: argv, env, cwd: root, stdio: 'pipe' });
      const out: Buffer[] = [], err: Buffer[] = [];
      proc.child.stdout!.on('data', bytes => out.push(bytes)); proc.child.stderr!.on('data', bytes => err.push(bytes)); proc.child.stdin!.end();
      const exit = await proc.exited;
      const result = { exitCode: exit.code ?? 128, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      writeFileSync(join(root, `command-${sequence++}.json`), JSON.stringify({ binary, argv, ...result }));
      return result;
    };
    let owned: Awaited<ReturnType<typeof prepareNativeApp>> | undefined;
    try {
      const cores = await startCores(ledger, root, env, bin);
      owned = await prepareNativeApp({ root, sourceBundle, sourceCore: join(dirname(realHcBinary()), 'herdr-core'), env: { ...cores.local.env, HC_SOCKET: cores.local.socket }, ledger, invoke });
      const driver = createNativeAppDriver({ binary: owned.binary, env: owned.env, invoke, ownPath: p => p });
      const listed = await driver.command('commands', {});
      writeFileSync(join(root, 'commands.json'), JSON.stringify(listed));
      const launched = await launchNativeApp(owned, { invoke, ledger });
      writeFileSync(join(root, 'launch.json'), JSON.stringify(launched));
      expect(launched.before).toBe(launched.after);
      const world = await driver.ls(), status = await driver.status();
      writeFileSync(join(root, 'world.json'), JSON.stringify(world)); writeFileSync(join(root, 'status.json'), JSON.stringify(status));
      expect(status).toMatchObject({ errors: [] });
      const probe = join(root, 'probe'); mkdirSync(probe);
      writeFileSync(join(probe, 'main.js'), 'import * as kit from "gpui-kit"; import * as herdr from "herdr"; const names=value=>Object.getOwnPropertyNames(value).filter(name=>/clipboard|copy/i.test(name)).map(name=>({name,kind:typeof value[name]})); const api={herdr:names(herdr),kit:names(kit),global:names(globalThis)}; export default class Probe extends kit.View {render(){return kit.div().child("Owned probe clipboard_api "+JSON.stringify(api));}}');
      const checked = await driver.check(probe);
      writeFileSync(join(root, 'check.json'), JSON.stringify(checked));
      expect(checked.exitCode, checked.stderr).toBe(0);
      expect(checked.stdout).toContain('clipboard_api');
      const shot = await driver.shot(join(root, 'window.png'));
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG');
      expect(() => verifyNativeAppSources(owned!)).not.toThrow();
    } finally {
      const proof = await cleanupLedger(ledger.path, 'native-smoke-close'); watchdog.release();
      expect(proof.clean).toBe(true);
      if (owned) expect(() => verifyNativeAppSources(owned!)).not.toThrow();
    }
  });
}
