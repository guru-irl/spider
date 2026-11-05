// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, stat, chmod, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { SessionFeed, RunSummary, TerminalSummary } from '../../src/contracts.js';
import type { Suite } from '../harness/suite.js';
import { HarnessError } from '../harness/environment.js';
import { deadline, waitFor, type Deadline } from '../harness/wait.js';
import { readObserved, writeScript, type GateServer, type InteractiveDriver, type RpcDriver, type ObservedEvent } from '../harness/pi.js';
import { identityOf, identityAlive, rootProcesses, type ProcessIdentity } from '../harness/resources.js';
import type { ScriptFile, ScriptTurn } from './scripted-provider.js';
import { packedControl, requireCaughtControl } from '../controls/packed.js';
import { shellQuote } from './payloads/index.js';
import { installFresh } from './install-inputs.js';

export const CHILD_MODEL = 'e2e-fixture/scripted';
export const mark = (name: string) => `[[e2e:${name}]]`;
export const text = (value: string): ScriptTurn => ({ steps: [{ text: value }] });
export const tool = (id: string, args: JsonObject): ScriptTurn => ({ steps: [{ tool: { id, name: 'spider', arguments: args } }] });
export const held = (gate: string, value: string): ScriptTurn => ({ steps: [{ gate }, { text: value }] });
export const runChild = (id: string, name: string, script: string, extra: JsonObject = {}): ScriptTurn => tool(id, {
  action: 'run', agent: 'worker', name, task: `${mark(script)} Work only on the scripted fixture task.`,
  model: CHILD_MODEL, thinking: 'off', context: 'fresh', ...extra,
});
/** Explicit ordinary reconciliation turns keep completion notices from exhausting the parent script. */
export const parentTurns = (first: ScriptTurn): ScriptTurn[] => [first, text('parent settled'), ...Array.from({ length: 12 }, () => text('notice observed'))];
export async function scripts(suite: Suite, values: ScriptFile['scripts']): Promise<GateServer> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
  return suite.gates();
}

