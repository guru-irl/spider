import { describe, expect, it } from 'vitest';
import { validateAppCommand, parseAppReply, parseAppEnvelope, createNativeAppDriver, appObject, prepareNativeApp, type AppInvoke } from '../app.js';
import { createFakeAppDriver } from '../fake-app.js';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counterInput } from '../../fixtures/panel-inputs.js';
import { prepareInstallInputs } from '../../fixtures/install-inputs.js';
import { cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import { writeFileSync } from 'node:fs';
import { fencedDirectories } from '../environment.js';
import { openLedger } from '../resources.js';

async function ownedTransport() {
  const parent = resolve('.spider/scratch/e2'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'd-')), source = join(root, 'source.app'), core = join(root, 'source-core');
  mkdirSync(join(source, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(source, 'Contents/MacOS/Herdr'), 'synthetic app', { mode: 0o700 });
  writeFileSync(join(source, 'Contents/Info.plist'), 'synthetic plist'); writeFileSync(core, 'synthetic core', { mode: 0o700 });
  const dirs = fencedDirectories(root); for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true });
  const env = { ...dirs, HC_SESSION: 'l', HC_SOCKET: join(root, 'l.sock') };
  const ledger = openLedger(join(parent, '_ledgers'), root);
  const invoke: AppInvoke = async (binary, argv) => {
    if (binary === '/bin/cp') cpSync(argv[1]!, argv[2]!, { recursive: true });
    return { exitCode: 0, stderr: '', stdout: binary === '/usr/bin/plutil' && argv[0] === '-convert' ? JSON.stringify({ CFBundleShortVersionString: '0.1.16', CFBundleExecutable: 'Herdr' }) : '' };
  };
  return { owned: await prepareNativeApp({ root, sourceBundle: source, sourceCore: core, env, ledger, invoke }), ledger };
}

