import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '@spider/db-core';
import { globalConfigFixture, type GlobalConfigFixture } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';

let root: string, globalRoot: string, session: string;
let globalConfig: GlobalConfigFixture;
let mount: HerdrMount | undefined;
const previousRoot = paths.globalRoot;
const hooks = new Map<string, Function[]>();
const notices: { message: string; level: string }[] = [], footers: unknown[] = [], stderr: string[] = [];
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch'), { recursive: true }); root = await mkdtemp(resolve('.spider/scratch/off-notice-'));
  execFileSync('git', ['init', '-q', root]); await mkdir(join(root, '.spider'));
  globalRoot = join(root, 'global'); await mkdir(join(globalRoot, 'herdr'), { recursive: true });
  globalConfig = globalConfigFixture(globalRoot);
  paths.globalRoot = globalRoot;
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_SUBAGENT_CHILD', '0'); vi.stubEnv('HC_TERMINAL_ID', undefined);
  vi.stubEnv('HC_SESSION', 'off'); vi.stubEnv('HC_SOCKET', join(root, 'core.sock')); vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config')); vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
  hooks.clear(); notices.length = 0; footers.length = 0; stderr.length = 0; session = 'first';
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
});
afterEach(async () => { await mount?.dispose(); mount = undefined; globalConfig.restore(); paths.globalRoot = previousRoot; vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function context(hasUI = true) {
  const manager = { getSessionId: () => session, getSessionFile: () => null };
  return { cwd: root, mode: hasUI ? 'tui' : 'print', hasUI, sessionManager: manager,
    ui: { setStatus: (_key: string, text: unknown) => footers.push(text), notify: (message: string, level: string) => notices.push({ message, level }) } };
}
function mounted() {
  mount = mountHerdr({ on: (name: string, handler: Function) => { const handlers = hooks.get(name) ?? []; handlers.push(handler); hooks.set(name, handlers); return () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); }; }, registerCommand() {}, registerTool() {}, getSessionName: () => null } as never,
    { packageRoot: root, actionContext: () => ({}), views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } } });
  return mount;
}
async function start(ctx: ReturnType<typeof context>) { for (const handler of [...hooks.get('session_start') ?? []]) await handler({}, ctx); }
async function settings(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) globalConfig.set(key, value); }
async function configured() {
  await writeFile(join(globalRoot, 'herdr/config.json'), JSON.stringify({ globalRoot, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'), core: { binary: join(root, 'hc'), config: join(root, 'core.toml') }, app: { binary: join(root, 'app-cli'), home: join(root, 'app') }, spaces: [], machines: [] }));
}
function noPersistentOffFooter() { expect(footers.filter(text => typeof text === 'string' && text.includes('Herdr off'))).toEqual([]); }

test.each([[true, undefined], [false, undefined], [true, 'auto'], [false, 'auto']] as const)('optional mode %s/%s is silent until this session plausibly expects Herdr', async (hasUI, enabled) => {
  if (enabled) await settings({ 'herdr.enabled': enabled });
  const ctx = context(hasUI), m = mounted(); await start(ctx);
  expect(notices).toEqual([]); expect(stderr).toEqual([]); noPersistentOffFooter(); expect(m.enabled()).toBe(false);
  expect(await m.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
  vi.stubEnv('HC_TERMINAL_ID', 'fixture-terminal'); await start(ctx); await start({ ...ctx });
  if (hasUI) expect(notices).toEqual([{ message: expect.stringContaining('no Herdr configuration'), level: 'warning' }]);
  else expect(stderr).toEqual([expect.stringContaining('no Herdr configuration')]);
  noPersistentOffFooter();
});

test('a configured auto session gets one notice rather than an off footer, including its next session', async () => {
  await configured();
  const ctx = context(); mounted(); await start(ctx); await start({ ...ctx });
  expect(notices).toEqual([{ message: expect.stringContaining('not inside Herdr'), level: 'warning' }]); noPersistentOffFooter();
  session = 'second'; await start(ctx); expect(notices).toHaveLength(2); noPersistentOffFooter();
});

test.each(['auto', true] as const)('a dead isolated core reports mode %s once per session', async enabled => {
  await configured(); await settings({ 'herdr.enabled': enabled }); vi.stubEnv('HC_TERMINAL_ID', 'fixture-terminal');
  expect(process.env.HC_SOCKET!.length).toBeLessThan(104);
  const ctx = context(); mounted(); await start(ctx); await start({ ...ctx });
  expect(notices).toEqual([{ message: expect.stringContaining('Herdr core is not running'), level: enabled === true ? 'error' : 'warning' }]);
  session = 'second'; await start(ctx); expect(notices).toHaveLength(2); noPersistentOffFooter();
});

test('explicit true that cannot activate reports one error without a persistent footer', async () => {
  await settings({ 'herdr.enabled': true });
  const ctx = context(); mounted(); await start(ctx); await start({ ...ctx });
  expect(notices).toEqual([{ message: expect.stringContaining('no Herdr configuration'), level: 'error' }]); noPersistentOffFooter();
});

test('a malformed existing config gives one activation notice rather than repeated boundary errors', async () => {
  await writeFile(join(globalRoot, 'herdr/config.json'), '{broken');
  const ctx = context(); mounted(); await start(ctx); await start({ ...ctx });
  expect(notices).toHaveLength(1); expect(notices[0].message).toContain('Herdr'); noPersistentOffFooter();
});

test('an absent configured path outside Herdr remains silent in auto mode', async () => {
  await settings({ 'herdr.config': './missing.json' });
  const ctx = context(); mounted(); await start(ctx); await start({ ...ctx });
  expect(notices).toEqual([]); expect(stderr).toEqual([]); noPersistentOffFooter();
});