const childOutputStaged = new WeakSet<Suite>();
export async function stageChildOutput(suite: Suite): Promise<void> {
  if (childOutputStaged.has(suite)) return;
  const directory = suite.ownPath(join(suite.root, 'child-output')); await mkdir(directory, { mode: 0o700 });
  const module = suite.ownPath(join(directory, 'record.mjs'));
  await writeFile(module, `import fs from 'node:fs';
if (process.env.PI_SUBAGENT_CHILD === '1') {
  const directory = ${JSON.stringify(directory)};
  if (fs.realpathSync(directory) !== directory) throw new Error('child-output: nonphysical fixture directory');
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name], original = stream.write;
    stream.write = function (...args) {
      const result = Reflect.apply(original, this, args);
      const bytes = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0], typeof args[1] === 'string' ? args[1] : 'utf8');
      fs.appendFileSync(directory + '/' + process.pid + '.' + name, bytes, { mode: 0o600, flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW });
      return result;
    };
  }
}
`, { mode: 0o600 });
  const launcher = suite.ownPath(join(suite.root, 'bin', 'pi')); const source = await readFile(launcher, 'utf8');
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`; const anchor = `exec ${quote(process.execPath)} `;
  assert.equal(source.split(anchor).length, 2, 'The owned pi launcher needs one real-node exec anchor');
  const staged = launcher + '.task4-new'; await writeFile(staged, source.replace(anchor, `${anchor}--import ${quote(module)} `), { mode: 0o700 });
  await chmod(staged, 0o700); await rename(staged, launcher); childOutputStaged.add(suite);
}
export async function childOutput(suite: Suite, pid: number): Promise<{ stdout: string; stderr: string }> {
  const read = (stream: string) => readFile(suite.ownPath(join(suite.root, 'child-output', `${pid}.${stream}`)), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
  return { stdout: await read('stdout'), stderr: await read('stderr') };
}
export type RunRow = RunSummary;
export type Feed = SessionFeed;
export type Terminal = TerminalSummary;
export interface ChildParent { suite: Suite; pi: InteractiveDriver; sessionId: string; cwd: string; gates: GateServer; feedPath: string }

/** Setup is the only permitted source of installed runtime and helpers. Task 2 supplies this adapter. */
export async function setupFresh(suite: Suite): Promise<Suite> {
  const fresh = await installFresh(suite);
  await fresh.suite.evidence('task4-installed.json', { configPath: fresh.installed.configPath, runtimes: fresh.installed.runtimes, files: fresh.installed.files.map(file => ({ path: file.path, sha256: file.sha256 })) });
  return fresh.suite;
}
export async function parent(suite: Suite, cwd: string, gates: GateServer, extraEnv: Record<string, string> = {}): Promise<ChildParent> {
  const app = await suite.app();
  const space = await app.command('space.new', { name: 'fixture-owner', folder: cwd, argv: ['/bin/sh'] }) as { space?: string; tab?: string; terminal?: string };
  assert.equal(typeof space.space, 'string'); assert.equal(typeof space.tab, 'string'); assert.equal(typeof space.terminal, 'string');
  suite.ledger.update(l => { l.terminals.push({ side: 'local', address: space.terminal! }); });
  const pi = await suite.launchPi({ mode: 'interactive', cwd, args: ['--approve'], extraEnv });
  if (pi.mode !== 'interactive') throw new Error('A real interactive owner is required');
  const started = await pi.waitEvent('session_start', e => e.mode === 'tui', deadline(30_000));
  assert.equal(typeof started.sessionId, 'string');
  const sessionId = String(started.sessionId);
  const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', sessionId, 'session.json');
  await waitFor('live owner feed and endpoint', () => readFeed(feedPath), f => f?.lifecycle === 'live' && Boolean(f.ipc), deadline(30_000));
  const kept = await app.command('terminal.keep', { terminal: pi.terminal, place: 'right' }) as { tab?: string };
  assert.equal(typeof kept.tab, 'string');
  await waitFor('actual owner app placement', () => app.ls(), world => {
    const spaces = (world as { spaces?: { id: string; tabs: { id: string; terminals: { terminal: string }[] }[] }[] }).spaces;
    assert.ok(Array.isArray(spaces), 'Malformed app world');
    return spaces.some(s => s.id === space.space && s.tabs.some(t => t.id === kept.tab && t.terminals.some(p => p.terminal === pi.terminal)));
  }, deadline(30_000));
  await waitFor('owner feed reflects observed app placement', () => readFeed(feedPath), f => f !== null && f.placement !== null && f.placement.spaceId === space.space && f.placement.tabId === kept.tab, deadline(30_000));
  await suite.evidence(`owner-placement-${sessionId}.json`, { space, kept, world: await app.ls() });
  return { suite, pi, sessionId, cwd, gates, feedPath };
}
export async function readFeed(path: string): Promise<Feed | null> {
  try {
    const feed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(feed.version, 1); assert.equal(typeof feed.sessionId, 'string');
    assert.ok(Array.isArray(feed.runs.rows));
    return feed as Feed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function feed(owner: ChildParent): Promise<Feed> {
  const value = await readFeed(owner.feedPath); assert.ok(value, 'owner feed missing'); return value;
}
export async function runRow(owner: ChildParent, name: string, predicate: (run: RunRow) => boolean = () => true, limit: Deadline = deadline(60_000)): Promise<RunRow> {
  const value = await waitFor(`owned run ${name}`, () => feed(owner), f => f.runs.rows.some(r => r.name === name && predicate(r)), limit);
  const rows = value.runs.rows.filter(r => r.name === name); assert.equal(rows.length, 1);
  assert.equal(rows[0].ownerSessionId, owner.sessionId); return rows[0];
}
export async function terminals(suite: Suite, side: 'local' | 'dest' = 'local'): Promise<Terminal[]> {
  const value = await suite.hc(['ls', '--all', '--json'], side);
  assert.equal(value.exitCode, 0, value.stderr);
  const rows = Array.isArray(value.json) ? value.json : (value.json as { terminals?: unknown } | null)?.terminals;
  assert.ok(Array.isArray(rows), `Malformed terminal inventory: ${value.stdout}`);
  const details: Terminal[] = [];
  for (const row of rows) {
    assert.ok(row && typeof row === 'object'); assert.equal(typeof row.address, 'string');
    const detail = await suite.hc(['get', row.address, '--json'], side);
    if (detail.exitCode === 3 && (detail.json as { error?: { kind?: string } } | null)?.error?.kind === 'not_found') continue;
    assert.equal(detail.exitCode, 0, detail.stderr);
    const terminal = detail.json as Terminal; assert.equal(typeof terminal.address, 'string'); assert.equal(typeof terminal.state, 'string');
    assert.ok(terminal.labels && typeof terminal.labels === 'object'); details.push(terminal);
  }
  await suite.evidence(`terminal-inventory-${side}.json`, { list: value.json, details });
  return details;
}
export async function viewerAddress(suite: Suite, owner: ChildParent, run: RunRow): Promise<string> {
  const opened = await ipc(suite, owner, { op: 'openRun', runId: run.id });
  assert.equal(opened.ok, true); assert.equal(typeof opened.viewer, 'string');
  const rows = await waitFor(`one real viewer for ${run.name}`, () => terminals(suite), ts => ts.some(t => t.state === 'live' && t.labels['spider.kind'] === 'subagent-viewer' && t.labels['spider.run'] === run.id), deadline(30_000));
  const found = rows.filter(t => t.state === 'live' && t.labels['spider.kind'] === 'subagent-viewer' && t.labels['spider.run'] === run.id);
  assert.equal(found.length, 1); assert.equal(found[0].address, opened.viewer); assert.equal(found[0].labels['spider.session'], owner.sessionId);
  assert.equal(found[0].parent, owner.pi.terminal);
  return found[0].address;
}
export async function ipc(suite: Suite, owner: ChildParent, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const f = await feed(owner); assert.ok(f.ipc, 'owner IPC is unavailable');
  const descriptor = { version: 1, sessionId: f.sessionId, generation: f.generation, ...f.ipc };
  const result = await suite.invoke(process.execPath, [suite.packed.cli, 'ipc', '--descriptor', JSON.stringify(descriptor), '--request', JSON.stringify({ ...request, generation: f.generation })], suite.pi.env, owner.cwd);
  const reply = JSON.parse(result.stdout.trim());
  assert.equal(typeof reply.ok, 'boolean', result.stdout);
  await suite.evidence(`ipc-${String(request.op)}-${String(request.runId ?? 'owner')}.json`, { request, result, reply });
  return reply as Record<string, unknown>;
}

/** An owned PTY attach session drives the actual viewer composer, never hc send or a replacement viewer. */
export interface ViewerInput { address: string; attachTerminal: string; pid: number; output(): Promise<string>; send(data: string): Promise<void>; close(): Promise<void> }
let viewerInputs = 0;
export async function attachViewer(suite: Suite, address: string): Promise<ViewerInput> {
  const owned = (await terminals(suite)).find(t => t.address === address && t.labels['spider.kind'] === 'subagent-viewer');
  assert.ok(owned, 'Only a proved suite-owned viewer can receive input');
  const n = ++viewerInputs;
  const socketPath = suite.ownPath(join(suite.root, `v${n}.s`));
  const rawLog = suite.ownPath(join(suite.root, 'logs', `viewer-${n}.raw`));
  await mkdir(join(suite.root, 'logs'), { recursive: true });
  const result = await suite.hc(['run', '--bg', '--no-notify', '--no-parent', '--json', '--', '/usr/bin/python3', fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url)), '--socket', socketPath, '--log', rawLog, '--', suite.cores!.wrapper, 'attach', address]);
  assert.equal(result.exitCode, 0, result.stderr);
  const handle = result.json as { address?: string; terminal?: { address?: string } };
  const attachTerminal = handle.address ?? handle.terminal?.address; assert.ok(attachTerminal);
  suite.ledger.update(l => { l.terminals.push({ side: 'local', address: attachTerminal }); });
  const call = (request: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const connection = connect(socketPath); let buffer = '';
    const timer = setTimeout(() => { connection.destroy(); reject(new Error('viewer broker deadline')); }, 10_000);
    const finish = () => clearTimeout(timer);
    connection.once('connect', () => connection.write(JSON.stringify(request) + '\n'));
    connection.on('data', chunk => { buffer += chunk.toString('utf8'); const at = buffer.indexOf('\n'); if (at < 0) return; finish(); connection.destroy(); try { resolve(JSON.parse(buffer.slice(0, at))); } catch (e) { reject(e); } });
    connection.on('error', error => { finish(); reject(error); });
  });
  await waitFor('owned viewer attach broker', () => existsSync(socketPath), Boolean, deadline(20_000));
  const hello = await call({ op: 'hello' }); assert.equal(hello.terminal, attachTerminal); assert.equal(typeof hello.pid, 'number');
  const pid = Number(hello.pid); const identity = identityOf(pid);
  suite.ledger.update(l => { l.processes.push({ ...identity, label: `viewer-attach-${n}`, group: false }); });
  await suite.evidence(`viewer-attach-${n}.json`, { address, attachTerminal, identity, result });
  return {
    address, attachTerminal, pid,
    output: () => readFile(rawLog, 'utf8').catch(() => ''),
    async send(data) { const reply = await call({ op: 'input', pid, terminal: attachTerminal, data }); assert.equal(reply.ok, true); },
    async close() { await suite.hc(['kill', attachTerminal, '--json']); await suite.hc(['rm', attachTerminal, '--json']); },
  };
}
export async function viewerContains(suite: Suite, input: ViewerInput, value: string, limit: Deadline = deadline(60_000)): Promise<string> {
  try {
    const output = await waitFor(`viewer output ${value.slice(0, 50)}`, input.output, t => t.includes(value), limit, { reconcileMs: 200 });
    await suite.evidence('viewer.raw', output); return output;
  } catch (error) { await suite.evidence('viewer-failure.raw', await input.output()); throw error; }
}
export async function viewerScreen(suite: Suite, input: ViewerInput): Promise<string> {
  const result = await suite.hc(['read', input.address, '--json', '--lines', '40']); assert.equal(result.exitCode, 0, result.stderr);
  const text = (result.json as { text?: unknown }).text; assert.equal(typeof text, 'string');
  await suite.evidence(`viewer-screen-${input.address}.txt`, String(text)); return String(text);
}
export async function writableViewer(suite: Suite, input: ViewerInput): Promise<void> {
  await waitFor('pi viewer has a writable editor', () => viewerScreen(suite, input), screen => {
    const status = screen.split('\n').filter(line => /\brunning\b/.test(line)).at(-1) ?? '';
    return /\brunning\s*$/.test(status) && screen.includes('──');
  }, deadline(30_000));
}
export async function sendReadOnly(suite: Suite, input: ViewerInput, instruction: string): Promise<void> {
  await viewerContains(suite, input, 'read-only'); await input.send(instruction + '\r');
  await withinPhase('read-only viewer has no editor for an instruction', () => viewerScreen(suite, input), screen => {
    assert.ok(String(screen).includes('read-only')); assert.ok(!String(screen).includes(instruction));
  }, 500);
}
export async function childEvents(suite: Suite, pid: number): Promise<ObservedEvent[]> { return readObserved(suite.pi.observerDir, pid); }
export async function childEvent(suite: Suite, pid: number, type: string, predicate: (e: ObservedEvent) => boolean, limit: Deadline = deadline(60_000)): Promise<ObservedEvent> {
  const events = await waitFor(`child ${pid} event ${type}`, () => childEvents(suite, pid), es => es.some(e => e.type === type && predicate(e)), limit, {
    subscribe: wake => { const watcher = watch(suite.pi.observerDir, () => wake()); return () => watcher.close(); }, reconcileMs: 200,
  });
  const event = events.find(e => e.type === type && predicate(e))!;
  await suite.evidence(`child-${pid}-${type}.json`, events); return event;
}
export async function childPidForRun(suite: Suite, runId: string): Promise<number> {
  const events = await waitFor(`public child startup for ${runId}`, () => readObserved(suite.pi.observerDir), es => es.some(e => e.type === 'session_start' && e.subagentChild === '1' && typeof e.sessionFile === 'string' && e.sessionFile.includes(runId)), deadline(60_000));
  const matches = events.filter(e => e.type === 'session_start' && e.subagentChild === '1' && typeof e.sessionFile === 'string' && e.sessionFile.includes(runId));
  assert.equal(matches.length, 1); return matches[0].pid;
}
export async function readOnlyViewer(suite: Suite, owner: ChildParent, run: RunRow, instruction: string, reason: string, previousAddress?: string): Promise<void> {
  const opened = await ipc(suite, owner, { op: 'openRun', runId: run.id }); assert.equal(opened.ok, true); assert.equal(typeof opened.viewer, 'string');
  if (previousAddress !== undefined) assert.notEqual(opened.viewer, previousAddress, 'saved view must have a different terminal from the completed live viewer');
  await waitFor('opened read-only viewer has a live native terminal', () => terminals(suite), rows => rows.some(row => row.address === String(opened.viewer) && row.state === 'live'), deadline(10_000));
  const input = await attachViewer(suite, String(opened.viewer));
  try {
    await viewerContains(suite, input, reason);
    await sendReadOnly(suite, input, instruction);
    await suite.evidence(`readonly-${run.id}.raw`, await input.output());
    await input.send('\u0003');
    await waitFor('explicit close of read-only viewer', () => terminals(suite), ts => !ts.some(t => t.address === input.address && t.state === 'live'), deadline(30_000));
  } finally { await input.close(); }
}
export async function childTranscript(suite: Suite, pid: number): Promise<{ path: string; entries: Record<string, unknown>[]; raw: string }> {
  const start = await childEvent(suite, pid, 'session_start', () => true);
  assert.equal(typeof start.sessionFile, 'string');
  const path = suite.ownPath(String(start.sessionFile));
  const raw = await readFile(path, 'utf8');
  const entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  await suite.keepEvidence(path, `child-${pid}-transcript.jsonl`);
  return { path, entries, raw };
}
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(p => p?.type === 'text' ? p.text : '').join('') : '';
}
export function instructionCount(entries: Record<string, unknown>[], instruction: string): number {
  return entries.filter(e => { const m = e.message as { role?: string; content?: unknown } | undefined; return e.type === 'message' && m?.role === 'user' && messageText(m.content) === instruction; }).length;
}
export async function putDraft(pi: InteractiveDriver): Promise<void> {
  await pi.key('π draft café Ω');
  await waitFor('multibyte owner draft', () => pi.draft(), d => d === 'π draft café Ω', deadline(10_000));
  await pi.key('\u001b[D\u001b[D');
}
export async function proveDraft(pi: InteractiveDriver): Promise<void> {
  await pi.key('!');
  const value = await waitFor('owner draft and cursor preserved', () => pi.draft(), d => d.includes('!'), deadline(10_000));
  assert.equal(value, 'π draft café! Ω');
}
export async function clearDraft(pi: InteractiveDriver): Promise<void> {
  await pi.key('\u0005\u0015');
  await waitFor('cleared owner draft', () => pi.draft(), value => value === '', deadline(10_000));
}
export async function prompt(owner: ChildParent, value: string): Promise<void> {
  const at = Date.now(); await owner.pi.prompt(value);
  const entered = await owner.pi.waitEvent('message_end', e => e.at >= at && e.role === 'user' && messageText(e.content) === value, deadline(30_000));
  await owner.pi.waitEvent('agent_settled', e => e.at >= entered.at, deadline(60_000));
  const errors = (await owner.pi.events()).filter(e => e.at >= entered.at && e.type === 'message_end' && e.role === 'assistant' && e.stopReason === 'error');
  assert.deepEqual(errors, [], 'An unexpected parent provider error is not a successful story turn');
}
export async function reload(owner: ChildParent): Promise<Feed> {
  const before = await feed(owner); const at = Date.now();
  await owner.pi.prompt('/reload');
  try { await owner.pi.waitEvent('session_start', e => e.at >= at, deadline(60_000)); }
  catch (error) { await owner.suite.evidence(`reload-stall-${owner.sessionId}.raw`, await owner.pi.rawOutput()); throw error; }
  const value = await waitFor('new live endpoint generation after reload', () => feed(owner), f => f.lifecycle === 'live' && f.generation !== before.generation && Boolean(f.ipc), deadline(30_000));
  assert.equal(value.sessionId, before.sessionId); assert.equal(value.owner.terminal.address, before.owner.terminal.address);
  return value;
}
export interface ChildSshFixture { unmanagedAlias: string; bin: string; binary: string; cwd: string; log: string; effect: string; command: string; calls(): Promise<{ argv: string[]; cwd: string; pid: number }[]> }
export async function stageChildSsh(suite: Suite): Promise<ChildSshFixture> {
  const directory = suite.ownPath(join(suite.root, 'task4-ssh')), bin = suite.ownPath(join(directory, 'bin')), cwd = suite.ownPath(join(directory, 'destination'));
  await mkdir(bin, { recursive: true, mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
  const log = suite.ownPath(join(directory, 'calls.jsonl')), effect = suite.ownPath(join(directory, 'effect'));
  const command = `printf 'SSH_COMMAND_EXECUTED\\n'; pwd; printf 'SSH_EXECUTION_EFFECT\\n' >> ${shellQuote(effect)}`;
  const config = suite.ownPath(join(directory, 'config.json'));
  await writeFile(config, JSON.stringify({ version: 1, root: suite.root, cwd, log, alias: suite.cores?.machine ?? 'dest.invalid', unmanagedAlias: 'task4-unmanaged.invalid', commands: [command] }), { mode: 0o600 });
  const binary = suite.ownPath(join(bin, 'ssh'));
  const script = fileURLToPath(new URL('./task4/ssh.mjs', import.meta.url));
  await writeFile(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(config)} "$@"\n`, { mode: 0o700 }); await chmod(binary, 0o700);
  return { unmanagedAlias: 'task4-unmanaged.invalid', bin, binary, cwd, log, effect, command, async calls() { const raw = await readFile(log, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }); return raw.split('\n').filter(Boolean).map(line => JSON.parse(line)); } };
}
export interface ViewerTraceRow { at: number; pid: number; runId: string; sessionId: string; kind: string; id?: number }
export interface ViewerTrace { enabled: boolean; rows(runId: string): Promise<ViewerTraceRow[]>; cut(runId: string): Promise<void> }
export async function stageViewerTrace(suite: Suite): Promise<ViewerTrace> {
  const directory = suite.ownPath(join(suite.root, 'viewer-trace')); await mkdir(directory, { mode: 0o700 });
  const nonce = randomUUID();
  await writeFile(join(directory, 'config.json'), JSON.stringify({ version: 1, root: suite.root, viewer: suite.packed.viewer, nonce }), { mode: 0o600 });
  const enabled = Boolean(suite.cores?.local.env.NODE_OPTIONS?.includes('viewer-connections.mjs'));
  await suite.evidence('socket-recorder-coverage.json', { enabled, mode: enabled ? 'socket-level' : 'banners-and-real-stable-pid', gap: enabled ? null : 'No core-startup Node import in this invocation; zero socket attempts and the live-owner socket-cut control are not exercised.' });
  return {
    enabled,
    async rows(runId) {
      const raw = await readFile(join(directory, 'connections.jsonl'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
      const rows: ViewerTraceRow[] = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
      for (const row of rows) { assert.equal(typeof row.pid, 'number'); assert.equal(typeof row.at, 'number'); assert.equal(typeof row.runId, 'string'); assert.equal(typeof row.kind, 'string'); }
      return rows.filter(row => row.runId === runId);
    },
    async cut(runId) { assert.ok(enabled, 'The live-owner negative control requires a reachable recorder'); await writeFile(join(directory, `cut-${Buffer.from(runId).toString('base64url')}.json`), JSON.stringify({ version: 1, runId, nonce }), { mode: 0o600 }); },
  };
}
export function viewerIdentity(suite: Suite, runId: string): ProcessIdentity {
  const found = rootProcesses(suite.root).filter(p => p.command.includes(suite.packed.viewer) && p.command.includes(`--run ${runId}`));
  assert.equal(found.length, 1, 'Exactly one real owned viewer process must exist');
  const identity = identityOf(found[0].pid);
  suite.ledger.update(l => { if (!l.processes.some(p => p.pid === identity.pid && p.start === identity.start)) l.processes.push({ ...identity, label: `viewer:${runId}`, group: false }); });
  return identity;
}
export async function replacementLifecycles(suite: Suite, initial: ChildParent, trace: ViewerTrace): Promise<ChildParent> {
  const values = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts;
  for (const n of [1, 2, 3]) {
    values[`replacement-${n}-owner`] = parentTurns(runChild(`replacement-${n}-run`, `replacement-${n}`, `replacement-${n}-child`));
    values[`replacement-${n}-child`] = [tool(`replacement-${n}-tool`, { action: 'exec', language: 'shell', code: `printf 'REPLACEMENT_${n}_LOG\\n'` }), held(`replacement-${n}-ready`, 'REPLACEMENT_CHILD_HELD')];
  }
  await scripts(suite, values);
  const prepare = async (owner: ChildParent, n: number) => {
    await prompt(owner, mark(`replacement-${n}-owner`));
    const ready = await owner.gates.ready(`replacement-${n}-ready`, deadline(60_000));
    const run = await runRow(owner, `replacement-${n}`, r => r.canSteer);
    const input = await attachViewer(suite, await viewerAddress(suite, owner, run));
    await viewerContains(suite, input, `REPLACEMENT_${n}_LOG`); await writableViewer(suite, input);
    const identity = viewerIdentity(suite, run.id);
    if (trace.enabled) {
      const rows = await waitFor('recorder observes actual viewer startup and subscription', () => trace.rows(run.id), rs => rs.some(r => r.kind === 'startup') && rs.some(r => r.kind === 'stream'), deadline(10_000));
      assert.equal(rows.filter(r => r.kind === 'startup').length, 1); assert.ok(rows.every(r => r.pid === identity.pid));
    }
    return { owner, run, ready, input, identity, finalOffset: 0, finalAttempts: 0 };
  };
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  const adopt = async (previous: ChildParent, at: number) => {
    const start = await previous.pi.waitEvent('session_start', e => e.at >= at && e.mode === 'tui', deadline(60_000));
    assert.equal(typeof start.sessionId, 'string'); const sessionId = String(start.sessionId);
    const owner = { ...previous, sessionId, feedPath: join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', sessionId, 'session.json') };
    await waitFor('replacement owns a live feed and endpoint', () => readFeed(owner.feedPath), f => f?.lifecycle === 'live' && Boolean(f.ipc), deadline(30_000));
    assert.equal((await feed(previous)).lifecycle, 'live', 'New, resume and fork may not claim that the previous session quit');
    assert.equal((await feed(owner)).owner.terminal.address, previous.pi.terminal);
    return { owner, at: start.at };
  };
  const steady = async (view: Prepared) => {
    assert.ok(identityAlive(view.identity)); assert.deepEqual(viewerIdentity(suite, view.run.id), view.identity);
    const suffix = (await view.input.output()).slice(view.finalOffset);
    assert.ok(!suffix.includes('[reconnecting]') && !suffix.includes('[reconnected]'), 'A final viewer must stop reconnecting');
    if (trace.enabled) assert.equal((await trace.rows(view.run.id)).filter(r => r.kind === 'connect').length, view.finalAttempts, 'A final viewer may make no further socket attempts');
  };
  const final = async (view: Prepared, replacedAt: number) => {
    const remaining = replacedAt + 30_000 - Date.now(); assert.ok(remaining > 0, 'Replacement exhausted the final-state bound');
    const output = await viewerContains(suite, view.input, 'Owning session unavailable for 30 seconds. Saved log is read-only.', deadline(remaining));
    assert.ok(Date.now() - replacedAt <= 30_000, 'The final state must be reached within 30 seconds');
    view.finalOffset = output.length; view.finalAttempts = (await trace.rows(view.run.id)).filter(r => r.kind === 'connect').length;
    const instruction = `REPLACED_${view.run.id}_MUST_NOT_APPEAR`;
    await sendReadOnly(suite, view.input, instruction);
    assert.equal(instructionCount((await childTranscript(suite, view.ready.pid)).entries, instruction), 0);
    await withinPhase('replaced viewer remains final and alive until user close', () => steady(view), () => {});
    await suite.evidence(`replaced-${view.run.id}.raw`, await view.input.output());
    if (trace.enabled) await suite.evidence(`connections-${view.run.id}.json`, await trace.rows(view.run.id));
  };
  const close = async (view: Prepared) => {
    await steady(view); await view.input.send('\u0003');
    await waitFor('explicit close of final replaced viewer', () => terminals(suite), ts => !ts.some(t => t.address === view.input.address && t.state === 'live'), deadline(30_000));
    await view.input.close();
  };
  const first = await prepare(initial, 1);
  if (trace.enabled) {
    assert.equal((await ipc(suite, initial, { op: 'ping' })).ok, true);
    await trace.cut(first.run.id);
    const rows = await waitFor('live-owner cut has a genuine reconnect and new subscription', () => trace.rows(first.run.id), rs => { const cut = rs.find(r => r.kind === 'cut'); return Boolean(cut && rs.some(r => r.kind === 'connect' && r.id! > cut.id!) && rs.some(r => r.kind === 'stream' && r.id! > cut.id!)); }, deadline(15_000));
    assert.equal(rows.filter(r => r.kind === 'cut').length, 1); assert.equal((await ipc(suite, initial, { op: 'ping' })).ok, true);
    assert.ok(!(await first.input.output()).includes('Saved log is read-only.')); assert.deepEqual(viewerIdentity(suite, first.run.id), first.identity);
    await suite.evidence('live-owner-socket-cut-control.json', rows);
  }
  let at = Date.now(); await initial.pi.prompt('/new'); let next = await adopt(initial, at);
  assert.notEqual(next.owner.sessionId, initial.sessionId); await final(first, next.at);
  const newSession = next.owner; const second = await prepare(newSession, 2);
  let offset = (await newSession.pi.rawOutput()).length; at = Date.now(); await newSession.pi.prompt('/resume');
  await waitFor('real resume selector rendered', async () => (await newSession.pi.rawOutput()).subarray(offset).toString('utf8'), t => t.includes('Resume Session'), deadline(30_000));
  offset = (await newSession.pi.rawOutput()).length; await newSession.pi.key('"S33_RESUME_TARGET"');
  await waitFor('resume selector rendered the exact target query', async () => (await newSession.pi.rawOutput()).subarray(offset).toString('utf8'), t => t.includes('"S33_RESUME_TARGET"'), deadline(30_000));
  await newSession.pi.key('\r'); next = await adopt(newSession, at);
  assert.equal(next.owner.sessionId, initial.sessionId, 'Resume must open the actual original session');
  await final(second, next.at);
  // The original owner is genuinely healthy again, but its already-final viewer must not reattach.
  assert.equal((await ipc(suite, next.owner, { op: 'ping' })).ok, true);
  await sendReadOnly(suite, first.input, 'RESUMED_OWNER_MUST_NOT_REVIVE_FINAL_VIEWER');
  assert.equal(instructionCount((await childTranscript(suite, first.ready.pid)).entries, 'RESUMED_OWNER_MUST_NOT_REVIVE_FINAL_VIEWER'), 0);
  await withinPhase('healthy resumed owner cannot revive a final viewer', () => steady(first), () => {});
  await close(first); await close(second);
  const resumed = next.owner; const third = await prepare(resumed, 3);
  offset = (await resumed.pi.rawOutput()).length; at = Date.now(); await resumed.pi.prompt('/fork');
  await waitFor('real user-message fork selector rendered', async () => (await resumed.pi.rawOutput()).subarray(offset).toString('utf8'), t => t.includes('Fork from Message'), deadline(30_000));
  await resumed.pi.key('\r'); next = await adopt(resumed, at);
  assert.notEqual(next.owner.sessionId, resumed.sessionId); assert.notEqual(next.owner.sessionId, newSession.sessionId);
  await final(third, next.at); await close(third); await clearDraft(next.owner.pi);
  await suite.evidence('replacement-lifecycles.json', { original: await feed(initial), new: await feed(newSession), resumed: await feed(resumed), fork: await feed(next.owner) });
  return next.owner;
}
export async function saveOwner(suite: Suite, owner: ChildParent, options: { readonly queryCore?: boolean } = {}): Promise<void> {
  await suite.evidence('owner-feed.json', await feed(owner));
  const events = await owner.pi.events();
  await suite.evidence('owner-events.json', events);
  assert.deepEqual(events.filter(e => e.type === 'message_end' && e.role === 'assistant' && e.stopReason === 'error'), [], 'Unexpected provider errors prevent a story pass');
  await suite.evidence('owner.raw', await owner.pi.rawOutput());
  await suite.evidence('hc-records.json', await suite.cores!.records());
  if (options.queryCore !== false) await suite.evidence('terminals.json', await terminals(suite));
  else await suite.evidence('terminal-query-omitted.json', { reason: 'Do not auto-start a core after the intentional core-loss subcase.' });
}
export async function inventoryFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) result.push(...(await inventoryFiles(join(directory, entry.name))).map(f => `${entry.name}/${f}`));
    else result.push(entry.name);
  }
  return result.sort();
}
async function awaitingPackedControls(suite: Suite, control: string): Promise<boolean> {
  // This is a fixture prerequisite, not a product failure allowance. Integration supplies the complete Task 8 chain.
  if (existsSync(new URL('../controls/behavioral.ts', import.meta.url))) return false;
  await suite.evidence(`${control}-awaiting-integration.json`, { status: 'awaiting integration', needs: ['cb37c35d', 'e47bd1c7', '34113879'], control });
  return true;
}
export async function sourceHelperControl(suite: Suite): Promise<void> {
  if (await awaitingPackedControls(suite, 'source-helper-control')) return;
  const source = await readFile(suite.packed.extension, 'utf8'); const from = source.slice(0, 256); const end = from.indexOf('\n') + 1; assert.ok(end > 0);
  const forbidden = pathToFileURL(fileURLToPath(new URL('../../src/contracts.ts', import.meta.url))).href;
  const control = packedControl({ packedRoot: suite.packed.root, destination: suite.ownPath(join(suite.root, 'source-import-packed')), kind: 'helper-import', mutation: { operation: 'replace', file: 'dist/extension.js', from, to: from.slice(0, end) + `import ${JSON.stringify(forbidden)};\n` + from.slice(end) } });
  const values = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts;
  const configPath = suite.ownPath(join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json'));
  const prior = await readFile(configPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const settings = prior ? JSON.parse(prior.toString('utf8')) as Record<string, unknown> : {};
  values['source-control-protection'] = parentTurns({ steps: [
    { tool: { id: 'source-control-forbidden-set', name: 'spider', arguments: { action: 'control', command: 'config', scope: 'global', op: 'set', key: 'subagents.extensions', value: [suite.packed.extension] } } },
    { tool: { id: 'source-control-forbidden-unset', name: 'spider', arguments: { action: 'control', command: 'config', scope: 'global', op: 'unset', key: 'subagents.extensions' } } },
  ] });
  values['source-control-owner'] = parentTurns(runChild('source-control-spawn', 'source-control-child', 'source-control-child'));
  values['source-control-child'] = [text('SOURCE_CONTROL_CHILD_MODEL_DONE')];
  await scripts(suite, values);
  const writeUserConfig = async (bytes: string | Buffer) => {
    const staged = suite.ownPath(configPath + '.source-control');
    await writeFile(staged, bytes, { mode: 0o600 }); await rename(staged, configPath);
  };
  let owner: ChildParent | undefined;
  try {
    const userInput = JSON.stringify({ ...settings, 'subagents.extensions': [join(control.packedRoot, 'dist/extension.js'), suite.pi.providerPath, suite.pi.observerPath], 'subagents.childMode': 'print' });
    await writeUserConfig(userInput);
    owner = await parent(suite, await suite.project('source-import-control'), await suite.gates());
    const driver = owner.pi;
    const controlStart = await driver.waitEvent('session_start', event => event.sessionId === owner!.sessionId, deadline(5000));
    assert.equal(typeof controlStart.sessionFile, 'string');
    const controlSession = suite.ownPath(String(controlStart.sessionFile));
    await prompt(owner, mark('source-control-protection'));
    const refusals = [];
    for (const id of ['source-control-forbidden-set', 'source-control-forbidden-unset']) {
      const refused = await driver.toolResult(id, deadline(30000)); refusals.push(refused);
      assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.result), /subagents.extensions is protected/);
    }
    assert.equal(await readFile(configPath, 'utf8'), userInput, 'agent attempts must not change caller-owned protected configuration');
    await prompt(owner, mark('source-control-owner'));
    const spawned = await driver.toolResult('source-control-spawn', deadline(30000)); assert.equal(spawned.isError, false);
    const run = (spawned.result as { details: { run: { id: string; pid: number; pid_start_time: string } } }).details.run;
    assert.equal(typeof run.pid, 'number');
    const active = owner;
    await waitFor('exact source-import control run is ended', () => feed(active), snapshot => snapshot.runs.rows.some(row => row.id === run.id && ['done', 'failed', 'cancelled'].includes(row.status)), deadline(60000));
    const completion = await waitFor('source control exact persisted run completion', async () => (await readFile(controlSession, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'custom_message' && entry.customType === 'spider.subagent_done' && entry.details?.runId === run.id), entries => entries.length > 0, deadline(60000));
    assert.equal(completion.length, 1, 'one completion notice for the exact source-control run');
    const registered = JSON.parse(await readFile(suite.ownPath(join(suite.root, 'procs', `${run.pid}.json`)), 'utf8'));
    assert.equal(registered.pid, run.pid); assert.equal(registered.start, run.pid_start_time);
    const output = await childOutput(suite, run.pid);
    const caught = await requireCaughtControl(control, async () => { assert.doesNotMatch(output.stderr, /e2e-source-import-refused/); }, /e2e-source-import-refused/);
    await suite.evidence('packed-source-helper-control.json', { control, run, registered, output, caught, refusals, completion });
  } finally {
    try { await owner?.pi.close(); }
    finally { if (prior) await writeUserConfig(prior); else await rm(configPath); }
  }
}
export async function transcriptRootControl(suite: Suite): Promise<void> {
  if (await awaitingPackedControls(suite, 'wrong-transcript-control')) return;
  const source = await readFile(suite.packed.extension, 'utf8');
  const anchor = 'file = transcriptFile(recordedRoots ?? roots, runId);';
  assert.equal(source.split(anchor).length - 1, 1, 'The packed transcript-root control needs one actual reader');
  const control = packedControl({ packedRoot: suite.packed.root, destination: suite.ownPath(join(suite.root, 'bad-packed')), kind: 'wrong-transcript-path', mutation: { operation: 'replace', file: 'dist/extension.js', from: anchor, to: 'file = transcriptFile([], runId);' } });
  const agent = suite.ownPath(join(suite.root, 'bad-agent')); await mkdir(agent, { mode: 0o700 });
  const settings = JSON.parse(await readFile(join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'));
  assert.ok(settings.packages.includes(suite.packed.root));
  settings.packages = settings.packages.map((p: string) => p === suite.packed.root ? control.packedRoot : p);
  await writeFile(join(agent, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(join(agent, 'models.json'), await readFile(join(suite.directories.PI_CODING_AGENT_DIR, 'models.json')), { mode: 0o600 });
  const required = 'WRONG_ROOT_TAIL_MUST_BE_VISIBLE';
  const gates = await scripts(suite, {
    'bad-owner': parentTurns(runChild('bad-root-run', 'transcript-root-control', 'bad-root-child')),
    'bad-root-child': [{ steps: [{ text: 'Control assistant message remains readable through event fallback.' }, { tool: { id: 'bad-root-tool', name: 'spider', arguments: { action: 'exec', language: 'javascript', code: `console.log('CONTROL_TOOL_COMPLETE'); console.log('saved-tool-prefix '.repeat(300)); console.log(Buffer.from('${Buffer.from(required).toString('base64')}', 'base64').toString('utf8'));` } } }] }, held('bad-root-held', 'control child finished')],
  });
  const owner = await parent(suite, await suite.project('bad-root'), gates, { PI_CODING_AGENT_DIR: agent });
  try {
    await prompt(owner, mark('bad-owner'));
    const ready = await gates.ready('bad-root-held', deadline(60_000));
    const toolResult = await childEvent(suite, ready.pid, 'tool_execution_end', event => event.toolCallId === 'bad-root-tool');
    assert.ok((toolResult.result as { details: { stdout: string } }).details.stdout.includes(required), 'The real tool must actually produce the saved-only tail');
    const transcript = await childTranscript(suite, ready.pid); assert.ok(transcript.raw.includes(required), 'The control must have a real committed child transcript');
    const run = await runRow(owner, 'transcript-root-control', r => r.status === 'running');
    const input = await attachViewer(suite, await viewerAddress(suite, owner, run));
    try {
      await viewerContains(suite, input, 'CONTROL_TOOL_COMPLETE');
      const caught = await requireCaughtControl(control, async () => { assert.ok((await input.output()).includes(required), 'wrong-transcript-root: required actual transcript tail is missing'); }, /required actual transcript tail is missing/);
      await suite.evidence('wrong-transcript-root-control.json', { control, caught, transcript: transcript.path, run });
      await suite.evidence('wrong-transcript-root-control.raw', await input.output());
    } finally { await input.close(); }
    gates.release('bad-root-held');
  } finally { await owner.pi.close(); }
}
export async function withinPhase(description: string, observe: () => Promise<unknown>, assertion: (value: unknown) => void, milliseconds = 1500): Promise<void> {
  const end = Date.now() + milliseconds;
  await waitFor(description, async () => { const value = await observe(); assertion(value); return Date.now(); }, time => time >= end, deadline(milliseconds + 10_000), { reconcileMs: 200 });
}

/** Active half of S27. The inactive half uses a real RPC child in CI too. */
async function childCoreLoss(suite: Suite, owner: ChildParent, ssh: ChildSshFixture, shim: string): Promise<void> {
  const cores = suite.cores!; const forbidden = suite.ownPath(join(suite.root, 'core-loss-local-fallback'));
  const command = `ssh ${shellQuote(cores.machine)} ${shellQuote(ssh.command)}`;
  const unmanagedCommand = `ssh ${shellQuote(ssh.unmanagedAlias)} ${shellQuote(ssh.command)}`;
  const socketAlive = () => new Promise<boolean>(resolve => {
    const socket = connect(cores.local.socket); const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); }); socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
  const values = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts;
  values['core-loss-owner'] = parentTurns(runChild('core-loss-spawn', 'core-loss-child', 'core-loss-child'));
  values['core-loss-child'] = [
    tool('core-alive-path', { action: 'exec', language: 'shell', code: "printf '%s\\n' \"$PATH\"" }),
    tool('core-alive-ssh', { action: 'exec', language: 'shell', code: command }),
    tool('core-alive-unmanaged', { action: 'exec', language: 'shell', code: unmanagedCommand }),
    { steps: [{ gate: 'core-loss-ready' }, { tool: { id: 'core-loss-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'CORE_DEAD_LOCAL_OK\\n'; printf '%s\\n' \"$PATH\"" } } }] },
    tool('core-loss-ssh', { action: 'exec', language: 'shell', code: command }),
    tool('core-loss-unmanaged', { action: 'exec', language: 'shell', code: unmanagedCommand }),
    { steps: [{ gate: 'core-loss-on-ready' }, { tool: { id: 'core-loss-on', name: 'spider', arguments: { action: 'exec', language: 'shell', on: cores.machine, code: `printf 'FORBIDDEN_ROUTED_FALLBACK' > ${shellQuote(forbidden)}` } } }] },
    held('core-loss-finished', 'CORE_LOSS_CHILD_FINISHED_TURN'),
  ];
  await scripts(suite, values); const callsBefore = await ssh.calls();
  await prompt(owner, mark('core-loss-owner')); const ready = await owner.gates.ready('core-loss-ready', deadline(90_000));
  const identity = identityOf(ready.pid);
  const activePathEvent = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-alive-path'); assert.equal(activePathEvent.isError, false);
  const activePath = (activePathEvent.result as { details: { stdout: string } }).details.stdout.trim().split(':');
  assert.ok(activePath.indexOf(shim) >= 0 && activePath.indexOf(ssh.bin) > activePath.indexOf(shim), 'Before core loss the actual shim must precede fake system SSH');
  const active = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-alive-ssh');
  assert.equal(active.isError, true); assert.match(JSON.stringify(active.result), /Raw SSH to a managed machine is unavailable/);
  const liveUnmanaged = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-alive-unmanaged'); assert.equal(liveUnmanaged.isError, false);
  const liveCalls = await ssh.calls(); assert.equal(liveCalls.length, callsBefore.length + 1); assert.deepEqual(liveCalls.at(-1)?.argv, [ssh.unmanagedAlias, ssh.command]);
  assert.ok(!liveCalls.some(row => row.argv[0] === cores.machine), 'The live managed refusal must never reach fake SSH');
  assert.equal(await readFile(ssh.effect, 'utf8'), 'SSH_EXECUTION_EFFECT\n'); assert.equal(await socketAlive(), true);
  await suite.evidence('core-loss-active-control.json', { active, liveUnmanaged, activePathEvent, activePath, callsBefore, liveCalls, socketAlive: true, effect: await readFile(ssh.effect, 'utf8') });
  const owned = suite.ledger.read().cores.find(c => c.side === 'local'); assert.ok(owned?.pid && owned.start);
  assert.equal(owned.pid, cores.local.pid); assert.ok(identityAlive({ pid: owned.pid, start: owned.start }));
  // Stop the owned app poller before faulting the original core so it cannot immediately recreate the socket.
  const poller = suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon'); assert.ok(poller);
  if (identityAlive(poller)) { process.kill(poller.pid, 'SIGTERM'); await waitFor('owned app poller exits', () => identityAlive(poller), alive => !alive, deadline(5_000)); }
  // Fault only the ledger-owned original core. The child is in its own real process group.
  process.kill(owned.pid, 'SIGKILL');
  await waitFor('original owned core is dead', () => identityAlive({ pid: owned.pid!, start: owned.start! }), a => !a, deadline(10_000));
  await waitFor('the original owned core socket is really dead', socketAlive, alive => !alive, deadline(5_000));
  await suite.evidence('core-socket-dead.json', { socket: cores.local.socket, originalPid: owned.pid, alive: false });
  owner.gates.release('core-loss-ready');
  try {
    await owner.gates.ready('core-loss-on-ready', deadline(90_000)); assert.ok(identityAlive(identity), 'Core loss must not exit the pi child');
    const local = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-loss-local');
    assert.equal(local.isError, false); const localResult = (local.result as { details: { stdout: string } }).details;
    assert.ok(localResult.stdout.startsWith('CORE_DEAD_LOCAL_OK\n'));
    const path = localResult.stdout.split('\n')[1].split(':');
    assert.ok(!path.includes(shim), 'After core loss the child tool PATH must not contain the shim');
    assert.ok(path.includes(ssh.bin), 'The owned fake remains the system SSH after deactivation');
    const plain = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-loss-ssh'); assert.equal(plain.isError, false);
    assert.equal((plain.result as { details: { stdout: string } }).details.stdout, `SSH_COMMAND_EXECUTED\n${ssh.cwd}\n`);
    const deadUnmanaged = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-loss-unmanaged'); assert.equal(deadUnmanaged.isError, false);
    assert.equal((deadUnmanaged.result as { details: { stdout: string } }).details.stdout, `SSH_COMMAND_EXECUTED\n${ssh.cwd}\n`);
    const calls = await ssh.calls(); assert.equal(calls.length, liveCalls.length + 2);
    assert.deepEqual(calls.slice(-2).map(row => row.argv), [[cores.machine, ssh.command], [ssh.unmanagedAlias, ssh.command]]);
    assert.equal(await readFile(ssh.effect, 'utf8'), 'SSH_EXECUTION_EFFECT\nSSH_EXECUTION_EFFECT\nSSH_EXECUTION_EFFECT\n');
    const jobIds = async () => {
      const root = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'jobs'); const names = (await inventoryFiles(root)).filter(p => p.endsWith('/jobs.json') || p === 'jobs.json');
      const ids: string[] = [];
      for (const name of names) { const journal = JSON.parse(await readFile(join(root, name), 'utf8')); assert.ok(Array.isArray(journal.jobs)); ids.push(...journal.jobs.map((job: { id: string }) => job.id)); }
      return ids.sort();
    };
    const beforeJobs = await jobIds(), beforeRuns = (await cores.records()).filter(r => r.argv[0] === 'run').length;
    owner.gates.release('core-loss-on-ready'); await owner.gates.ready('core-loss-finished', deadline(60_000));
    const routed = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'core-loss-on'); assert.equal(routed.isError, true);
    assert.match(JSON.stringify(routed.result), /core[^\n]*(?:unavailable|not available)|herdr[^\n]*disabled|herdr-unavailable/i);
    await assert.rejects(readFile(forbidden), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    const afterJobs = await jobIds(); assert.ok(afterJobs.every(id => beforeJobs.includes(id)), 'A disabled on request may create no new job');
    assert.equal((await cores.records()).filter(r => r.argv[0] === 'run').length, beforeRuns, 'A disabled on request may create no new terminal');
    assert.ok(identityAlive(identity));
    await suite.evidence('child-core-loss.json', { identity, local, plain, deadUnmanaged, routed, calls, beforeJobs, afterJobs, beforeRuns, output: await childOutput(suite, ready.pid) });
    const at = Date.now(); owner.gates.release('core-loss-finished');
    await childEvent(suite, ready.pid, 'agent_settled', e => e.at >= at);
    assert.ok((await childTranscript(suite, ready.pid)).raw.includes('CORE_LOSS_CHILD_FINISHED_TURN'));
  } finally {
    for (const gate of ['core-loss-ready', 'core-loss-on-ready', 'core-loss-finished']) {
      try { owner.gates.release(gate); } catch (error) {
        if (!(error instanceof HarnessError) || !['gate-already-released', 'gate-not-ready'].includes(error.code)) throw error;
      }
    }
    await suite.evidence('core-loss-final-observations.json', { identity, childAlive: identityAlive(identity), parentAlive: identityAlive(owner.pi.identity), calls: await ssh.calls(), output: await childOutput(suite, ready.pid) });
  }
}
async function stopParentWithoutCore(owner: ChildParent): Promise<void> {
  const identity = owner.pi.identity;
  if (identityAlive(identity)) { try { process.kill(identity.pid, 'SIGTERM'); } catch {} }
  try { await waitFor('owned parent exits without hc auto-start', () => identityAlive(identity), a => !a, deadline(10_000)); }
  catch { if (identityAlive(identity)) process.kill(identity.pid, 'SIGKILL'); await waitFor('owned parent is reaped', () => identityAlive(identity), a => !a, deadline(10_000)); }
}
async function childPsFault(suite: Suite, owner: ChildParent): Promise<void> {
  if (process.platform !== 'darwin') { await suite.evidence('ps-fault-coverage.json', { exercised: false, reason: 'This platform does not use the macOS ps identity probe.' }); return; }
  const wrapper = suite.ownPath(join(suite.root, 'bin', 'ps')), log = suite.ownPath(join(suite.root, 'ps-child-calls'));
  const previous = await readFile(wrapper).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const next = wrapper + '.task4-next';
  await writeFile(next, `#!/bin/sh\nif [ "\${PI_SUBAGENT_CHILD-}" = 1 ]; then printf '%s\\n' "$PPID" >> ${quote(log)}; printf 'E2E_PS_CHILD_FAILURE\\n' >&2; exit 1; fi\nexec /bin/ps "$@"\n`, { mode: 0o700 });
  await chmod(next, 0o700); await rename(next, wrapper);
  const values = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts;
  values['ps-fault-owner'] = parentTurns({ steps: [
    { tool: { id: 'ps-print-mode', name: 'spider', arguments: { action: 'control', command: 'config', scope: 'repo', op: 'set', key: 'subagents.childMode', value: 'print' } } },
    { tool: { id: 'ps-spawn', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'ps-fault-child', task: mark('ps-fault-child'), model: CHILD_MODEL, thinking: 'off' } } },
  ] });
  values['ps-fault-child'] = [tool('ps-survival-tool', { action: 'exec', language: 'shell', code: "printf 'PS_FAULT_SURVIVED\\n'" }), held('ps-fault-ready', 'PS_CHILD_DONE')];
  values['ps-fault-reset'] = parentTurns(tool('ps-reset-mode', { action: 'control', command: 'config', scope: 'repo', op: 'unset', key: 'subagents.childMode' }));
  await scripts(suite, values);
  try {
    await prompt(owner, mark('ps-fault-owner')); assert.equal((await owner.pi.toolResult('ps-print-mode', deadline(30_000))).isError, false);
    const ready = await owner.gates.ready('ps-fault-ready', deadline(60_000));
    const calls = await readFile(log, 'utf8'); assert.ok(calls.split('\n').includes(String(ready.pid)), 'The failing ps must actually be invoked by this real child');
    const event = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'ps-survival-tool');
    await suite.evidence('ps-fault-child.json', { calls, event, output: await childOutput(suite, ready.pid) });
    assert.equal(event.isError, false, 'An unavailable ps probe must not take down spider in the child');
    assert.equal((event.result as { details: { stdout: string } }).details.stdout, 'PS_FAULT_SURVIVED\n');
  } finally {
    owner.gates.release('ps-fault-ready');
    const restoring = wrapper + '.task4-restore';
    if (previous) { await writeFile(restoring, previous, { mode: 0o700 }); await chmod(restoring, 0o700); await rename(restoring, wrapper); }
    else await rm(wrapper, { force: true });
    await prompt(owner, mark('ps-fault-reset')); assert.equal((await owner.pi.toolResult('ps-reset-mode', deadline(30_000))).isError, false);
  }
}
export async function activeChildOwnership(suite: Suite): Promise<void> {
  suite = await setupFresh(suite); const cwd = await suite.project('active-owner'); const ssh = await stageChildSsh(suite);
  const gates = await scripts(suite, { owner: parentTurns(runChild('spawn-owned', 'owned-child', 'held-child')), 'held-child': [held('ownership-ready', 'owned child finished')] });
  const owner = await parent(suite, cwd, gates, { PATH: ssh.bin + ':' + suite.pi.env.PATH });
  const root = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
  const shimFiles = (await inventoryFiles(join(root, 'ssh', 'bin'))).filter(path => path.endsWith('/ssh')); assert.equal(shimFiles.length, 1);
  const installedShim = join(root, 'ssh', 'bin', shimFiles[0]); const shim = dirname(installedShim);
  const installedSsh = await readFile(installedShim, 'utf8');
  assert.ok(installedSsh.includes(ssh.binary), 'The installed shim must resolve only to the owned fake, never real ssh');
  const before = await feed(owner);
  const mappingsBefore = await inventoryFiles(join(root, 'terminals'));
  const mappingBytes = await Promise.all(mappingsBefore.map(p => readFile(join(root, 'terminals', p), 'utf8')));
  const sshBefore = await inventoryFiles(join(root, 'ssh'));
  const shimsBefore = await Promise.all(sshBefore.filter(p => p.startsWith('bin/')).map(async path => ({ path, bytes: await readFile(join(root, 'ssh', path), 'utf8'), mtime: (await stat(join(root, 'ssh', path))).mtimeMs })));
  assert.ok(shimsBefore.length > 0, 'The parent must supply a real inherited SSH policy shim');
  await prompt(owner, mark('owner')); const ready = await gates.ready('ownership-ready', deadline(60_000));
  const run = await runRow(owner, 'owned-child', r => r.status === 'running');
  const after = await feed(owner);
  assert.deepEqual(after.owner, before.owner); assert.deepEqual(after.ipc, before.ipc); assert.equal(after.generation, before.generation);
  assert.deepEqual(await inventoryFiles(join(root, 'terminals')), mappingsBefore);
  assert.deepEqual(await Promise.all(mappingsBefore.map(p => readFile(join(root, 'terminals', p), 'utf8'))), mappingBytes);
  assert.deepEqual(await inventoryFiles(join(root, 'ssh')), sshBefore);
  const shimsAfter = await Promise.all(sshBefore.filter(p => p.startsWith('bin/')).map(async path => ({ path, bytes: await readFile(join(root, 'ssh', path), 'utf8'), mtime: (await stat(join(root, 'ssh', path))).mtimeMs })));
  assert.deepEqual(shimsAfter, shimsBefore);
  const hcRecords = await suite.cores!.records();
  assert.equal(hcRecords.filter(r => r.ppid === ready.pid && r.argv[0] === 'run').length, 0, 'A child may not launch a viewer or other terminal writer');
  assert.ok(hcRecords.some(r => r.argv[0] === 'run'), 'The recorder must observe actual parent/viewer launches');
  const events = await childEvents(suite, ready.pid); const started = events.find(e => e.type === 'session_start'); assert.ok(started);
  assert.equal(started.mode, 'rpc'); assert.equal(started.subagentChild, '1'); assert.notEqual(started.sessionId, owner.sessionId);
  const sessionDirs = await readdir(join(root, 'sessions')); assert.ok(!sessionDirs.includes(String(started.sessionId)), 'A child must not publish its own session feed/panel endpoint');
  const presence = await waitFor('one real active child presence', async () => {
    const names = await readdir(join(root, 'processes'));
    return Promise.all(names.filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(root, 'processes', n), 'utf8'))));
  }, rows => rows.some(p => p.pid === ready.pid), deadline(20_000));
  const own = presence.filter(p => p.pid === ready.pid); assert.equal(own.length, 1); assert.equal(own[0].kind, 'child'); assert.ok(own[0].startIdentity);
  assert.ok(!presence.filter(p => p.pid === owner.pi.pid).some(p => p.kind === 'child'), 'Known-bad top-level identity cannot satisfy child presence');
  const childFiles = await childTranscript(suite, ready.pid); assert.ok(!childFiles.raw.includes('\u001b]7501;'));
  const bytes = await childOutput(suite, ready.pid); assert.ok(bytes.stdout.length > 0, 'The raw recorder must observe actual child protocol bytes');
  assert.ok(!bytes.stdout.includes('\u001b]7501;')); assert.ok(!bytes.stderr.includes('\u001b]7501;'));
  const local = await terminals(suite);
  assert.equal(local.filter(t => t.labels['spider.session'] === String(started.sessionId)).length, 0);
  assert.equal(local.filter(t => t.labels['spider.run'] === run.id && t.labels['spider.kind'] === 'subagent-viewer' && t.state === 'live').length, 0);
  await suite.evidence('ownership-boundary.json', { before, after, presence, mappingsBefore, sshBefore, shimsBefore, shimsAfter, hcRecords, events, local, bytes });
  gates.release('ownership-ready'); await owner.pi.waitEvent('message_end', e => e.customType === 'spider.subagent_done', deadline(60_000));
  const failures: unknown[] = [];
  try { await childPsFault(suite, owner); } catch (error) { failures.push(error); await suite.evidence('ps-fault-failure.json', { error: String(error) }); }
  try { await childCoreLoss(suite, owner, ssh, shim); } catch (error) { failures.push(error); await suite.evidence('core-loss-failure.json', { error: String(error) }); }
  try { await saveOwner(suite, owner, { queryCore: false }); } catch (error) { failures.push(error); }
  await stopParentWithoutCore(owner);
  if (failures.length) throw new AggregateError(failures, 'Strict child ps/core-loss assertions failed');
}
