import { runPanelScene } from './acceptance/i.js';
// SPDX-License-Identifier: MIT
/// <reference types="vite/client" />
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readdir, readFile, writeFile, stat, chmod, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { openDbAt, paths } from '@spider/db-core';
import { RunStore } from '../../../subagents/src/run-store.js';
import { parseFeed } from '../../assets/shared/feed.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { HERDR_LABELS, HERDR_KINDS, type RunId, type SessionFeed } from '../contracts.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHerdrHarness, type HerdrHarness, type AcceptanceScenario, type OwnedResource } from './testutil.js';
import type { MachineName, AcceptanceMode } from '../contracts.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, type SetupParts, type SetupRequest, type InstallFile, type SetupContext, type RuntimeFile } from '../setup/installer.js';
import type { HerdrCliPorts } from '../setup/cli.js';
import type { HerdrConfig } from '../contracts.js';
import { readJournal } from '../setup/backup.js';
import { preflightSpaces } from '../spaces/setup.js';
import { prepareFonts } from '../look/fonts.js';
import { buildResumeBlock } from '../sessions/resume.js';
import { generateRoleTemplates, resolveTemplateRolePolicy, TEMPLATE_ROLES } from '../templates/generate.js';
import { acceptanceG } from './acceptance/g.js';
import { acceptanceH } from './acceptance/h.js';
import { scenarioStatus } from './scenario-status.js';
import { scenarioJobs } from './scenario-jobs.js';
import { scenarioRemote } from './scenario-remote.js';
import { scenarioSsh } from './scenario-ssh.js';
import { scenarioViewers } from './scenario-viewers.js';
import { scenarioSpiderPanel } from './scenario-panels.js';
import { scenarioLook } from './scenario-look.js';

export interface SetupFacts {
  secondSetup: { writes: number; launches: number };
  piTerminalTextWrites: readonly { argv: string[] }[];
  duplicateSessionWriters: readonly { file: string; pids: number[] }[];
  remainingOwnedResources: readonly OwnedResource[];
}
const completeScenarios: readonly AcceptanceScenario[] = [
  scenarioStatus, scenarioJobs, scenarioRemote, scenarioSsh, scenarioViewers,
  acceptanceG, acceptanceH, scenarioSpiderPanel, scenarioLook,
];
export async function createAcceptanceHarness(mode: AcceptanceMode): Promise<HerdrHarness> {
  if (mode === 'fake') {
    const h = await createHerdrHarness(mode);
    const log = join(h.root, 'acceptance-calls.jsonl'); await writeFile(log, '');
    const logger = join(h.root, 'record-acceptance.mjs');
    await writeFile(logger, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), env: { HC_SESSION: process.env.HC_SESSION, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET, HERDR_ACCEPTANCE_CLIENT: process.env.HERDR_ACCEPTANCE_CLIENT } })+'\\n');\n`);
    const original = await readFile(h.hcBinary, 'utf8');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(h.hcBinary, `#!/bin/sh\n${quote(process.execPath)} ${quote(logger)} ${quote(log)} "$@" || exit $?\n` + original.replace(/^#![^\n]*\n/, ''));
    h.calls = async (side = 'local') => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; env: NodeJS.ProcessEnv }).filter(call => call.env.HC_SESSION === (side === 'local' ? 'l' : 'r'));
    return h;
  }
  const recording = resolve('.spider/scratch/acceptance', `argv-${randomUUID()}`); await mkdir(recording, { recursive: true });
  const log = join(recording, 'calls.jsonl'); await writeFile(log, '');
  const logger = join(recording, 'record.mjs');
  await writeFile(logger, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), env: { HC_SESSION: process.env.HC_SESSION, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET, HERDR_ACCEPTANCE_CLIENT: process.env.HERDR_ACCEPTANCE_CLIENT } })+'\\n');\n`);
  const binary = join(recording, 'hc');
  const previous = process.env.SPIDER_HERDR_HC_BINARY;
  const real = previous ?? join(homedir(), '.local/bin/hc');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(binary, `#!/bin/sh\n${quote(process.execPath)} ${quote(logger)} ${quote(log)} "$@" || exit $?\nexec ${quote(real)} "$@"\n`); await chmod(binary, 0o700);
  process.env.SPIDER_HERDR_HC_BINARY = binary;
  let h: HerdrHarness;
  try { h = await createHerdrHarness(mode); }
  catch (error) { await rm(recording, { recursive: true, force: true }); throw error; }
  finally { if (previous === undefined) delete process.env.SPIDER_HERDR_HC_BINARY; else process.env.SPIDER_HERDR_HC_BINARY = previous; }
  const close = h.close.bind(h);
  h.calls = async (side = 'local') => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { argv: string[]; env: NodeJS.ProcessEnv }).filter(c => c.env.HC_SESSION === (side === 'local' ? 'l' : 'r'));
  h.close = async () => { await close(); await rm(recording, { recursive: true, force: true }); };
  return h;
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const assets = fileURLToPath(new URL('../../assets/', import.meta.url));


