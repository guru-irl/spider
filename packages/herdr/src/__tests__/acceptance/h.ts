import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateRoleTemplates, resolveTemplateRolePolicy, TEMPLATE_ROLES, type ModelRegistryPort, type RoleTemplateOptions } from '../../templates/generate.js';
import { registerHerdrShortcuts } from '../../shortcuts/register.js';
import { buildSpiderBlock, SPIDER_BLOCK_BODY } from '../../../../superpowers/src/agentsmd-content.js';
import { expect } from 'vitest';
import type { HerdrHarness } from '../isolated.js';
import { CustomEditor, type KeybindingsManager as PiKeybindingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, TuiAltScreen, matchesKey, formatProgramStatus, type EditorTheme, type Terminal, type KeyId, type TUI } from '@earendil-works/pi-tui';
import type { HerdrViews, ViewName } from '../../contracts.js';
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as { KeybindingsManager: new () => PiKeybindingsManager };
const names: ViewName[] = ['agents', 'todos', 'usage', 'memory', 'triggers'];
export interface ShortcutFixture {
  pi: ExtensionAPI; views: HerdrViews; editor: CustomEditor; tui: TUI; keybindings: PiKeybindingsManager; ctx: ExtensionContext;
  registered: Map<KeyId, { handler(ctx: ExtensionContext): void | Promise<void> }>;
  opened: string[]; errors: string[];
  press(data: string): Promise<void>;
}
const shortcutRoots = new Set<string>();
function shortcutRoot(): string {
  const directory = resolve('.spider/scratch'); mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'shortcuts-')); shortcutRoots.add(root); return root;
}
export function cleanupShortcutFixtures(): void {
  for (const root of shortcutRoots) rmSync(root, { recursive: true, force: true });
  shortcutRoots.clear();
}
export function shortcutFixture(busy = false, mode: 'regular' | 'fullscreen' = 'regular', root: string = shortcutRoot()): ShortcutFixture {
  let input: ((data: string) => void) | undefined;
  const registered = new Map<KeyId, { handler(ctx: ExtensionContext): void | Promise<void> }>();
  const pi = { registerShortcut: (key: KeyId, handler: { handler(ctx: ExtensionContext): void | Promise<void> }) => registered.set(key, handler) } as unknown as ExtensionAPI;
  const terminal: Terminal = { columns: 80, rows: 24, kittyProtocolActive: true, start(onInput) { input = onInput; }, stop() { input = undefined; }, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const theme: EditorTheme = { borderColor: s => s, selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s } };
  const keybindings = new KeybindingsManager();
  const tui = mode === 'regular' ? new TuiMainScreen(terminal, false, root) : new TuiAltScreen(terminal, false, root);
  const editor = new CustomEditor(tui, theme, keybindings);
  editor.setText('draft 漢字'); editor.handleInput('\u0001');
  for (let i = 0; i < 6; i++) editor.handleInput('\u001b[C');
  const opened: string[] = []; const errors: string[] = []; const pending: Promise<unknown>[] = [];
  const forbidden = () => { throw new Error('editor mutation API called'); };
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => !busy, sessionManager: { getSessionId: () => 'owned-test-session' },
    ui: { notify: (message: string) => errors.push(message), setEditorText: forbidden, pasteToEditor: forbidden, setEditorComponent: forbidden },
  } as unknown as ExtensionContext;
  const views = Object.fromEntries(names.map(name => [name, async () => { opened.push(name); }])) as unknown as HerdrViews;
  editor.onExtensionShortcut = data => {
    for (const [key, handler] of registered) if (matchesKey(data, key)) { pending.push(Promise.resolve(handler.handler(ctx))); return true; }
    return false;
  };
  return { pi, views, editor, tui, keybindings, ctx, registered, opened, errors,
    async press(data: string) { if (input) input(data); else editor.handleInput(data); await Promise.all(pending.splice(0)); },
  };
}