// A permissive command or reply parser must break these tests.
describe('external counter fixture', () => {
  it('supplies independent API-shaped quota inputs for the two runnable budget thresholds', () => {
    const at = Date.UTC(2026, 10, 1);
    expect(counterInput('80', at)).toEqual({ login: 'fixture-account', quota_reset_date: '2026-12-01', quota_snapshots: { premium_interactions: { credits_used: 80, entitlement: 100, remaining: 20, token_based_billing: true } } });
    expect(counterInput('100', at).quota_snapshots.premium_interactions).toEqual({ credits_used: 100, entitlement: 100, remaining: 0, token_based_billing: true });
  });
  it('holds the first real Unix-socket response until release and logs no authorization', async () => {
    const module = await import(pathToFileURL(resolve('packages/herdr/e2e/fixtures/counter-server.mjs')).href);
    const scratch = resolve('.spider/scratch/e2'); mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, 'q-'));
    const socket = join(root, 'q.sock'), logPath = join(root, 'requests.jsonl');
    const body = { login: 'fixture-account', quota_reset_date: '2027-01-01', quota_snapshots: { premium_interactions: { credits_used: 80, entitlement: 100, remaining: 20, token_based_billing: true } } };
    const server = module.createCounterServer({ root, socket, body, logPath, holdFirst: true }); await server.listen();
    const fetchCounter = (path: string) => new Promise<any>((resolve, reject) => {
      const call = request({ socketPath: socket, method: 'GET', path, headers: { Authorization: 'Bearer fixture-only-oauth' } }, response => { let text = ''; response.on('data', bytes => { text += bytes; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); }); call.on('error', reject); call.end();
    });
    try {
      const pending = fetchCounter('/copilot_internal/user'); await server.firstRequest;
      const log = readFileSync(logPath, 'utf8'); expect(log).not.toContain('Authorization'); expect(log).not.toContain('fixture-only-oauth');
      expect(JSON.parse(log)).toMatchObject({ seq: 1, method: 'GET', path: '/copilot_internal/user' });
      server.release(1); expect(await pending).toEqual({ status: 200, body });
      expect(() => server.release(1)).toThrow(/duplicate release/);
      expect(await fetchCounter('/wrong')).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    } finally { await server.close(); }
  });
});
describe('suite app wiring', () => {
  it('caches one supervised daemon and exposes the same actual document through AppDriver and product CLI', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-app-wiring') });
    try {
      const [first, second] = await Promise.all([suite.app(), suite.app()]); expect(first).toBe(second);
      const allocated = await first.command('space.new', { name: 'Workshop', folder: suite.root, argv: ['/bin/sh', '-c', 'printf app-wiring-ready; exec cat'] });
      const connection = (suite as any).appConnection;
      expect(connection).toMatchObject({ binary: expect.any(String), env: expect.any(Object) });
      const shell = await first.command('space.new', { machine: suite.cores!.machine, folder: suite.root, argv: [] }) as { terminal: string };
      expect(shell.terminal).toMatch(/^dest\.invalid\//);
      const cli = await suite.invoke(connection.binary, ['ls'], connection.env); expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual(await first.ls());
      expect(suite.ledger.read().processes.filter(p => p.label === 'fake-app-daemon')).toHaveLength(1);
      const dir = suite.ownPath(join(suite.root, 'check-mod')); mkdirSync(dir);
      writeFileSync(join(dir, 'main.js'), `import {View,div} from 'gpui-kit'; export default class Panel extends View {render(){return div().child('Headless checker fixture');}}`);
      const checked = await first.check(dir); expect(checked.exitCode).toBe(0); expect(checked.stdout).toContain('Headless checker fixture');
      await suite.evidence('app-wiring.json', { allocated, cli: JSON.parse(cli.stdout), checked });
    } finally { const proof = await suite.close(); expect(proof.clean).toBe(true); }
  });
});
describe('native owned space selection', () => {
  it('shares ID and numeric selection through the real supervised daemon', async () => {
    const suite=await createSuite({tier:'headless',story:storyId('H-space-selection')});
    try {
      const app=await suite.app(),first=appObject(await app.command('space.new',{name:'first',argv:[]})),extra=appObject(await app.command('tab.new',{space:first.space,argv:[]})),before=appObject(await app.status());
      const second=appObject(await app.command('space.new',{name:'second',argv:[]}));const cli=await suite.invoke(suite.appConnection!.binary,['do','space.select','--id',String(first.space)]);expect(cli).toMatchObject({exitCode:0,stderr:''});
      expect(await app.status()).toMatchObject({space:first.space,tab:extra.tab,agent:extra.terminal,focused_pane:before.focused_pane});
      const indexed=await suite.invoke(suite.appConnection!.binary,['do','space.select','--index','2']);expect(indexed).toMatchObject({exitCode:0,stderr:''});expect(await app.status()).toMatchObject({space:second.space,tab:second.tab,agent:second.terminal});
      await expect(app.command('space.select',{id:'unowned-space'})).rejects.toThrow(/no such space/);expect(await app.status()).toMatchObject({space:second.space,tab:second.tab,agent:second.terminal});
      await suite.evidence('space-selection.json',{first,extra,second,before,cli,indexed,status:await app.status(),world:await app.ls()});
    }finally{expect((await suite.close()).clean).toBe(true);}
  });
});
describe('native layout selection persistence', () => {
  it('writes the exact selected layout name to shared.json after loading the layout', async () => {
    const original = await createSuite({ tier: 'headless', story: storyId('H-layout-selection') });
    try {
      const { suite, app, config } = await prepareInstallInputs(original), path = suite.ownPath(join(config.app.home, 'shared.json'));
      await cp(join(config.app.home, 'layouts/main.json'), suite.ownPath(join(config.app.home, 'layouts/Spider.json')));
      await writeFile(path, '{"layout":"main","theme":"fixture-theme","retained":17}\n', { mode: 0o600 });
      await app.command('layout.switch', { name: 'Spider' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ layout: 'Spider', theme: 'fixture-theme', retained: 17 });
      expect(await app.status()).toMatchObject({ layout: 'Spider' });
      const bytes = await readFile(path, 'utf8'); await app.command('layout.switch', { name: 'Spider' }); expect(await readFile(path, 'utf8')).toBe(bytes);
      await expect(app.command('layout.switch', { name: 'unavailable-layout' })).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe(bytes);
      await suite.evidence('native-layout-selection.json', { shared: JSON.parse(bytes), status: await app.status(), source: 'Herdr 0.1.18 window.rs load_layout publishes the selected name to the shared store' });
      await writeFile(path, '[]', { mode: 0o600 }); await expect(app.command('layout.switch', { name: 'main' })).rejects.toThrow(/malformed owned app shared state/); expect(await readFile(path, 'utf8')).toBe('[]');
      await writeFile(path, bytes, { mode: 0o600 }); const target = suite.ownPath(join(suite.root, 'guard-target')); await writeFile(target, 'untouched', { mode: 0o600 }); await symlink(target, suite.ownPath(`${path}.new`));
      await expect(app.command('layout.switch', { name: 'main' })).rejects.toThrow(/symlink app path/); expect(await readFile(target, 'utf8')).toBe('untouched'); expect(await readFile(path, 'utf8')).toBe(bytes);
      await suite.evidence('layout-selection-faults.json', { malformedSharedStateRetained: '[]', stagingSymlinkTarget: await readFile(target, 'utf8'), shared: JSON.parse(await readFile(path, 'utf8')) });
    } finally { expect((await original.close()).clean).toBe(true); }
  });
});
describe('app 0.1.11 command boundary', () => {
  it.each([
    ['ls', {}], ['status', {}], ['space.new', { name: 'Workshop', argv: ['pi', '--session', 'owned.jsonl'] }],
    ['space.new', { machine: 'dest.invalid', argv: [] }],
    ['tab.new', { space: 'sp1', name: 'Agent', argv: ['pi'] }], ['tab.rename', { id: 'tb1', name: '' }],
    ['tab.close', { id: 'tb1', confirmed: true }], ['pane.focus', { terminal: 't1' }],
    ['terminal.park', { terminal: 't1' }], ['terminal.keep', { terminal: 't1', place: 'right' }],
    ['layout.switch', { name: 'Spider' }], ['layout.show', { id: 'panel' }],
    ['layout.hide', { id: 'panel' }], ['layout.select', { stack: 'panel-body', child: 'spider' }],
    ['app.theme', { name: 'spider-glass' }],
  ])('accepts verified %s arguments', (name, args) => {
    expect(() => validateAppCommand(name, args)).not.toThrow();
    expect(() => validateAppCommand(name, { ...args, typo: 'wrong-target' })).toThrow(/unknown argument/);
  });
  const nativeWorld = (status: unknown) => ({ spaces: [{ id: 'sp1', name: 'Fixture', folder: 'fixture', machine: null, active: true,
    tabs: [{ id: 'tb1', name: 'Owner', active: true, settled: false,
      terminals: [{ terminal: 't1', pane: 'p1', status, app: 'pi', name: null, sub_agents: [] }] }] }], recent: [] });
  it.each(['working', 'blocked', 'done', 'idle'])('accepts documented native terminal status %s', status => {
    const world = nativeWorld(status);
    expect(parseAppReply('ls', {}, world)).toEqual(world);
  });
  it.each(['unknown', 'running', 42, false, undefined])('rejects unknown native terminal status %s', status => {
    expect(() => parseAppReply('ls', {}, nativeWorld(status))).toThrow(/invalid app reply/);
  });
  const nativeStatus = (floats: unknown) => ({ zoom: 1, font_size: 14, ui_font_size: 13, space: 'sp1', tab: 'tb1', focused_pane: 'p1',
    layout: 'Spider', agent: 't1', floats, overlays: ['frame-welcome', 'confirm'], errors: [] });
  it('accepts the observed native floating-window status map', () => {
    const status = nativeStatus({}); expect(parseAppReply('status', {}, status)).toEqual(status);
  });
  it.each([null, 'floating', 42, false])('rejects malformed floating-window status %s', floats => {
    expect(() => parseAppReply('status', {}, nativeStatus(floats))).toThrow(/invalid app reply/);
  });
  it('refuses unsupported commands and wrong argument types before transport', () => {
    expect(() => validateAppCommand('terminal.send', { terminal: 't1' })).toThrow(/unknown command/);
    expect(() => validateAppCommand('terminal.park', {})).toThrow(/needs terminal/);
    expect(() => validateAppCommand('space.new', { argv: 'pi --session wrong' })).toThrow(/argv/);
    expect(() => validateAppCommand('tab.close', { id: 'tb1', confirmed: 'true' })).toThrow(/confirmed/);
    expect(() => validateAppCommand('pane.focus', { terminal: 't1', pane: 'p1' })).toThrow(/one target/);
  });
  it('accepts only bounded mod commands, canonical encoded targets and empty private args', () => {
    for (const name of ['spider-pane.park', 'spider-agents.sort-priority', 'spider-agents.sort-space', 'spider-agents.sort-machine', 'spider-panel.refresh']) expect(() => validateAppCommand(name, {})).not.toThrow();
    expect(() => validateAppCommand('spider-agents.sort-grouped', {})).toThrow(/unknown command/);
    expect(() => validateAppCommand('spider-agents.console-group-toggle:' + encodeURIComponent('owner:t1/parent'), {})).not.toThrow();
    expect(() => validateAppCommand('spider-agents.activate-session:' + encodeURIComponent('session-1'), {})).not.toThrow();
    expect(() => validateAppCommand('mod.open', { name: 'spider-picker' })).not.toThrow();
    expect(() => validateAppCommand('commands', {})).not.toThrow();
    for (const name of ['spider-pane.eval', 'spider-agents.activate-session:', 'spider-agents.activate-session:%ZZ', 'spider-agents.activate-session:%0A', 'spider-agents.console-group-toggle:non%2fcanonical']) expect(() => validateAppCommand(name, {})).toThrow();
    expect(() => validateAppCommand('spider-pane.park', { terminal: 't1' })).toThrow(/empty/);
    expect(() => validateAppCommand('mod.open', { name: 'arbitrary' })).toThrow(/mod/);
  });

  it('parses the observed native commands array without accepting malformed command metadata', () => {
    const commands = [{ name: 'mod.open', args: [{ name: 'name', required: true }], about: 'Open an overlay.' }];
    expect(parseAppReply('commands', {}, commands)).toEqual({ commands });
    expect(() => parseAppReply('commands', {}, [{ name: 7 }])).toThrow(/invalid app reply/);
  });

  it('requires allocated native IDs, pending park acknowledgements, and explicit success', () => {
    expect(parseAppReply('space.new', {}, { space: 'sp1', tab: 'tb1', terminal: 't1' })).toEqual({ space: 'sp1', tab: 'tb1', terminal: 't1' });
    expect(parseAppReply('terminal.park', { terminal: 't1' }, { pending: true, terminal: 't1' })).toEqual({ pending: true, terminal: 't1' });
    expect(parseAppReply('tab.rename', { id: 'tb1', name: 'A' }, { ok: true })).toEqual({ ok: true });
    for (const bad of [null, [], {}, { ok: false }, { space: 'sp1', tab: 'tb1' }, { space: '', tab: 'tb1', terminal: 't1' }]) {
      expect(() => parseAppReply('space.new', {}, bad)).toThrow(/invalid app reply/);
    }
    expect(() => parseAppReply('terminal.park', { terminal: 't1' }, { pending: true, terminal: 'other' })).toThrow(/wrong terminal/);
    expect(() => parseAppReply('tab.rename', {}, {})).toThrow(/invalid app reply/);
    expect(() => parseAppReply('ls', {}, { spaces: [{ id: 'sp1', tabs: [{}] }] })).toThrow(/invalid app reply/);
    expect(() => parseAppReply('status', {}, { errors: [] })).toThrow(/invalid app reply/);
    expect(() => parseAppReply('tab.close', {}, { error: 'no such tab' })).toThrow(/no such tab/);
  });
  it('rejects a reply for a different request rather than treating it as success', () => {
    expect(parseAppEnvelope('request-1', 'tab.rename', {}, { requestId: 'request-1', result: { ok: true } })).toEqual({ ok: true });
    expect(() => parseAppEnvelope('request-1', 'tab.rename', {}, { requestId: 'request-2', result: { ok: true } })).toThrow(/wrong request id/);
    expect(() => parseAppEnvelope('request-1', 'tab.rename', {}, { requestId: 'request-1' })).toThrow(/invalid app reply/);
  });
  it('refuses allocated IDs not present in the actual app document', async () => {
    const { owned, ledger } = await ownedTransport();
    try {
      const driver = createNativeAppDriver({ binary: owned.binary, env: owned.env, ownPath: p => p,
        invoke: async (_binary, args) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'ls' ? { spaces: [], recent: [] } : { space: 'wrong-space', tab: 'wrong-tab', terminal: 'wrong-terminal' }) }) });
      await expect(driver.command('space.new', { argv: ['pi'] })).rejects.toThrow(/unobserved allocated IDs/);
    } finally { ledger.update(l => { l.state = 'closed'; }); }
  });
  it('discovers native commands through their subcommand and sends bounded dotted dispatch', async () => {
    const { owned, ledger } = await ownedTransport();
    const calls: readonly string[][] = [];
    const registered = new Set(['p1', 't1', 'owner:t1/parent', 'session-1']);
    try {
      const driver = createNativeAppDriver({ binary: owned.binary, env: owned.env, ownPath: p => p, ownsTarget: (_kind, id) => registered.has(id),
        invoke: async (_binary, argv) => {
          (calls as string[][]).push([...argv]);
          const value = argv[0] === 'commands' ? { commands: [{ name: 'pane.close' }] } : argv[0] === 'status' ? { layout: 'Spider', space: 's1', tab: 'tb1', focused_pane: 'p1', agent: 't1', errors: [], overlays: [], floats: {} } : { ok: true };
          return { exitCode: 0, stderr: '', stdout: JSON.stringify(value) };
        } });
      expect(await driver.command('commands', {})).toEqual({ commands: [{ name: 'pane.close' }] });
      expect(calls[0]).toEqual(['commands']);
      await driver.command('pane.focus', { terminal: 't1' });
      await driver.command('spider-pane.park', {});
      await driver.command('spider-agents.console-group-toggle:' + encodeURIComponent('owner:t1/parent'), {});
      await driver.command('spider-agents.activate-session:session-1', {});
      expect(calls).toContainEqual(['do', 'spider-pane.park']);
      expect(calls).toContainEqual(['do', 'spider-agents.activate-session:session-1']);
      const count = calls.length;
      await expect(driver.command('pane.focus', { terminal: 'foreign' })).rejects.toThrow(/not owned/);
      await expect(driver.command('spider-agents.activate-session:foreign', {})).rejects.toThrow(/not owned/);
      registered.delete('p1');
      await expect(driver.command('spider-pane.park', {})).rejects.toThrow(/not owned/);
      expect(calls.length).toBe(count + 1);
    } finally { ledger.update(l => { l.state = 'closed'; }); }
  });

  it('adapts the fake boundary without inventing pixels or window key routing', async () => {
    const driver = createFakeAppDriver({ boundary: { command: async () => ({ spaces: [], recent: [] }), drain: async () => {} },
      check: async () => ({ exitCode: 0, stdout: 'actual check', stderr: '' }) });
    expect(await driver.ls()).toEqual({ spaces: [], recent: [] });
    expect(await driver.check('owned-mod')).toMatchObject({ stdout: 'actual check' });
    await expect(driver.shot('owned-image')).rejects.toMatchObject({ code: 'fake-app-no-pixels' });
    await expect(driver.keyToOwnedWindow('cmd+a')).rejects.toMatchObject({ code: 'fake-app-no-window' });
    await expect(driver.uiSnapshot()).rejects.toMatchObject({ code: 'render-host-not-mounted' });
  });
  it('fails all native interaction capabilities with P2 before any transport', async () => {
    const driver = createNativeAppDriver({ binary: 'owned-app', env: {}, invoke: async () => { throw new Error('transport must not run'); }, ownPath: p => p });
    await expect(driver.uiSnapshot()).rejects.toMatchObject({ code: 'P2-native-rendered-ui' });
    await expect(driver.activate('control')).rejects.toMatchObject({ code: 'P2-native-rendered-ui' });
    await expect(driver.keyToOwnedWindow('cmd+shift+a')).rejects.toMatchObject({ code: 'P2-native-rendered-ui' });
  });
});