export function assertNoNativeNotes(calls: readonly { argv: readonly string[] }[]): void {
  const runs = calls.filter(call => call.argv[0] === 'run');
  assert(runs.length > 0, 'Acceptance must observe at least one actual hc run');
  for (const call of runs) assert(call.argv.includes('--no-notify'), `Native notes were not disabled: ${JSON.stringify(call.argv)}`);
}

export function observeSecondSetup(localWrites: number, calls: readonly { argv: readonly string[] }[]): SetupFacts['secondSetup'] {
  return { writes: localWrites + calls.filter(c => c.argv[0] === 'file' && c.argv[1] === 'write').length,
    launches: calls.filter(c => c.argv[0] === 'run').length };
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...(await filesBelow(join(root, entry.name))).map(p => join(entry.name, p)));
    else if (entry.isFile() && !entry.name.endsWith('.d.ts')) result.push(entry.name);
  }
  return result.sort();
}

async function waitFor<T>(observe: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 10000;
  do { const value = await observe(); if (value !== null) return value; await delay(20); } while (Date.now() < deadline);
  throw new Error(description);
}

/** L1's transaction against isolated external ports. Feature claims remain in B through K. */
export async function acceptanceSetup(h: HerdrHarness, runtimeSetup?: { machines: HerdrConfig['machines']; parts: Pick<SetupParts, 'ensureRuntime' | 'bootstrapRuntime'> }): Promise<Omit<SetupFacts, 'remainingOwnedResources'>> {
  assert(h.owner && h.localCoreId && h.remoteCoreId);
  assert.notEqual(h.localCoreId, h.remoteCoreId, 'Local and fake-remote cores must be independent');
  const root = join(h.root, 'complete-setup'); await mkdir(root);
  const packageRoot = join(root, 'package'); await mkdir(packageRoot);
  const settings = join(h.directories.agent, 'settings.json');
  const notes = join(root, 'core.toml');
  const session = join(root, 'selected.jsonl');
  const writerScript = join(root, 'writer.mjs');
  const writerReceipt = join(root, 'writer.json');
  await writeFile(settings, '{"theme":"stock","unrelated":"keep"}\n');
  await writeFile(notes, 'notes = true\nzoom = 2\n[other]\nnotes = true\n');
  await writeFile(session, JSON.stringify({ type: 'session', id: 'acceptance-session', cwd: root }) + '\n');
  const sessionBefore = await readFile(session);
  await writeFile(writerScript, `import { openSync, writeFileSync, readFileSync } from 'node:fs';
const file=process.argv[2]; const fd=openSync(file+'.writer','wx');
const header=JSON.parse(readFileSync(file,'utf8').split('\\n')[0]);
writeFileSync(process.argv[3],JSON.stringify({pid:process.pid,file,cwd:process.cwd(),sessionId:header.id}));
setInterval(()=>{},1000);
`);
  const request: SetupRequest = {
    config: parseHerdrConfig({ app: { binary: h.appBinary, home: h.directories.app },
      core: { binary: h.hcBinary, config: notes }, agentDirectory: h.directories.agent,
      globalRoot: h.directories.global, shellRc: join(root, 'shellrc'), spaces: [],
      machines: runtimeSetup?.machines ?? [{ name: 'remote.invalid', nodePath: h.nodeBinary, runtime: { directory: h.directories.remote, cwd: null, commands: {} } }],
    }), configPath: join(root, 'config.json'), packageRoot, journalRoot: join(root, 'journal'),
  };
  await writeFile(request.configPath, JSON.stringify(request.config));
  const preparedFonts = await prepareFonts({}, { bundledRoot: join(assets, 'fonts'), readFile });
  const expected = new Map<string, Buffer>();
  const install = (path: string, bytes: Buffer, context: SetupContext): InstallFile => {
    expected.set(path, bytes);
    return { path, bytes, expected: context.installed[path] ?? null };
  };
  const copies = ['spider', 'machines', 'agents', 'spaces', 'pane'];
  const models = [{ provider: 'fixture', id: 'role', reasoning: true, input: ['text'] }];
  const registry = { getAll: () => models, getAvailable: () => models, find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id) };
  const policy = resolveTemplateRolePolicy({ global: { worker: 'fixture/role', reviewer: 'fixture/role', watcher: 'fixture/role' }, local: {} }, registry);
  const templates = generateRoleTemplates(policy, registry, { piExecutable: h.nodeBinary,
    instructionPaths: Object.fromEntries(TEMPLATE_ROLES.map(role => [role, join(root, `${role}.md`)])) as Record<typeof TEMPLATE_ROLES[number], string> });
  const runtimePath = join(h.directories.remote, 'acceptance-runtime.mjs');
  const runtime = Buffer.from(stripTypeScriptTypes(await readFile(new URL('../remote/runtime.ts', import.meta.url), 'utf8')));
  let installedRuntimes: readonly RuntimeFile[] = [{ machine: 'remote.invalid' as MachineName, path: runtimePath, bytes: runtime, sha256: hash(runtime) }];
  const parts: SetupParts = {
    preflight: async () => {
      await preflightSpaces(request.config, { journalRoot: join(root, 'spaces'), layoutSnapshot: async () => ({ spaces: [] }) });
      return { fingerprint: hash(Buffer.concat([runtime, ...preparedFonts.files.map(f => f.bytes)])),
        coreIdentity: h.owner!.terminal, mods: copies.map(name => ({ directory: join(h.directories.app, 'mods', `test-${name}`) })),
        targets: request.config.machines.map(machine => ({ machine: machine.name, nodePath: machine.nodePath ?? 'node', coreStartedAt: h.remoteCoreId! })),
        retiredTerminals: [h.owner!.terminal.address], layoutExport: true };
    },
    stageLook: async (_request, context) => {
      const files = preparedFonts.files.map(font => install(join(h.directories.app, 'fonts', font.fileName), font.bytes, context));
      for (const name of await filesBelow(join(assets, 'themes'))) files.push(install(join(h.directories.agent, 'themes', name), await readFile(join(assets, 'themes', name)), context));
      return files;
    },
    installFiles: async (_request, context) => {
      const files: InstallFile[] = [];
      for (const copy of context.modProps) {
        files.push(install(join(copy.directory, 'props.json'), Buffer.from(JSON.stringify(copy.props)), context));
        for (const name of await filesBelow(join(assets, 'shared'))) files.push(install(join(copy.directory, 'shared', name), await readFile(join(assets, 'shared', name)), context));
      }
      for (const name of ['spider']) for (const file of await filesBelow(join(assets, 'mods', name))) {
        const source = await readFile(join(assets, 'mods', name, file));
        const bytes = file === 'mod.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(source.toString()), name: `test-${name}` })) : source;
        files.push(install(join(h.directories.app, 'mods', `test-${name}`, file), bytes, context));
      }
      return files;
    },
    generateTemplates: async (_request, context) => TEMPLATE_ROLES.flatMap(role => [
      install(join(root, `${role}.md`), Buffer.from(templates.instructions[role]), context),
      install(join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core', 'templates', `test-${role}.md`), Buffer.from(templates[role]), context),
    ]),
    installResume: async (_request, context) => [install(request.config.shellRc, Buffer.from(buildResumeBlock({ nodePath: h.nodeBinary,
      cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath, hookPath: join(assets, 'shell/resume.sh') })), context)],
    probeMachineNode: async (_target, launch) => {
      const terminal = await h.hc.run(launch);
      try {
        await waitFor(async () => (await h.hc.get(terminal.address)).state === 'finished' ? true : null, 'Visible Node probe did not finish');
        const screen = await h.hc.read(terminal.address, { lines: 20 });
        const version = /\bv\d+\.\d+\.\d+\b/.exec(screen)?.[0]; assert(version, 'Visible destination Node probe must expose its version');
        return version;
      } finally { await h.hc.kill(terminal.address).catch(() => {}); await h.hc.rm(terminal.address); }
    },
    ensureRuntime: async (request, context) => { if (runtimeSetup) installedRuntimes = await runtimeSetup.parts.ensureRuntime(request, context); return installedRuntimes; },
    bootstrapRuntime: async (request, context) => {
      if (runtimeSetup) {
        await runtimeSetup.parts.bootstrapRuntime(request, context);
      } else { await h.hc.fileRead('remote.invalid' as MachineName, runtimePath); }
    }, hc: h.hc,
    cutover: async (_request, context) => {
      if (context.priorCutover) {
        for (const address of context.priorCutover.terminals) assert.equal((await h.hc.get(address)).state, 'live');
        return context.priorCutover;
      }
      const terminal = await h.hc.run({ argv: [h.nodeBinary, writerScript, session, writerReceipt], cwd: root,
        labels: {}, background: true, outliveParent: true, noNotify: true });
      await waitFor(async () => readFile(writerReceipt, 'utf8').then(JSON.parse).catch(() => null), 'Selected session writer did not publish its real process identity');
      return { terminals: [terminal.address], identities: { session: 'acceptance-session' } };
    },
    verify: async () => {
      for (const [path, bytes] of expected) assert.deepEqual(await readFile(path), bytes, `Installed bytes differ: ${path}`);
      for (const installed of installedRuntimes) assert.deepEqual(await h.hc.fileRead(installed.machine, installed.path), installed.bytes);
      assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { theme: 'dracula-plus-glass', unrelated: 'keep' });
      assert.match(await readFile(notes, 'utf8'), /^notes = false/m);
      assert.deepEqual(await readFile(session), sessionBefore, 'Setup must not mutate selected session text');
      const journal = await readJournal(request.journalRoot);
      for (const entry of journal.entries) assert.equal(hash(await readFile(entry.path)), entry.after);
      return { failures: [], warnings: [], probes: [] };
    },
    rollback: async result => { for (const address of result.terminals) { await h.hc.kill(address); await h.hc.rm(address); } }, warn() {},
  };
  const first = await setupHerdr(request, parts);
  assert(first.writes.length > 0, 'First setup must install real artifact files');
  assert(first.cutover?.terminals.length === 1, 'First setup must create exactly one selected writer');
  const journalBefore = await readFile(join(request.journalRoot, 'journal.json'));
  const baseline = await Promise.all(first.writes.map(async path => ({ path, bytes: await readFile(path), modified: (await stat(path)).mtimeMs })));
  const before = await h.calls(); const remoteBefore = await h.calls('remote');
  const second = await setupHerdr(request, parts);
  const after = await h.calls(); const remoteAfter = await h.calls('remote');
  assert.deepEqual(await readFile(join(request.journalRoot, 'journal.json')), journalBefore, 'Second setup must not rewrite the transaction journal');
  for (const file of baseline) { assert.deepEqual(await readFile(file.path), file.bytes); assert.equal((await stat(file.path)).mtimeMs, file.modified, 'Second setup must not rewrite identical bytes'); }
  const receipt = JSON.parse(await readFile(writerReceipt, 'utf8')) as { pid: number; file: string; cwd: string; sessionId: string };
  assert.equal(receipt.file, session); assert.equal(receipt.cwd, root); assert.equal(receipt.sessionId, 'acceptance-session');
  process.kill(receipt.pid, 0);
  const writers = execFileSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes(writerScript)).flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s/.exec(line);
      return match && !match[2].startsWith('Z') ? [Number(match[1])] : [];
    });
  assert(writers.includes(receipt.pid), 'The actual selected writer must remain live after the rerun');
  assertNoNativeNotes(after);
  const secondCalls = [...after.slice(before.length), ...remoteAfter.slice(remoteBefore.length)];
  return { secondSetup: observeSecondSetup(second.writes.length, secondCalls),
    piTerminalTextWrites: after.filter(c => c.argv[0] === 'send'),
    duplicateSessionWriters: writers.length > 1 ? [{ file: session, pids: writers }] : [], };
}

