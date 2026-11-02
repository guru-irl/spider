import { describe, expect, it } from 'vitest';
import { validateAppCommand, parseAppReply, parseAppEnvelope, createNativeAppDriver, appObject } from '../app.js';
import { createFakeAppDriver } from '../fake-app.js';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counterInput } from '../../fixtures/panel-inputs.js';
import { prepareInstallInputs } from '../../fixtures/install-inputs.js';
import { cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import { writeFileSync } from 'node:fs';

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
  it('writes the exact selected layout name to the owned settings after loading the layout', async () => {
    const original = await createSuite({ tier: 'headless', story: storyId('H-layout-selection') });
    try {
      const { suite, app, config } = await prepareInstallInputs(original), path = suite.ownPath(join(config.app.home, 'settings.json'));
      await cp(join(config.app.home, 'layouts/main.json'), suite.ownPath(join(config.app.home, 'layouts/spider-glass.json')));
      await writeFile(path, '{"layout":"main","theme":"fixture-theme","retained":17}\n', { mode: 0o600 });
      await app.command('layout.switch', { name: 'spider-glass' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ layout: 'spider-glass', theme: 'fixture-theme', retained: 17 });
      expect(await app.status()).toMatchObject({ layout: 'spider-glass' });
      const bytes = await readFile(path, 'utf8'); await app.command('layout.switch', { name: 'spider-glass' }); expect(await readFile(path, 'utf8')).toBe(bytes);
      await expect(app.command('layout.switch', { name: 'unavailable-layout' })).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe(bytes);
      await suite.evidence('native-layout-selection.json', { settings: JSON.parse(bytes), status: await app.status(), source: 'window.rs:878-923,933-967; load_layout publishes the selected name after loading, including same-name selections' });
      await writeFile(path, '[]', { mode: 0o600 }); await expect(app.command('layout.switch', { name: 'main' })).rejects.toThrow(/malformed owned app settings/); expect(await readFile(path, 'utf8')).toBe('[]');
      await writeFile(path, bytes, { mode: 0o600 }); const target = suite.ownPath(join(suite.root, 'guard-target')); await writeFile(target, 'untouched', { mode: 0o600 }); await symlink(target, suite.ownPath(`${path}.new`));
      await expect(app.command('layout.switch', { name: 'main' })).rejects.toThrow(/symlink app path/); expect(await readFile(target, 'utf8')).toBe('untouched'); expect(await readFile(path, 'utf8')).toBe(bytes);
      await suite.evidence('layout-selection-faults.json', { malformedSettingsRetained: '[]', stagingSymlinkTarget: await readFile(target, 'utf8'), settings: JSON.parse(await readFile(path, 'utf8')) });
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
    ['layout.switch', { name: 'spider-glass' }], ['layout.show', { id: 'panel' }],
    ['layout.hide', { id: 'panel' }], ['layout.select', { stack: 'panel-body', child: 'spider' }],
    ['app.theme', { name: 'spider-glass' }],
  ])('accepts verified %s arguments', (name, args) => {
    expect(() => validateAppCommand(name, args)).not.toThrow();
    expect(() => validateAppCommand(name, { ...args, typo: 'wrong-target' })).toThrow(/unknown argument/);
  });
  it('refuses unsupported commands and wrong argument types before transport', () => {
    expect(() => validateAppCommand('terminal.send', { terminal: 't1' })).toThrow(/unknown command/);
    expect(() => validateAppCommand('terminal.park', {})).toThrow(/needs terminal/);
    expect(() => validateAppCommand('space.new', { argv: 'pi --session wrong' })).toThrow(/argv/);
    expect(() => validateAppCommand('tab.close', { id: 'tb1', confirmed: 'true' })).toThrow(/confirmed/);
    expect(() => validateAppCommand('pane.focus', { terminal: 't1', pane: 'p1' })).toThrow(/one target/);
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
    const driver = createNativeAppDriver({ binary: 'owned-app', env: { HERDR_APP_HOME: 'owned-home', TMPDIR: 'owned-tmp' }, ownPath: p => p,
      invoke: async (_binary, args) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'ls' ? { spaces: [], recent: [] } : { space: 'wrong-space', tab: 'wrong-tab', terminal: 'wrong-terminal' }) }) });
    await expect(driver.command('space.new', { argv: ['pi'] })).rejects.toThrow(/unobserved allocated IDs/);
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