export async function acceptanceGuidance(_h: HerdrHarness): Promise<void> {
  const block = buildSpiderBlock();
  expect(block).toContain('When `HC_TERMINAL_ID` is set');
  expect(block).toMatch(/never.*hc send.*pi/i);
  expect(SPIDER_BLOCK_BODY.length).toBeLessThanOrEqual(8500);
  expect(SPIDER_BLOCK_BODY.split('## Herdr terminals')[1].length + 18).toBeLessThanOrEqual(1000);
}
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function parseCommand(template: string): string[] {
  const line = template.split('\n').find(l => l.startsWith('command: '))!;
  const cmd = line.slice(9);
  return JSON.parse(execFileSync('/bin/sh', ['-c', `set -- ${cmd}; ${quote(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@"`], { encoding: 'utf8' }));
}
/** No user prompt or credential can reach this provider. A request is a test failure. */
export async function acceptanceRoles(h: HerdrHarness): Promise<void> {
  const models = ['local-worker', 'global-reviewer', 'light-watcher'].map(id => ({ provider: 'test-provider', id, reasoning: true, input: ['text'] }));
  const registry: ModelRegistryPort = { getAll: () => models, getAvailable: () => models, find: (p, id) => models.find(m => m.provider === p && m.id === id) };
  const policy = resolveTemplateRolePolicy({ global: { reviewer: 'test-provider/global-reviewer', worker: 'test-provider/local-worker' }, tierOverrides: { 'test-provider/global-reviewer': 'heavy', 'test-provider/light-watcher': 'light' } }, registry);
  const wrapper = join(h.root, "pi fixture's $(touch PWNED) `touch PWNED2` # comment \\ \"q\" ;x");
  const argvFile = join(h.root, 'startup-argv.json');
  const startupFile = join(h.root, 'startup-session.json');
  const providerCalls = join(h.root, 'provider-calls.txt');
  const piCli = fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  await writeFile(providerCalls, '');
  await mkdir(join(h.directories.agent, 'extensions'), { recursive: true });
  await writeFile(join(h.directories.agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never', packages: [], skills: [], prompts: [], themes: [], enableInstallTelemetry: false, cacheWarming: 'off' }));
  await writeFile(join(h.directories.agent, 'extensions', 'fixture.ts'), `
import { writeFileSync, appendFileSync } from 'node:fs';
export default function(pi) {
  pi.registerProvider('test-provider', { baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', api: 'herdr-test-api',
    models: ${JSON.stringify(models.map(m => ({ ...m, name: m.id, contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })))},
    streamSimple: () => { appendFileSync(${JSON.stringify(providerCalls)}, 'unexpected request\\n'); throw new Error('No prompt permitted in role launch acceptance'); },
  });
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(${JSON.stringify(startupFile)}, JSON.stringify({ mode: ctx.mode, model: ctx.model && ctx.model.provider + '/' + ctx.model.id,
      argv: process.argv.slice(2), environment: Object.fromEntries(['HC_SESSION','HC_TERMINAL_ID','HC_TERMINAL_SOCKET','XDG_CONFIG_HOME','XDG_STATE_HOME','PI_CODING_AGENT_DIR','SPIDER_GLOBAL_ROOT','TMPDIR'].map(key => [key, process.env[key]])),
      userMessages: ctx.sessionManager.getEntries().filter(e => e.type === 'message' && e.message.role === 'user') }));
    ctx.shutdown();
  });
}
`);
  await writeFile(wrapper, `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${quote(h.directories.agent)}\nexport SPIDER_GLOBAL_ROOT=${quote(h.directories.global)}\nexport TMPDIR=${quote(h.directories.tmp)}\n${quote(process.execPath)} -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${quote(argvFile)} "$@"\nexec ${quote(process.execPath)} ${quote(piCli)} "$@"\n`);
  await chmod(wrapper, 0o700);
  const options: RoleTemplateOptions = { piExecutable: wrapper, instructionPaths: { worker: join(h.directories.agent, 'worker.md'), reviewer: join(h.directories.agent, 'reviewer.md'), watcher: join(h.directories.agent, 'watcher.md') } };
  const templates = generateRoleTemplates(policy, registry, options);
  const templateDirectory = join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core', 'templates');
  await mkdir(templateDirectory, { recursive: true });
  for (const role of TEMPLATE_ROLES) {
    await writeFile(options.instructionPaths[role], templates.instructions[role]);
    await writeFile(join(templateDirectory, `spider-${role}.md`), templates[role]);
    expect(templates[role].split(/^---\s*$/m).slice(2).join('').trim()).toBe('');
  }
  const wantedArgv = [wrapper, '--model', 'test-provider/local-worker', '--thinking', 'high', '--append-system-prompt', options.instructionPaths.worker];
  expect(parseCommand(templates.worker)).toEqual(wantedArgv);
  const runArgs = ['run', '--bg', '--no-notify', '--no-parent', '--outlive-parent', '--cwd', h.root, '--json'];
  // The shared fake has no template interpreter; execute its independently decoded command.
  const reply = await h.cli([...runArgs, ...(h.mode === 'fake' ? ['--', ...wantedArgv] : ['spider-worker'])]) as { address: string; first_message?: unknown; argv?: string[] };
  expect(reply.first_message ?? null).toBeNull();
  try {
    await expect.poll(async () => readFile(startupFile, 'utf8').then(JSON.parse).catch(() => null), { timeout: 10000 }).toMatchObject({ mode: h.mode === 'fake' ? 'print' : 'tui', model: 'test-provider/local-worker', userMessages: [] });
  } catch (error) {
    await writeFile(join(h.root, 'role-launch-failure.json'), JSON.stringify({ reply, terminal: await h.cli(['get', reply.address, '--json']), screen: await h.cli(['read', reply.address, '--json', '--lines', '100']), wrapperArgv: await readFile(argvFile, 'utf8').catch(() => null) }, null, 2));
    throw error;
  }
  const startup = JSON.parse(await readFile(startupFile, 'utf8'));
  expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual(wantedArgv.slice(1));
  expect(startup.argv).toEqual(wantedArgv.slice(1));
  await expect(readFile(join(h.root, 'PWNED'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(h.root, 'PWNED2'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(startup.environment).toMatchObject({ HC_SESSION: h.localEnv.HC_SESSION, HC_TERMINAL_ID: reply.address, XDG_CONFIG_HOME: h.localEnv.XDG_CONFIG_HOME, XDG_STATE_HOME: h.localEnv.XDG_STATE_HOME, PI_CODING_AGENT_DIR: h.directories.agent, SPIDER_GLOBAL_ROOT: h.directories.global, TMPDIR: h.directories.tmp });
  expect(await readFile(providerCalls, 'utf8')).toBe('');
  if (h.mode !== 'fake') {
    // Deliberately non-pi receiver: show the native forbidden first-message path safely.
    const receiver = join(h.root, 'negative.mjs');
    await writeFile(receiver, `process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdout.write(${JSON.stringify(formatProgramStatus({ state: 'idle', app: 'fixture' }))}); process.stdin.on('data',()=>{}); setTimeout(()=>process.exit(0), 10000);`);
    const negative = templates.worker.replace('name: spider-worker', 'name: spider-negative').replace(/^command: .*$/m, 'command: ' + [process.execPath, receiver].map(quote).join(' ')) + '\nnegative control body\n';
    await writeFile(join(templateDirectory, 'spider-negative.md'), negative);
    const control = await h.cli([...runArgs, 'spider-negative']) as { address: string; first_message?: { sent?: boolean } };
    await writeFile(join(h.root, 'role-native-proof.json'), JSON.stringify({ mode: h.mode, positive: reply, negative: control, startup, negativeScreen: await h.cli(['read', control.address, '--json', '--lines', '100']) }, null, 2));
    expect(control.first_message?.sent).toBe(true);
  }
  if (h.mode === 'fake') expect((await h.calls()).filter(c => c.argv[0] === 'run').every(c => c.argv.includes('--no-notify'))).toBe(true);
  expect(h.mutations().some(command => /(?:^|:)send\b/.test(command))).toBe(false);
  await writeFile(join(h.root, 'role-proof-' + h.mode + '.json'), JSON.stringify({ mode: h.mode, positive: reply, startup, providerRequests: 0 }, null, 2));
}
export async function acceptanceShortcuts(h: HerdrHarness): Promise<void> {
  const patch = JSON.parse(await readFile(new URL('../../../assets/keys.json', import.meta.url), 'utf8'));
  for (const busy of [false, true]) {
    const fixture = shortcutFixture(busy, 'regular', h.root);
    const registration = registerHerdrShortcuts(fixture.pi, fixture.views);
    try {
      for (const key of ['cmd-shift-a', 'cmd-shift-o', 'cmd-shift-u', 'cmd-shift-m', 'cmd-shift-k']) {
        expect(patch.terminal[key]).toMatch(/^send:\u001b\[\d+;6u$/);
        await fixture.press(patch.terminal[key].slice(5));
      }
      expect(fixture.opened).toEqual(['agents', 'todos', 'usage', 'memory', 'triggers']);
      expect(fixture.editor.getText()).toBe('draft 漢字');
      expect(fixture.editor.getCursor()).toEqual({ line: 0, col: 6 });
    } finally { await registration.dispose(); }
  }
}
export async function acceptanceH(h: HerdrHarness): Promise<void> {
  await acceptanceGuidance(h); await acceptanceRoles(h); await acceptanceShortcuts(h);
}