export const scenarioSetup: AcceptanceScenario = async h => { await acceptanceSetup(h); };

/** One production host in one proved harness. Missing wiring is an assertion, never a fixture fallback. */
export const scenarioShared: AcceptanceScenario = async h => {
  assert(h.owner, 'Shared scenario requires a proved owner');
  const mountPath = fileURLToPath(new URL('../../../host/src/herdr/mount.ts', import.meta.url));
  assert(await access(mountPath).then(() => true, () => false), 'Shared production mountHerdr must be assembled before acceptance');
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const entry of ['cli.mjs', 'viewer.mjs', 'viewer-pi.mjs', 'feed-reader.mjs', 'remote-runtime.mjs', 'subagent-supervisor.mjs']) {
    assert(await access(join(packageRoot, 'dist/herdr', entry)).then(() => true, () => false), `Shared acceptance requires packaged dist/herdr/${entry}`);
  }
  const hostModules = import.meta.glob('../../../host/src/herdr/mount.ts');
  const loadHost = hostModules['../../../host/src/herdr/mount.ts'];
  assert(loadHost, 'Shared acceptance must load the assembled production host module');
  const { mountHerdr } = await loadHost() as { mountHerdr: (...args: unknown[]) => unknown };
  assert.equal(typeof mountHerdr, 'function', 'Shared production mountHerdr must be callable');
  const diagnosticRoot = resolve('.spider/scratch/acceptance'); await mkdir(diagnosticRoot, { recursive: true });
  const saved = { ...process.env };
  const errors: unknown[] = []; const messages: unknown[] = [];
  const callbacks = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
    const handlers = callbacks.get(name) ?? []; handlers.push(handler); callbacks.set(name, handlers);
    return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1); };
  }, registerTool() {}, registerShortcut() {}, registerCommand() {}, sendMessage(message: unknown) { messages.push(message); }, getSessionName: () => 'acceptance-owner' } as unknown as ExtensionAPI;
  const fire = async (name: string, event: unknown, ctx: ExtensionContext) => { for (const handler of [...callbacks.get(name) ?? []]) await handler(event, ctx); };
  const dbPath = join(h.root, 'shared.db');
  const db = openDbAt(dbPath, 'worktree'); const store = new RunStore(db);
  const runId = store.create({ sessionId: h.owner.sessionId, agent: 'worker' }).id as RunId;
  store.start(runId); store.setLaunch(runId, { childMode: 'print' });
  execFileSync('git', ['init', '-q', h.root]);
  const repoTranscriptRoots = [join(paths.scratch('repo', h.root), 'subagent-sessions')];
  const repoTranscriptsBefore = await Promise.all(repoTranscriptRoots.map(root => filesBelow(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })));
  // Match the subagent launcher's worktree-local transcript location.
  const transcript = join(paths.scratch('project', h.root), 'subagent-sessions', runId, `${runId}.jsonl`);
  await mkdir(join(transcript, '..'), { recursive: true });
  await writeFile(transcript, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Shared viewer text' }] } }) + '\n');
  const terminal = Object.create(ProcessTerminal.prototype) as ProcessTerminal;
  Reflect.set(terminal, 'programStatusSupported', false);
  const piRoot = fileURLToPath(new URL('.', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { ProgramStatusReporter } = await import(/* @vite-ignore */ pathToFileURL(join(piRoot, 'modes/interactive/program-status-reporter.js')).href);
  const reporter = new ProgramStatusReporter(() => terminal, () => 'fixture'); reporter.reset();
  const ctx = { mode: 'tui', hasUI: true, cwd: h.root, isIdle: () => true,
    sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => null, getBranch: () => [] },
    ui: { notify(message: unknown) { errors.push(message); }, setWidget(_name: string, factory: unknown) {
      if (typeof factory === 'function') factory({ terminal });
    }, setEditorText() { assert.fail('Shared features must not change editor input'); }, pasteToEditor() { assert.fail('Shared features must not paste input'); } },
  } as unknown as ExtensionContext;
  let sharedAppBinary = h.appBinary;
  if (h.mode !== 'app') {
    // Native app commands have one server-side writer. Serialize the test CLI's JSON store too.
    sharedAppBinary = join(h.root, 'shared-app');
    const driver = join(h.root, 'shared-app.mjs');
    if (h.mode === 'hc') {
      await writeFile(join(h.directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 'shared-space', name: 'Fixture', tabs: [{ id: 'shared-tab', name: 'Owner', terminals: [{ terminal: h.owner.terminal.address, pane: 'shared-pane' }] }] }] }));
      await writeFile(join(h.directories.local, 'app-calls.jsonl'), '');
      const coreEntry = join(h.root, 'shared-core.ts');
      await writeFile(coreEntry, `export { invokeCli } from ${JSON.stringify(fileURLToPath(new URL('../client/hc.ts', import.meta.url)))};\n`);
      const { build } = await import('vite');
      await build({ configFile: false, logLevel: 'silent', build: { ssr: coreEntry, outDir: h.root, emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: 'shared-core.mjs' } } } });
      const coreCli = join(h.root, 'shared-hc.mjs');
      await writeFile(coreCli, `import { invokeCli } from './shared-core.mjs';
try { console.log(JSON.stringify(await invokeCli(${JSON.stringify(h.hcBinary)}, process.argv.slice(2), process.env))); }
catch (error) { console.error(JSON.stringify({ error: { kind: error.code ?? 'cli-error', message: error.message } })); process.exitCode=1; }
`);
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(join(h.root, 'hc'), `#!/bin/sh\nexec ${quote(h.nodeBinary)} ${quote(coreCli)} "$@"\n`); await chmod(join(h.root, 'hc'), 0o700);
    }
    await writeFile(driver, `import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root=${JSON.stringify(h.directories.local)}, lock=root+'/app-command.lock';
const deadline=Date.now()+10000;
while (true) { try { await mkdir(lock); break; } catch (error) { if (error.code!=='EEXIST'||Date.now()>deadline) throw error; await delay(10); } }
try {
  const env={...process.env, HERDR_FAKE_ROOT:root, HERDR_TEST_ROOT:${JSON.stringify(h.root)}};
  if (${JSON.stringify(h.mode === 'hc')}) {
    const { invokeCli } = await import('./shared-core.mjs');
    const core=await invokeCli(${JSON.stringify(h.hcBinary)},['ls','--all','--json'],env);
    core.terminals=await Promise.all(core.terminals.map(terminal=>invokeCli(${JSON.stringify(h.hcBinary)},['get',terminal.address,'--json'],env)));
    await writeFile(root+'/core.json.new',JSON.stringify(core)); await rename(root+'/core.json.new',root+'/core.json');
  }
  const result=spawnSync(${JSON.stringify(h.nodeBinary)},[${JSON.stringify(fileURLToPath(new URL('./fake-app.mjs', import.meta.url)))},...process.argv.slice(2)],{env,maxBuffer:8*1024*1024,timeout:10000});
  const fs = await import('node:fs/promises'); await fs.appendFile(root+'/ack-core.jsonl', JSON.stringify({ argv: process.argv.slice(2), core: JSON.parse(await fs.readFile(root+'/core.json','utf8')) })+'\\n');
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode=result.status??1;
} finally { await rm(lock,{recursive:true,force:true}); }
`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(sharedAppBinary, `#!/bin/sh\nexec ${quote(h.nodeBinary)} ${quote(driver)} "$@"\n`);
    await chmod(sharedAppBinary, 0o700);
  }
  const config = parseHerdrConfig({ enabled: true, app: { binary: sharedAppBinary, home: h.directories.app },
    core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
    agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shared-rc'),
    spaces: [], machines: [{ name: 'remote.invalid', nodePath: h.nodeBinary, runtime: { directory: join(h.directories.remote, 'shared-programs'), cwd: null, commands: {} } }],
  });
  Object.assign(process.env, h.localEnv, { HERDR_APP_HOME: h.directories.app, HERDR_ACCEPTANCE_CLIENT: 'shared-host' });
  let runtimeCli: (HerdrCliPorts & { dispose(): Promise<void> }) | undefined;
  let mount: { dispose(): Promise<void>; owner(): import('../contracts.js').Owner | null; execution(): { owner?: import('../contracts.js').Owner; remote?: import('../contracts.js').RemoteExecutionPort } } | undefined;
  try {
    const runtimeModules = import.meta.glob('../../../host/src/herdr/ports.ts');
    const loadRuntimePorts = runtimeModules['../../../host/src/herdr/ports.ts'];
    assert(loadRuntimePorts, 'Shared acceptance requires the production setup ports');
    const { createProductionHerdrCliPorts } = await loadRuntimePorts() as { createProductionHerdrCliPorts(packageRoot: string, env: Readonly<NodeJS.ProcessEnv>): HerdrCliPorts & { dispose(): Promise<void> } };
    runtimeCli = createProductionHerdrCliPorts(packageRoot, { ...process.env, HERDR_ACCEPTANCE_CLIENT: 'shared-setup' });
    const runtimeRequest: SetupRequest = { config, configPath: join(h.root, 'shared-config.json'), packageRoot, journalRoot: join(h.root, 'shared-runtime-journal') };
    const productionSetup = await runtimeCli.setupParts(runtimeRequest);
    assert.equal(await access(config.machines[0].runtime.directory).then(() => true, () => false), false, 'Shared setup must start with an unseeded destination');
    const setup = await acceptanceSetup(h, { machines: config.machines, parts: productionSetup });
    mount = mountHerdr(pi, { packageRoot, readConfig: async () => config,
      views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } }, actionContext: () => ({ db, sessionId: h.owner!.sessionId }),
      dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }),
        openApprovalDbs: () => ({ global: openDbAt(join(h.root, 'shared-global.db'), 'global'), repo: null }),
        readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
        scheduler: { listTriggers: () => [], subscribe: () => () => {} }, }, reportError(error: unknown) { errors.push(error); },
    }) as NonNullable<typeof mount>;
    await fire('session_start', {}, ctx);
    assert(mount?.owner(), `Shared host must activate the proved owner: ${errors.map(String).join('; ')}`);
    const feedPath = join(config.globalRoot, 'herdr', 'sessions', h.owner.sessionId, 'session.json');
    const readFeed = async () => parseFeed(await readFile(feedPath, 'utf8'));
    let feed = await waitFor(async () => readFeed().catch(() => null), 'Shared host must publish its real session feed');
    assert.equal(feed.sessionId, h.owner.sessionId); assert.equal(feed.status.effective, 'working', 'Status must remain working while the shared viewer run is pending');
    const ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc! });
    try {
      const first = await ipc.request({ op: 'openRun', generation: feed.generation, runId });
      const second = await ipc.request({ op: 'openRun', generation: feed.generation, runId });
      assert(first.ok && first.op === 'openRun', 'Shared endpoint must acquire the production viewer');
      assert.deepEqual(second, first, 'Repeated openRun must reuse the same owned viewer');
      const view = await h.hc.get(first.viewer); assert.equal(view.parent, h.owner.terminal.address); assert.equal(view.labels[HERDR_LABELS.run], runId);
      const viewerText = await waitFor(async () => { const text = await h.hc.read(first.viewer, { lines: 50 }); return text.includes('Shared viewer text') ? text : null; }, 'The production viewer must read its fixture-owned transcript');
      assert.match(viewerText, /Shared viewer text/);
      const events = h.hc.events(); await events.ready;
      try {
        const inventory = await h.cli(['ls', '--all', '--json']) as { terminals: { address: import('../contracts.js').TerminalAddress }[] };
        const summaries = await Promise.all(inventory.terminals.map(t => h.hc.get(t.address).catch(() => null)));
        const ownedViewers = summaries.filter(t => t && t.labels[HERDR_LABELS.session] === h.owner!.sessionId && t.labels[HERDR_LABELS.run] === runId && t.labels[HERDR_LABELS.kind] === HERDR_KINDS.subagentViewer);
        assert.equal(ownedViewers.length, 1, 'The shared owner/run must have exactly one viewer');
      } finally { await events.dispose(); }
      const execution = mount!.execution(); assert(execution.owner && execution.remote, 'Shared host must bind the production remote executor');
      const result = await execution.remote.execute({ owner: execution.owner, on: 'remote.invalid' as MachineName,
        source: { kind: 'code', language: 'shell', code: "printf 'shared output\\n'; printf 'shared diagnostic\\n' >&2; exit 23" }, timeout: 10000 });
      await writeFile(join(diagnosticRoot, `shared-result-${h.mode}.json`), JSON.stringify({ result, errors: errors.map(String), messages }, null, 2));
      assert.equal(result.exitCode, 23); assert.equal(result.stdout, 'shared output\n'); assert.equal(result.stderr, 'shared diagnostic\n');
      await fire('tool_execution_end', { toolName: 'spider', result: { details: result } }, ctx);
      const currentFeed = await readFeed();
      assert(currentFeed, 'The shared host retains its session feed');
      feed = currentFeed;
      assert.equal(feed.notifications.some(n => n.kind === 'job-result'), false, 'The parent result needs no duplicate feed notice');
      const quiet = await runPanelScene<{posts:unknown[];commands:unknown[]}>(`
        initView(panel,cx);await tasks[0];await panel.reload(cx);await drain();
        console.log(JSON.stringify({posts:notifications,commands}));`,feed);
      assert.deepEqual(quiet.posts, []); assert.deepEqual(quiet.commands, []);

    } finally { ipc.dispose(); }
    assert.deepEqual(setup.secondSetup, { writes: 0, launches: 0 });
    assert.deepEqual(setup.duplicateSessionWriters, []);
    const calls = await h.calls(); assertNoNativeNotes(calls);
    const eventClients = new Map<string, number>();
    for (const call of calls.filter(c => c.argv[0] === 'events')) {
      const key = JSON.stringify([call.env.HC_SESSION, call.env.HERDR_ACCEPTANCE_CLIENT ?? 'fixture']);
      eventClients.set(key, (eventClients.get(key) ?? 0) + 1);
    }
    assert(eventClients.size > 0, 'Shared acceptance must observe real events clients');
    for (const [client, count] of eventClients) assert.equal(count, 1, `One hc events process per scoped client: ${client}`);
    const oldIpc = feed.ipc!;
    await fire('session_start', {}, ctx);
    const replacement = await waitFor(async () => { const f = await readFeed(); return f && f.generation !== feed.generation ? f : null; }, 'Reload must replace the sole session feed writer');
    assert.equal(replacement.sessionId, feed.sessionId);
    assert.equal(await access(oldIpc.address).then(() => true, () => false), false, 'The old session writer endpoint must be removed');
    assert.equal(await access(oldIpc.capabilityFile).then(() => true, () => false), false, 'The old session writer capability must be removed');
    const sessionFeeds = (await filesBelow(join(config.globalRoot, 'herdr', 'sessions'))).filter(file => file === join(feed.sessionId, 'session.json'));
    assert.equal(sessionFeeds.length, 1, 'There must be one feed writer artifact for the scoped session');
    const writerGenerations = new Set([replacement.generation]);
    const pendingReads: Promise<void>[] = [];
    const observer = watch(join(feedPath, '..'), (_event, file) => {
      if (String(file) !== 'session.json') return;
      pendingReads.push(readFeed().then(value => { if (value?.sessionId === feed.sessionId) writerGenerations.add(value.generation); }));
    });
    try { await delay(2200); await Promise.all(pendingReads); }
    finally { observer.close(); }
    assert.equal(writerGenerations.size, 1, 'One feed writer generation per scoped session after reload');
  } catch (error) {
    const inventory = await h.cli(['ls', '--all', '--json']).catch(() => ({ terminals: [] })) as { terminals: { address: import('../contracts.js').TerminalAddress; labels: Record<string, string> }[] };
    const summaries = await Promise.all(inventory.terminals.map(t => h.hc.get(t.address).catch(() => null)));
    const viewerScreens = await Promise.all(summaries.filter(t => t && t.labels[HERDR_LABELS.session] === h.owner!.sessionId && t.labels[HERDR_LABELS.kind] === HERDR_KINDS.subagentViewer)
      .map(async t => ({ address: t!.address, labels: t!.labels, text: await h.hc.read(t!.address, { lines: 50 }).catch(error => String(error)) })));
    await writeFile(join(diagnosticRoot, `shared-failure-${h.mode}.json`), JSON.stringify({ error: String(error), details: error && typeof error === 'object' ? Reflect.get(error, 'details') : null, errors: errors.map(String), viewerScreens, remoteScreens: await Promise.all(summaries.filter(t => t?.address.includes('/')).map(async t => ({ terminal: t, text: await h.hc.read(t!.address, { lines: 50 }).catch(error => String(error)) }))), acknowledgementCore: await readFile(join(h.directories.local, 'ack-core.jsonl'), 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line))).catch(() => null), appCalls: await readFile(join(h.directories.local, 'app-calls.jsonl'), 'utf8').catch(() => ''), calls: (await h.calls()).map(c => c.argv) }, null, 2));
    throw error;
  } finally {
    let disposalError: unknown;
    try { await mount?.dispose(); } catch (error) { disposalError = error; }
    try { await runtimeCli?.dispose?.(); } catch (error) { disposalError ??= error; }
    try {
      db.close();
      await rm(join(transcript, '..'), { recursive: true, force: true });
      assert.equal(await access(transcript).then(() => true, () => false), false, 'Shared cleanup must remove its exact transcript');
      const repoTranscriptsAfter = await Promise.all(repoTranscriptRoots.map(root => filesBelow(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })));
      assert.deepEqual(repoTranscriptsAfter, repoTranscriptsBefore, 'Shared acceptance must write no transcript files under repo-tier scratch');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      try { await h.close(); }
      catch (error) {
        await writeFile(join(diagnosticRoot, `shared-cleanup-failure-${h.mode}.json`), JSON.stringify({ error: String(error), details: error && typeof error === 'object' ? Reflect.get(error, 'details') : null, remaining: await h.remainingOwnedResources(), disposalError: disposalError ? String(disposalError) : null, appChangeErrors: await readFile(join(h.directories.local, 'app-change-errors.jsonl'), 'utf8').catch(() => ''), calls: await h.calls() }, null, 2));
        throw error;
      }
    }
    assert.deepEqual(await h.remainingOwnedResources(), [], 'Shared features must leave no terminals or processes');
    assert.equal(await access(h.root).then(() => true, () => false), false, 'Shared cleanup must remove every owned label and file');
    if (disposalError) throw disposalError;
  }
};

export async function runCompleteSetupAcceptance(h: HerdrHarness, scenarios: readonly AcceptanceScenario[] = completeScenarios): Promise<SetupFacts> {
  const remaining: OwnedResource[] = [];
  for (const scenario of scenarios) {
    const featureHarness = await createAcceptanceHarness(h.mode);
    try { await featureHarness.start(); await scenario(featureHarness); assertNoNativeNotes(await featureHarness.calls()); }
    finally {
      await featureHarness.close();
      remaining.push(...await featureHarness.remainingOwnedResources());
    }
  }
  const facts = await acceptanceSetup(h);
  await h.close();
  remaining.push(...await h.remainingOwnedResources());
  return { ...facts, remainingOwnedResources: remaining };
}
