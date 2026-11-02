// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, rename, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertSocketPath } from '../../harness/environment.js';
import { appObject } from '../../harness/app.js';
import { identityOf } from '../../harness/resources.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { Suite, AppDriver } from '../../harness/suite.js';
import type { InteractiveDriver, ObservedEvent } from '../../harness/pi.js';
import { marker, type ScriptTurn } from '../scripted-provider.js';
import { reloadInteractive } from '../lifecycle-driver.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { HarnessError } from '../../harness/environment.js';
import { readDestination, writeDestination, shellQuote } from './index.js';
import { secondDestination } from './destinations.js';
import { remoteInstallOptions } from '../remote-install-inputs.js';
import { destinationRoot, destinationPath } from '../../harness/destination.js';

export interface ExecObservation {
  stdout: string; stderr: string; exitCode: number | null; outcome?: string; timedOut?: boolean; signal?: string; aborted?: boolean; backgrounded?: boolean;
  remote?: { jobId: string; machine: string; address: string };
  backgroundLogs?: { stdout: string; stderr: string };
  backgroundJob?: { id: string; dir: string; manifest: string; receipt: string; logs: { stdout: string; stderr: string } };
}
export interface TerminalRow { address: string; state: string; name: string | null; title?: string; pid?: number; labels: Record<string, string> }
export interface RemoteStory {
  suite: Suite; app: AppDriver; config: Record<string, any>; configPath: string; cwd: string; destinationCwd: string; machine: string;
  driver: InteractiveDriver; sessionId: string; sessionFile: string;
}
const scripts = new WeakMap<Suite, Record<string, ScriptTurn[]>>();
/** Definitions are inputs to the offline model, not calls to a replacement spider implementation. */
export async function scriptCalls(suite: Suite, name: string, calls: readonly { id: string; args: JsonObject }[], gate?: string): Promise<void> {
  const all = scripts.get(suite) ?? {};
  all[name] = [
    { steps: calls.map(c => ({ tool: { id: c.id, name: 'spider', arguments: c.args } })) },
    { steps: [...(gate ? [{ gate }] : []), { text: `Completed ${name}` }] },
    ...Array.from({ length: 8 }, (_, i) => ({ steps: [{ text: `Reconciled ${name} notice phase ${i + 1}` }] })),
  ];
  scripts.set(suite, all);
  const next = suite.ownPath(suite.pi.scriptPath + '.new');
  await writeFile(next, JSON.stringify({ story: suite.story, scripts: all }, null, 2), { mode: 0o600 }); await rename(next, suite.pi.scriptPath);
}
export async function begin(story: RemoteStory, name: string, calls: readonly { id: string; args: JsonObject }[], gate?: string): Promise<number> {
  await scriptCalls(story.suite, name, calls, gate);
  const at = Date.now(); await story.driver.prompt(`${marker(name)} Execute the scripted remote story.`); return at;
}
export async function settled(driver: InteractiveDriver, after: number): Promise<void> {
  await driver.waitEvent('agent_settled', e => e.at >= after, deadline(180000));
}
export function rawDetails(event: ObservedEvent): unknown {
  const result = event.result as { details?: unknown } | undefined;
  assert.ok(result && Object.hasOwn(result, 'details'), 'real tool result must include structured details');
  return result.details;
}
export function execDetails(event: ObservedEvent): ExecObservation {
  const d = rawDetails(event) as ExecObservation;
  assert.equal(typeof d?.stdout, 'string', 'tool result stdout');
  assert.equal(typeof d?.stderr, 'string', 'tool result stderr');
  assert.ok(d.exitCode === null || Number.isInteger(d.exitCode), 'tool result exitCode');
  return d;
}
export async function result(story: RemoteStory, id: string): Promise<ExecObservation> {
  const event = await story.driver.toolResult(id, deadline(180000));
  await story.suite.evidence(`tool-${id}.json`, event);
  return execDetails(event);
}
export async function call(story: RemoteStory, name: string, args: JsonObject): Promise<ExecObservation> {
  const at = await begin(story, name, [{ id: name, args }]);
  const value = await result(story, name); await settled(story.driver, at); return value;
}
export async function inventory(suite: Suite): Promise<TerminalRow[]> {
  const r = await suite.hc(['ls', '--all', '--json']);
  assert.equal(r.exitCode, 0, 'real hc inventory');
  const v = r.json as { terminals?: unknown };
  assert.ok(Array.isArray(v?.terminals), 'real hc terminal array');
  const rows: TerminalRow[] = [];
  for (const summary of v.terminals) {
    assert.ok(summary && typeof summary === 'object' && typeof summary.address === 'string', 'real hc summary address');
    const reply = await suite.hc(['get', summary.address, '--json']);
    assert.equal(reply.exitCode, 0, 'real hc terminal details');
    const detail = reply.json as Record<string, unknown>;
    assert.ok(detail && typeof detail === 'object' && detail.address === summary.address, 'native details match the requested address');
    assert.ok(detail.state === 'live' || detail.state === 'finished', 'native terminal state');
    assert.ok(detail.name === null || typeof detail.name === 'string', 'native terminal name');
    assert.ok(detail.labels && typeof detail.labels === 'object' && !Array.isArray(detail.labels), 'native terminal labels');
    assert.ok(Object.values(detail.labels).every(value => typeof value === 'string'), 'native label values');
    const row: TerminalRow = { address: summary.address, state: detail.state, name: detail.name, labels: detail.labels as Record<string, string> };
    if (typeof detail.pid === 'number') row.pid = detail.pid;
    if (typeof detail.title === 'string') row.title = detail.title;
    rows.push(row);
  }
  return rows;
}
export const consoles = (rows: readonly TerminalRow[], sessionId: string, machine?: string): TerminalRow[] => rows.filter(t => t.labels['spider.kind'] === 'remote-console' && t.labels['spider.session'] === sessionId && (!machine || t.labels['spider.machine'] === machine));
export function exactResult(value: ExecObservation, stdout: string, stderr: string, exitCode: number): void {
  assert.equal(value.stdout, stdout); assert.equal(value.stderr, stderr); assert.equal(value.exitCode, exitCode); assert.equal(value.outcome, 'exited');
}
export function detached(value: ExecObservation): void {
  assert.equal(value.exitCode, null); assert.equal(value.outcome, 'timeout'); assert.equal(value.backgrounded, true);
  assert.ok(value.backgroundJob && value.backgroundLogs, 'durable background handle and logs');
  assert.equal(value.backgroundJob.id, value.remote?.jobId);
}
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function saveSession(story: RemoteStory, name = 'session.jsonl'): Promise<Record<string, any>[]> {
  const bytes = await readFile(story.suite.ownPath(story.sessionFile), 'utf8');
  await story.suite.evidence(name, bytes);
  return bytes.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function notices(story: RemoteStory, jobId: string): Promise<Record<string, any>[]> {
  return (await saveSession(story)).filter(e => e.type === 'custom_message' && e.customType === 'spider.job_done' && e.details?.jobId === jobId);
}
export function noticeCount(entries: readonly unknown[], count: number): void { assert.equal(entries.length, count, 'exact per-job persisted notice count'); }
export async function oneNotice(story: RemoteStory, jobId: string): Promise<Record<string, any>> {
  const entries = await waitFor(`owning session notice ${jobId}`, () => notices(story, jobId), rows => rows.length > 0, deadline(60000), { reconcileMs: 200 });
  noticeCount(entries, 1); await story.suite.evidence(`notice-${jobId}.json`, entries); return entries[0];
}
export async function reload(story: RemoteStory): Promise<void> {
  let event: Awaited<ReturnType<typeof reloadInteractive>>;
  try { event = await reloadInteractive(story.driver, deadline(60000)); }
  catch (error) { await story.suite.evidence('reload-stall.raw', await story.driver.rawOutput()); throw error; }
  assert.equal(event.sessionId, story.sessionId, 'reload keeps the owner');
  await waitFor('reloaded owner feed', () => feed(story), f => f.sessionId === story.sessionId && f.lifecycle === 'live', deadline(20000));
}
export async function feed(story: RemoteStory): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(story.suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/sessions', story.sessionId, 'session.json'), 'utf8'));
}
export async function snapshot(story: RemoteStory, phase: string): Promise<void> {
  await story.suite.evidence(`${phase}-events.json`, await story.driver.events());
  await story.suite.evidence(`${phase}-hc.json`, await inventory(story.suite));
  await story.suite.evidence(`${phase}-app.json`, appObject(await story.app.ls()));
  await story.suite.evidence(`${phase}-calls.json`, await story.suite.cores!.records());
  await story.suite.evidence(`${phase}-pty.raw`, await story.driver.rawOutput());
  await saveSession(story, `${phase}-session.jsonl`);
}
export async function persistedLogs(story: RemoteStory, value: ExecObservation): Promise<{ stdout: Buffer; stderr: Buffer; manifest: Record<string, any>; receipt: Record<string, any> }> {
  const logs = value.backgroundLogs ?? value.backgroundJob?.logs;
  assert.ok(logs, 'remote result points to complete private logs');
  const dir = value.backgroundJob?.dir ?? join(logs.stdout, '..');
  const manifest = JSON.parse(await readFile(story.suite.ownPath(value.backgroundJob?.manifest ?? join(dir, 'job.json')), 'utf8'));
  const receiptPath = story.suite.ownPath(value.backgroundJob?.receipt ?? join(dir, 'receipt.json'));
  await waitFor('durable local receipt', async () => readFile(receiptPath, 'utf8').catch(() => null), v => v !== null, deadline(90000));
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const stdout = await readFile(story.suite.ownPath(logs.stdout)), stderr = await readFile(story.suite.ownPath(logs.stderr));
  await story.suite.keepEvidence(logs.stdout, `${value.remote!.jobId}-stdout.log`); await story.suite.keepEvidence(logs.stderr, `${value.remote!.jobId}-stderr.log`);
  await story.suite.evidence(`${value.remote!.jobId}-receipt.json`, receipt);
  await story.suite.evidence(`${value.remote!.jobId}-log-digests.json`, { stdout: { bytes: stdout.length, sha256: digest(stdout) }, stderr: { bytes: stderr.length, sha256: digest(stderr) } });
  return { stdout, stderr, manifest, receipt };
}
export async function configChanged(story: RemoteStory): Promise<void> {
  const next = story.suite.ownPath(story.configPath + '.new');
  await writeFile(next, JSON.stringify(story.config, null, 2), { mode: 0o600 }); await rename(next, story.configPath); await reload(story);
}
/** The setup helper and input factory are supplied by the setup task. No manual runtime install is allowed. */
export async function remoteStory(original: Suite, options: { secondMachine?: boolean; coreBinary?: string } = {}): Promise<RemoteStory> {
  const { prepareInstallInputs } = await import('../install-inputs.js');
  const { runSetup, readInstalled } = await import('../../harness/setup.js');
  const { suite, config, app } = await prepareInstallInputs(original, await remoteInstallOptions(original));
  const ssh = suite.ownPath(join(suite.root, 'bin/ssh')), sentinel = suite.ownPath(join(suite.root, 'ssh-sentinel.txt'));
  await writeFile(ssh, `#!/bin/sh\nprintf 'invoked\\n' >> ${shellQuote(sentinel)}\nprintf 'fixture SSH sentinel\\n' >&2\nexit 99\n`, { mode: 0o700 });
  const cwd = await suite.project('local');
  const machine = suite.cores!.machine;
  const primary = config.machines.find(m => m.name === machine);
  if (!primary) throw new HarnessError('missing-prerequisite', 'setup inputs must include the suite destination');
  if (options.coreBinary) config.core.binary = suite.ownPath(options.coreBinary);
  const runtime = primary.runtime;
  const destinationCwd = suite.options.tier === 'remote' ? runtime.cwd! : await suite.project('destination');
  runtime.cwd = destinationCwd;
  if (options.secondMachine) {
    const second = await secondDestination(suite);
    config.machines.push({ ...primary, name: second, aliases: [], runtime: { ...runtime, directory: destinationPath(suite, join(destinationRoot(suite), 'runtime-second')) } });
  }
  const absent = ['agents', 'spaces', 'pane', 'tabs', 'panel', 'machines'].map(name => join(config.app.home, 'mods', `spider-${name}`));
  absent.push(join(config.app.home, 'layouts/spider-glass.json'));
  if (suite.options.tier !== 'remote') absent.push(...config.machines.map(machine => machine.runtime.directory));
  else for (const machine of config.machines) {
    const path = join(machine.runtime.directory, `spider-remote-runtime-${suite.packed.digests['dist/herdr/remote-runtime.mjs'].slice(0, 16)}.mjs`);
    assert.equal(await readDestination(suite, machine.name, path), null, 'fresh destination has no installed runtime');
  }
  for (const path of absent) assert.equal(await lstat(suite.ownPath(path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'fresh setup output must be absent');
  await suite.evidence('fresh-paths.json', { absent });
  const setup = await runSetup(suite, config);
  await suite.evidence('setup.json', setup);
  if (setup.exitCode !== 0) await suite.evidence('failed-setup-doctor.json', await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', setup.configPath], suite.env));
  assert.equal(setup.exitCode, 0, `fresh setup failed: ${setup.stderr || setup.stdout}`);
  const installed = await readInstalled(suite, setup.configPath);
  await suite.evidence('installed.json', { configPath: installed.configPath, runtimes: installed.runtimes });
  const globalConfig = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const settings = JSON.parse(await readFile(globalConfig, 'utf8'));
  await writeFile(globalConfig, JSON.stringify({ ...settings, 'herdr.enabled': true, 'herdr.config': installed.configPath }, null, 2));
  const driver = await suite.launchPi({ mode: 'interactive', cwd, args: ['--approve'] });
  assert.equal(driver.mode, 'interactive');
  const start = await driver.waitEvent('session_start', () => true, deadline(60000));
  assert.equal(start.mode, 'tui'); assert.equal(start.hcTerminal, driver.terminal); assert.ok(start.sessionFile);
  const story: RemoteStory = { suite, app, config, configPath: installed.configPath, cwd, destinationCwd, machine, driver, sessionId: String(start.sessionId), sessionFile: String(start.sessionFile) };
  await waitFor('actual live owner feed after setup', () => feed(story), f => f.owner?.sessionId === story.sessionId && f.lifecycle === 'live', deadline(20000));
  return story;
}
export async function remoteEffect(suite: Suite, machine: string, path: string): Promise<string | null> { return readDestination(suite, machine, path); }
export async function writeMarker(suite: Suite, machine: string, path: string, text: string): Promise<void> { await writeDestination(suite, machine, path, text); }
export async function consoleText(suite: Suite, address: string): Promise<string> {
  const r = await suite.hc(['read', address, '--json', '--lines', '2000']);
  assert.equal(r.exitCode, 0); const v = r.json as { text?: string; screen?: string };
  assert.equal(typeof v?.text, 'string'); return v.text!;
}
export async function consoleFor(story: RemoteStory, machine: string = story.machine): Promise<TerminalRow> {
  const rows = await waitFor('one real owned machine console', () => inventory(story.suite), rows => consoles(rows, story.sessionId, machine).length > 0, deadline(15000));
  const found = consoles(rows, story.sessionId, machine); assert.equal(found.length, 1); return found[0];
}
export async function assertNoPanes(story: RemoteStory): Promise<void> {
  const world = JSON.stringify(await story.app.ls());
  const rows = await inventory(story.suite);
  for (const t of rows.filter(t => ['remote-console', 'exec', 'exec-file', 'batch', 'remote-observer'].includes(t.labels['spider.kind']))) {
    assert.ok(!t.labels['herdr.space'] && !t.labels['herdr.tab'], 'no automatic remote placement labels');
    assert.ok(!world.includes(`\"terminal\":\"${t.address}\"`), 'remote job or console must not appear as an automatic pane');
  }
}
export async function rejection(story: RemoteStory, name: string, args: JsonObject, effect?: string): Promise<void> {
  const at = await begin(story, name, [{ id: name, args }]);
  const event = await story.driver.toolResult(name, deadline(30000));
  await story.suite.evidence(`refused-${name}.json`, event);
  assert.equal(event.isError, true, 'known bad request must be visibly refused');
  await settled(story.driver, at);
  if (effect) assert.equal(await readDestination(story.suite, story.machine, effect), null, 'refusal must have no payload effect');
}
export async function anotherOwner(story: RemoteStory, project = 'other-agent'): Promise<RemoteStory> {
  const cwd = await story.suite.project(project);
  const driver = await story.suite.launchPi({ mode: 'interactive', cwd, args: ['--approve'] });
  assert.equal(driver.mode, 'interactive');
  const start = await driver.waitEvent('session_start', () => true, deadline(60000));
  const next = { ...story, driver, cwd, sessionId: String(start.sessionId), sessionFile: String(start.sessionFile) };
  assert.notEqual(next.sessionId, story.sessionId);
  await waitFor('second real owner feed', () => feed(next), f => f.sessionId === next.sessionId, deadline(20000));
  return next;
}
export async function nameSession(story: RemoteStory, name: string): Promise<void> {
  await story.driver.prompt(`/name ${name}`); await reload(story);
  await waitFor('actual named owner after activation', () => feed(story), f => f.owner?.name === name, deadline(15000));
}
export async function typeInObservedConsole(suite: Suite, address: string, bytes: string): Promise<void> {
  const socket = assertSocketPath(suite.root, join(suite.root, 'z.s')), log = suite.ownPath(join(suite.root, 'console-observer.raw'));
  const r = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--no-parent', '--', '/usr/bin/python3', fileURLToPath(new URL('../../harness/pty-broker.py', import.meta.url)), '--socket', socket, '--log', log, '--', suite.cores!.wrapper, 'attach', '--observe', '--history', '100', address]);
  assert.equal(r.exitCode, 0); const terminal = (r.json as { address: string }).address;
  assert.ok(terminal); suite.ledger.update(l => l.terminals.push({ side: 'local', address: terminal }));
  await waitFor('owned console observer broker', async () => stat(socket).then(s => s.isSocket(), () => false), Boolean, deadline(10000));
  const query = (request: object) => new Promise<Record<string, any>>((resolve, reject) => {
    const connection = connect(socket); let text = '';
    connection.setTimeout(10000, () => connection.destroy(new Error('owned observer broker deadline')));
    connection.on('connect', () => connection.write(JSON.stringify(request) + '\n'));
    connection.on('data', data => { text += data; if (text.includes('\n')) { connection.destroy(); resolve(JSON.parse(text.split('\n')[0])); } });
    connection.on('error', reject);
  });
  const hello = await query({ op: 'hello' }); assert.equal(hello.terminal, terminal); assert.ok(Number.isInteger(hello.pid));
  const identity = identityOf(hello.pid); suite.ledger.update(l => l.processes.push({ ...identity, label: 'console-observer', group: false }));
  await waitFor('actual console observer output', async () => (await readFile(log)).length, length => length > 0, deadline(10000));
  assert.equal((await query({ op: 'input', pid: hello.pid, terminal, data: bytes })).ok, true);
  await suite.keepEvidence(log, 'console-observer.raw');
  await suite.hc(['kill', terminal, '--json']); await suite.hc(['rm', terminal, '--json']);
}
export { shellQuote, deadline, waitFor };
