// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { paths } from '@spider/db-core';
import { buildViteFixture as build } from '../../../../scripts/test-fixture-build.js';
import { runPaneProxy, createPaneProxyTty, PROXY_TTY_PROGRAM, PROXY_RESET_MODES, type PaneProxyPorts, type ProxyInputGate } from '../panes/proxy.js';
import { parsePanePresentation } from '../panes/codec.js';
import type { PanePresentation, PaneTerminalFacts } from '../panes/types.js';
vi.mock('node:child_process', async original => { const actual = await original<typeof import('node:child_process')>(); return { ...actual, spawn: vi.fn(actual.spawn) }; });
function presentation(revision = 1): PanePresentation {
  return parsePanePresentation({ id: 'p1', revision, mode: 'proxy', role: 'shell', target: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.pane-operation': 'op1' }, alias: 'box-1.invalid', machineId: null, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null }, proxy: 'core-local/t8', slot: null, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
}
function fixture() {
  let binding: PanePresentation | null = presentation(); let listener: ((p: PanePresentation | null) => void) | null = null;
  const stop = new AbortController(); const order: string[] = []; const addresses: string[] = []; const delays: number[] = [];
  const ports: PaneProxyPorts = {
    readBinding: async () => binding,
    probe: vi.fn(async target => ({ terminal: { address: target.address, parent: null, labels: target.identityLabels, state: 'live' as const, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }, currentCwd: null, createdMs: target.createdMs, title: 'Target', app: null, status: null, identityLabels: target.identityLabels })),
    verifyAttachedCore: vi.fn(async () => { order.push('verify'); return true; }),
    attach: vi.fn(async (argv, _mode, _signal, gate) => { order.push('spawn'); addresses.push(argv.at(-1)!); gate.markAttached(); return { kind: 'stream-loss' as const, exitCode: 0 }; }),
    tty: { discardInput: vi.fn(async signal => { order.push('discard'); if (!signal.aborted) await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); }), flushInput: vi.fn(async () => { order.push('flush'); }), resetModes: vi.fn(async () => { order.push('reset'); }), releaseInput: vi.fn(async () => { order.push('release'); }), close: vi.fn(async () => {}) },
    watchBinding: (_id, cb) => { listener = cb; return () => { listener = null; }; },
    delay: vi.fn(async ms => { delays.push(ms); if (delays.length === 5) stop.abort(); }), clock: () => 0,
    status: vi.fn(async () => { order.push('status'); }), signal: stop.signal,
  };
  return { ports, order, addresses, delays, stop, change: (p: PanePresentation | null) => { binding = p; listener?.(p); } };
}
const input = { id: 'p1', bindingRoot: '/unused', hcBinary: '/owned/hc' };
test('packaged pty discards outage keys flushes queued input and observe never types', () => {
  const proof = String.raw`
import json, os, pty, select, subprocess, sys, time
m,s=pty.openpty(); cr,cw=os.pipe(); er,ew=os.pipe()
p=subprocess.Popen([sys.executable,'-c',os.environ['PROGRAM'],os.environ['RESET'],str(cr),str(ew)],stdin=s,stdout=s,stderr=s,pass_fds=(cr,ew))
os.close(cr);os.close(ew)
data=bytearray(); events=bytearray(); seq=0

def pump(until=None):
    end=time.monotonic()+3
    while time.monotonic()<end:
        for fd in select.select([m,er],[],[],.01)[0]:
            b=os.read(fd,65536)
            (data if fd==m else events).extend(b)
        if until is None or until in data:return
    raise RuntimeError('missing output '+str(until)+' '+repr(data))

def command(op,**kw):
    global seq
    seq+=1;os.write(cw,(json.dumps(dict(id=seq,op=op,**kw))+'\n').encode())
    end=time.monotonic()+3
    while time.monotonic()<end:
        pump()
        while b'\n' in events:
            line,_,rest=events.partition(b'\n');events[:]=rest
            event=json.loads(line)
            if event.get('id')==seq:
                if not event.get('ok'):raise RuntimeError(str(event))
                return
    raise RuntimeError('missing control acknowledgment')
try:
    command('discard');os.write(m,b'DISCARD-OUTAGE\r');command('flush')
    os.write(m,b'QUEUED-BEFORE-SPAWN\r');command('reset')
    child="import os;os.write(1,b'CANARY');exec('while True:\\n d=os.read(0,4096)\\n if not d: break\\n os.write(1,b\\\"INPUT:\\\"+d.hex().encode())')"
    command('spawn',argv=[sys.executable,'-c',child],observe=False)
    pump(b'CANARY');os.write(m,b'NOT-VERIFIED\r');command('release');os.write(m,b'FRESH\r')
    pump(b'46524553480d');command('reset');command('stop')
    command('reset');command('spawn',argv=[sys.executable,'-c',child],observe=True)
    command('release');os.write(m,b'OBSERVE-MUST-NOT-TYPE\r');command('flush');command('stop');command('reset')
    pump();print(json.dumps(dict(outputHex=data.hex())))
finally:
    os.close(cw);p.wait(timeout=2);os.close(er);os.close(m);os.close(s)
`;
  const result = spawnSync('/usr/bin/python3', ['-c', proof], { env: { ...process.env, PROGRAM: PROXY_TTY_PROGRAM, RESET: Buffer.from(PROXY_RESET_MODES).toString('hex') }, encoding: 'utf8', timeout: 4500 });
  expect(result.status, result.stderr).toBe(0);
  const output = Buffer.from(JSON.parse(result.stdout).outputHex, 'hex').toString();
  expect(output).toContain('46524553480d');
  for (const stale of ['DISCARD', 'QUEUED', 'NOT-VERIFIED', 'OBSERVE']) expect(output).not.toContain(Buffer.from(stale).toString('hex'));
  expect(output.split(PROXY_RESET_MODES).length - 1).toBe(4);
});
test('interactive proxy preserves tty and requests history', async () => {
  const f = fixture(); await runPaneProxy(input, f.ports);
  expect(vi.mocked(f.ports.attach).mock.calls[0]?.slice(0, 2)).toEqual([['/owned/hc', 'attach', '--history', '100', 'core-remote/t7'], 'interactive']);
  expect(f.order.indexOf('flush')).toBeLessThan(f.order.indexOf('spawn'));
  expect(f.order.indexOf('spawn')).toBeLessThan(f.order.indexOf('verify')); expect(f.order.indexOf('verify')).toBeLessThan(f.order.indexOf('release'));
});
test('ambiguous attach end reconnects never parks', async () => {
  const f = fixture(); await runPaneProxy(input, f.ports);
  expect(f.addresses).toEqual(Array(5).fill('core-remote/t7')); expect(f.delays).toEqual([1000, 2000, 5000, 10000, 10000]);
  expect(f.order.at(-1)).toBe('reset');
});
test('new binding retargets without a target launch and resets backoff', async () => {
  const f = fixture(); let calls = 0;
  vi.mocked(f.ports.attach).mockImplementation(async (argv, _mode, signal, gate) => {
    f.addresses.push(argv.at(-1)!); gate.markAttached(); calls++;
    if (calls === 2) {
      queueMicrotask(() => { const next = presentation(2); next.target = { ...next.target, terminalId: 't9' as never, address: 'core-remote/t9' as never, createdMs: 19 }; f.change(next); });
      await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); f.order.push('reaped');
    }
    if (calls === 4) f.stop.abort();
    return { kind: 'stream-loss', exitCode: 0 };
  });
  await runPaneProxy(input, f.ports);
  expect(f.addresses).toEqual(['core-remote/t7', 'core-remote/t7', 'core-remote/t9', 'core-remote/t9']); expect(f.delays).toEqual([1000, 1000]);
  expect(f.order).toContain('reaped');
});
test('binding deletion reaps the attached display without reconnecting', async () => {
  const f = fixture(); let deletionError: unknown;
  vi.mocked(f.ports.attach).mockImplementation(async (_argv, _mode, signal, gate) => {
    gate.markAttached(); queueMicrotask(() => { try { f.change(null); } catch (error) { deletionError = error; f.stop.abort(); } });
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    f.order.push('reaped'); return { kind: 'stream-loss', exitCode: 0 };
  });
  expect(await runPaneProxy(input, f.ports)).toBe(0);
  expect(deletionError).toBeUndefined();
  expect(f.order).toContain('reaped'); expect(f.delays).toEqual([]); expect(f.ports.attach).toHaveBeenCalledTimes(1);
});
test('alias moved to another core never attaches or releases input', async () => {
  const f = fixture(); vi.mocked(f.ports.probe).mockImplementation(async target => ({ terminal: { address: 'core-successor/t7', parent: null, labels: target.identityLabels, state: 'live' as const, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }, createdMs: 17 } as PaneTerminalFacts));
  await runPaneProxy(input, f.ports); expect(f.addresses).toEqual([]); expect(f.ports.tty.releaseInput).not.toHaveBeenCalled();
});
test('changed incarnation and unverified legacy target never attach', async () => {
  for (const bad of [0, 18]) {
    const f = fixture(); const p = presentation(); p.target.createdMs = bad; f.change(p);
    vi.mocked(f.ports.probe).mockResolvedValue({ terminal: { address: p.target.address, parent: null, labels: p.target.identityLabels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }, currentCwd: null, createdMs: 17, title: '', app: null, status: null, identityLabels: p.target.identityLabels });
    await runPaneProxy(input, f.ports); expect(f.addresses).toEqual([]);
  }
});
test('staged native conversion attaches remote destination never local source', async () => {
  const f = fixture(); const p = presentation(); const destination = p.target;
  p.mode = 'native'; p.target = { ...p.target, coreId: 'core-local' as never, address: 'core-local/t7' as never, alias: null };
  p.conversion = { state: 'waiting-focus', source: { space: 'space-1' as never, tab: 'tab-1' as never, pane: 'pane-1' as never }, sourceFocused: true, destination }; f.change(p);
  await runPaneProxy(input, f.ports); expect(f.addresses).toEqual(Array(5).fill('core-remote/t7'));
});
test('ready return to Mac discards input instead of attaching local or retired remote source', async () => {
  const f = fixture(); const p = presentation(); p.conversion = { state: 'waiting-focus', source: { space: 'space-1' as never, tab: 'tab-1' as never, pane: 'pane-1' as never }, sourceFocused: false, destination: { ...p.target, coreId: 'core-local' as never, address: 'core-local/t9' as never, terminalId: 't9' as never, alias: null } }; f.change(p);
  await runPaneProxy(input, f.ports); expect(f.addresses).toEqual([]); expect(f.ports.tty.releaseInput).not.toHaveBeenCalled(); expect(f.ports.status).toHaveBeenCalledWith('moved to This computer; focus to reconnect');
});
test('post-spawn core mismatch never releases input', async () => {
  const f = fixture(); vi.mocked(f.ports.verifyAttachedCore).mockResolvedValue(false);
  await runPaneProxy(input, f.ports); expect(f.ports.tty.releaseInput).not.toHaveBeenCalled();
});
test('verified target finish retires proxy without relaunch', async () => {
  const f = fixture(); vi.mocked(f.ports.probe).mockImplementation(async target => ({ terminal: { address: target.address, parent: null, labels: target.identityLabels, state: 'finished', status: null, exitCode: 0, reason: 'exited', signal: null, finishedAt: 1 }, currentCwd: null, createdMs: 17, title: '', app: null, status: null, identityLabels: target.identityLabels }));
  expect(await runPaneProxy(input, f.ports)).toBe(0); expect(f.addresses).toEqual([]);
});
test.each(['live', 'finished'] as const)('waiting launch ignores an older %s viewer binding and attaches only its replacement', async oldState => {
  const f = fixture(), old = presentation();
  old.proxyOperationId = 'previous-launch'; old.target = { ...old.target, kind: 'subagent', generation: 'gen-1' as never, sessionId: 'session-1' as never, runId: 'run-1' as never };
  f.change(old);
  const own = { ...old, revision: 4, proxyOperationId: 'next-launch', target: { ...old.target, terminalId: 't9' as never, address: 'core-remote/t9' as never, createdMs: 19 } };
  let turns = 0;
  vi.mocked(f.ports.delay).mockImplementation(async () => {
    turns++;
    if (turns === 1) f.change({ ...own, revision: 2, proxyOperationId: 'another-launch' });
    else if (turns === 2) f.change({ ...own, revision: 3, target: { ...own.target, generation: 'gen-other' as never } });
    else f.change(own);
    if (turns > 3) f.stop.abort();
  });
  const probe = vi.mocked(f.ports.probe).getMockImplementation()!;
  vi.mocked(f.ports.probe).mockImplementation(async target => { const facts = await probe(target); return target.terminalId === old.target.terminalId ? { ...facts, terminal: { ...facts.terminal, state: oldState } } : facts; });
  vi.mocked(f.ports.attach).mockImplementation(async (argv, _mode, _signal, gate) => { f.addresses.push(argv.at(-1)!); gate.markAttached(); f.stop.abort(); return { kind: 'stream-loss', exitCode: 0 }; });
  expect(await runPaneProxy({ ...input, waitingClaim: { operationId: 'next-launch', generation: 'gen-1' } }, f.ports)).toBe(0);
  expect(f.addresses).toEqual(['core-remote/t9']);
  expect(vi.mocked(f.ports.probe).mock.calls.map(([target]) => target.address)).toEqual(['core-remote/t9']);
  expect(turns).toBe(3);
});
test('a waiting proxy can be explicitly released before its own binding arrives', async () => {
  const f = fixture(); f.change(null);
  vi.mocked(f.ports.delay).mockImplementation(async () => { f.stop.abort(); });
  expect(await runPaneProxy({ ...input, waitingClaim: { operationId: 'own-launch', generation: 'gen-1' } }, f.ports)).toBe(0);
  expect(f.ports.probe).not.toHaveBeenCalled(); expect(f.ports.attach).not.toHaveBeenCalled();
});
test('waiting claim publication between initial read and watcher registration is not lost', async () => {
  const f = fixture(), own = presentation(2);
  own.proxyOperationId = 'own-launch'; own.target = { ...own.target, generation: 'gen-1' as never };
  const watch = f.ports.watchBinding;
  f.ports.watchBinding = (id, changed) => { f.change(own); return watch(id, changed); };
  vi.mocked(f.ports.attach).mockImplementation(async (argv, _mode, _signal, gate) => { f.addresses.push(argv.at(-1)!); gate.markAttached(); f.stop.abort(); return { kind: 'stream-loss', exitCode: 0 }; });
  expect(await runPaneProxy({ ...input, waitingClaim: { operationId: 'own-launch', generation: 'gen-1' } }, f.ports)).toBe(0);
  expect(f.addresses).toEqual(['core-remote/t7']);
});
test('an attached waiting proxy exits on its own proved finish without waiting for attach to close', async () => {
  const f = fixture(), own = presentation(2); own.proxyOperationId = 'own-launch'; own.target = { ...own.target, generation: 'gen-1' as never }; f.change(own);
  let probes = 0; const probe = vi.mocked(f.ports.probe).getMockImplementation()!;
  vi.mocked(f.ports.probe).mockImplementation(async target => { const facts = await probe(target); return { ...facts, terminal: { ...facts.terminal, state: ++probes >= 3 ? 'finished' : 'live' } }; });
  vi.mocked(f.ports.delay).mockImplementation(async () => { await Promise.resolve(); });
  vi.mocked(f.ports.attach).mockImplementation(async (_argv, _mode, signal, gate) => { gate.markAttached(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ kind: 'stream-loss', exitCode: 0 }), { once: true })); });
  const fallback = setTimeout(() => f.stop.abort(), 100);
  try { expect(await runPaneProxy({ ...input, waitingClaim: { operationId: 'own-launch', generation: 'gen-1' } }, f.ports)).toBe(0); }
  finally { clearTimeout(fallback); }
  expect(f.ports.status).toHaveBeenCalledWith('Program finished');
});
test('a waiting proxy exits when its own generation and operation binding finishes', async () => {
  const f = fixture(), own = presentation();
  own.proxyOperationId = 'own-launch'; own.target = { ...own.target, kind: 'subagent', generation: 'gen-1' as never, sessionId: 'session-1' as never, runId: 'run-1' as never }; f.change(own);
  const probe = vi.mocked(f.ports.probe).getMockImplementation()!;
  vi.mocked(f.ports.probe).mockImplementation(async target => { const facts = await probe(target); return { ...facts, terminal: { ...facts.terminal, state: 'finished' } }; });
  expect(await runPaneProxy({ ...input, waitingClaim: { operationId: 'own-launch', generation: 'gen-1' } }, f.ports)).toBe(0);
  expect(f.ports.attach).not.toHaveBeenCalled(); expect(f.ports.delay).not.toHaveBeenCalled();
});
test('console proxy is observe only and never releases typed input', async () => {
  const f = fixture(); const p = presentation(); p.target = { ...p.target, kind: 'console', sessionId: 'session-1' as never, generation: 'gen-1' as never, consoleId: 'console-1' as never }; f.change(p);
  await runPaneProxy(input, f.ports); expect(vi.mocked(f.ports.attach).mock.calls[0]?.[0]).toContain('--observe'); expect(f.ports.tty.releaseInput).not.toHaveBeenCalled();
});
test('proxy signal cancels and reaps only owned attach', async () => {
  const f = fixture(); vi.mocked(f.ports.attach).mockImplementation(async (_argv, _mode, signal, gate: ProxyInputGate) => { gate.markAttached(); queueMicrotask(() => f.stop.abort()); await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); f.order.push('reaped'); return { kind: 'stream-loss', exitCode: null }; });
  await runPaneProxy(input, f.ports); expect(f.order).toContain('reaped'); expect(f.order.at(-1)).toBe('reset');
});
test('packaged Node facade reaps its child and exits after real PTY loss', async () => {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'facade'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'p-'));
  try {
    const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve('packages/herdr/src/panes/proxy.ts'), formats: ['es'] }, rolldownOptions: { external: /^node:/ } } });
    const outputs = Array.isArray(result) ? result : [result]; const chunk = outputs.flatMap(r => 'output' in r ? r.output : []).find(c => c.type === 'chunk');
    if (!chunk || !('code' in chunk)) throw Error('missing bundled proxy'); await writeFile(join(root, 'proxy.mjs'), chunk.code);
    await writeFile(join(root, 'worker.mjs'), `import {createPaneProxyTty,OwnedProxyInputGate} from './proxy.mjs';import {writeFileSync} from 'node:fs';const driver=createPaneProxyTty();const life=new AbortController();const drain=driver.tty.discardInput(life.signal);const attachStop=new AbortController();try{await driver.tty.flushInput();const gate=new OwnedProxyInputGate();const attached=driver.attach([process.execPath,'-e','setInterval(()=>{},1000)'],'interactive',attachStop.signal,gate);await gate.ready;writeFileSync(process.argv[2],'ready');await attached;}finally{life.abort();attachStop.abort();await drain.catch(()=>{});await driver.close();}`);
    const proof = String.raw`
import os,pty,select,subprocess,sys,time
m,s=pty.openpty();ready=sys.argv[2]+'/ready';p=subprocess.Popen([sys.argv[1],sys.argv[2]+'/worker.mjs',ready],stdin=s,stdout=s,stderr=s)
os.close(s)
try:
    end=time.monotonic()+2
    while not os.path.exists(ready):
        if p.poll() is not None:raise RuntimeError('worker exited before attach')
        if time.monotonic()>end:raise RuntimeError('worker did not attach')
        select.select([],[],[],.01)
    os.close(m);m=None
    try:print(p.wait(timeout=1))
    except subprocess.TimeoutExpired:print('blocked')
finally:
    if m is not None:os.close(m)
    if p.poll() is None:p.terminate()
    try:p.wait(timeout=1)
    except subprocess.TimeoutExpired:p.kill();p.wait()
`;
    const proofResult = spawnSync('/usr/bin/python3', ['-c', proof, process.execPath, root], { encoding: 'utf8', timeout: 4500 });
    expect(proofResult.status, proofResult.stderr).toBe(0); expect(proofResult.stdout.trim()).toBe('0');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('tty worker exit closes extra pipes rather than waiting forever for close', async () => {
  const control = new PassThrough(); const events = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, control, events], kill: vi.fn() });
  const finish = () => { if (control.destroyed && events.destroyed) child.emit('close', 1); };
  control.on('close', finish); events.on('close', finish);
  control.on('data', bytes => { const request = JSON.parse(bytes.toString()); events.write(JSON.stringify({ id: request.id, ok: true }) + '\n'); });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const driver = createPaneProxyTty(); let done = false; const closing = driver.close().then(() => { done = true; });
  queueMicrotask(() => child.emit('exit', 1));
  try { await vi.waitFor(() => expect(done).toBe(true)); }
  finally { control.destroy(); events.destroy(); await closing; }
});
test('proxy completion closes its owned tty worker', async () => {
  const f = fixture(); await runPaneProxy(input, f.ports); expect(f.ports.tty.close).toHaveBeenCalledTimes(1);
});
test('binding-read failure resets modes and closes owned tty worker', async () => {
  const f = fixture(); f.ports.readBinding = async () => { throw Error('invalid binding'); };
  await expect(runPaneProxy(input, f.ports)).rejects.toThrow('invalid binding'); expect(f.ports.tty.resetModes).toHaveBeenCalled(); expect(f.ports.tty.close).toHaveBeenCalledTimes(1);
});
test('reset precedes every status including a retarget that writes no status', async () => {
  const f = fixture(); await runPaneProxy(input, f.ports);
  for (let i = 0; i < f.order.length; i++) if (f.order[i] === 'status') expect(f.order[i - 1]).toBe('reset');
});
