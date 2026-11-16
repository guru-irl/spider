// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { HerdrError } from '../client/parse.js';
import type { PanePresentation, PaneTarget, PaneTerminalFacts } from './types.js';
export interface PaneProxyInput { id: string; bindingRoot: string; hcBinary: string; waitingClaim?: { operationId: string; generation: string } }
export interface AttachEnd { kind: 'proved-detach' | 'stream-loss'; exitCode: number | null }
export interface ProxyInputGate {
  readonly ready: Promise<void>;
  markAttached(): void;
  fail(error: unknown): void;
}
export class OwnedProxyInputGate implements ProxyInputGate {
  readonly ready: Promise<void>;
  private resolve!: () => void; private reject!: (error: unknown) => void;
  constructor() { this.ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); void this.ready.catch(() => {}); }
  markAttached(): void { this.resolve(); }
  fail(error: unknown): void { this.reject(error); }
}
export interface ProxyTtyPorts {
  discardInput(signal: AbortSignal): Promise<void>;
  flushInput(): Promise<void>;
  resetModes(): Promise<void>;
  releaseInput(gate: ProxyInputGate): Promise<void>;
  close(): Promise<void>;
}
export interface PaneProxyPorts {
  readBinding(id: string): Promise<PanePresentation | null>;
  probe(target: PaneTarget): Promise<PaneTerminalFacts>;
  verifyAttachedCore(target: PaneTarget): Promise<boolean>;
  attach(argv: readonly string[], mode: 'interactive' | 'observe', signal: AbortSignal, input: ProxyInputGate): Promise<AttachEnd>;
  tty: ProxyTtyPorts;
  watchBinding(id: string, changed: (presentation: PanePresentation | null) => void): () => void;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  clock(): number;
  status?(text: string): Promise<void>;
  signal?: AbortSignal;
}
export const PROXY_RESET_MODES = '\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[0m';
function matches(target: PaneTarget, facts: PaneTerminalFacts): boolean {
  return target.createdMs > 0 && facts.terminal.address === `${target.coreId}/${target.terminalId}` && facts.createdMs === target.createdMs &&
    Object.keys(target.identityLabels).length > 0 && Object.entries(target.identityLabels).every(([key, value]) => facts.identityLabels[key] === value) &&
    (target.kind === 'terminal' || target.generation !== null);
}
export async function runPaneProxy(input: PaneProxyInput, ports: PaneProxyPorts): Promise<number> {
  const stop = new AbortController(); const onSignal = () => stop.abort();
  if (ports.signal?.aborted) stop.abort(); ports.signal?.addEventListener('abort', onSignal, { once: true });
  if (!ports.signal) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGHUP', onSignal); }
  let binding: PanePresentation | null = null; let retry = 0; let active: AbortController | null = null;
  let claimBound = !input.waitingClaim;
  const acceptBinding = (next: PanePresentation | null) => {
    if (input.waitingClaim && (!next || next.id !== input.id || next.proxyOperationId !== input.waitingClaim.operationId || next.target.generation !== input.waitingClaim.generation)) {
      if (claimBound && (!next || !binding || next.revision > binding.revision)) { binding = null; active?.abort(); }
      return;
    }
    if (!next || !binding || next.revision > binding.revision) { binding = next; claimBound = true; retry = 0; active?.abort(); }
  };
  let unwatch: () => void = () => {};
  const reset = () => ports.tty.resetModes();
  const status = async (text: string) => { await reset(); await ports.status?.(text); };
  let discard: Promise<void> | null = null;
  try {
    if (!isAbsolute(input.hcBinary)) throw new HerdrError('invalid-proxy-binary', 'Proxy requires an absolute hc executable');
    binding = await ports.readBinding(input.id);
    if (input.waitingClaim) { const initial = binding; binding = null; acceptBinding(initial); }
    unwatch = ports.watchBinding(input.id, acceptBinding);
    if (input.waitingClaim) acceptBinding(await ports.readBinding(input.id));
    discard = ports.tty.discardInput(stop.signal); void discard.catch(() => stop.abort());
    while (!stop.signal.aborted) {
      if (!claimBound) {
        try { await ports.delay(25, stop.signal); } catch (error) { if (!stop.signal.aborted) throw error; }
        continue;
      }
      if (!binding || binding.visibility !== 'visible') return 0;
      const current = binding;
      const conversion = current.conversion?.state === 'waiting-focus' ? current.conversion : null;
      if (current.mode === 'native' && !conversion) return 0;
      const gated = current.mode === 'proxy' && !!conversion || current.mode === 'native' && (!current.proxy || conversion?.destination.coreId === current.target.coreId);
      const target = current.mode === 'native' && conversion ? conversion.destination : current.target;
      active = new AbortController(); const cancel = () => active?.abort(); stop.signal.addEventListener('abort', cancel, { once: true });
      let attached: Promise<AttachEnd> | null = null, completion: Promise<boolean> | null = null;
      try {
        if (gated) {
          await status(current.mode === 'proxy' ? 'moved to This computer; focus to reconnect' : `Opening presentation on ${target.alias ?? 'Machine unavailable'}`);
        } else {
          const facts = await ports.probe(target);
          if (!matches(target, facts)) throw new HerdrError('target-changed', 'Execution target identity changed');
          if (facts.terminal.state === 'finished') { await status('Program finished'); return 0; }
          if (active.signal.aborted || binding?.revision !== current.revision) continue;
          await reset(); await ports.tty.flushInput();
          const gate = new OwnedProxyInputGate();
          const mode = target.kind === 'console' ? 'observe' : 'interactive';
          const argv = [input.hcBinary, 'attach', '--history', '100', ...(mode === 'observe' ? ['--observe'] : []), `${target.coreId}/${target.terminalId}`];
          attached = ports.attach(argv, mode, active.signal, gate);
          void attached.catch(error => gate.fail(error));
          await Promise.race([gate.ready, attached.then(() => { throw new HerdrError('attach-ended', 'Attach ended before input verification'); })]);
          if (!active.signal.aborted && binding?.revision === current.revision) {
            if (!await ports.verifyAttachedCore(target)) throw new HerdrError('core-mismatch', 'Attached core does not match the execution target');
            // Recheck incarnation after spawn as well as the selected core.
            if (!matches(target, await ports.probe(target))) throw new HerdrError('target-changed', 'Execution target changed after attach');
            if (!active.signal.aborted && binding?.revision === current.revision && mode === 'interactive') await ports.tty.releaseInput(gate);
          }
          if (input.waitingClaim) {
            const signal = active.signal;
            completion = (async () => {
              while (!signal.aborted) {
                await ports.delay(1000, signal); if (signal.aborted) break;
                let observed: PaneTerminalFacts; try { observed = await ports.probe(target); } catch { continue; }
                if (!matches(target, observed)) throw new HerdrError('target-changed', 'Execution target changed during attach');
                if (observed.terminal.state === 'finished') return true;
              }
              return false;
            })();
            if (await Promise.race([attached.then(() => false), completion])) { await status('Program finished'); return 0; }
          } else await attached;
          // No authenticated detach marker is proved, including exit code zero.
        }
      } catch (error) {
        if (stop.signal.aborted) break;
        if (binding?.revision === current.revision && !active.signal.aborted) await status(`${target.alias ?? 'Machine unavailable'}: reconnecting`);
      } finally {
        active.abort(); if (attached) await attached.catch(() => {}); await completion?.catch(() => false);
        // The packaged attach cancellation closes the gate and reaps its child.
        await reset(); stop.signal.removeEventListener('abort', cancel);
      }
      if (binding?.revision !== current.revision) continue;
      if (stop.signal.aborted) break;
      active = new AbortController(); const cancelDelay = () => active?.abort(); stop.signal.addEventListener('abort', cancelDelay, { once: true });
      try { await ports.delay([1000, 2000, 5000, 10000][Math.min(retry++, 3)], active.signal); }
      catch (error) { if (!active.signal.aborted) throw error; }
      finally { stop.signal.removeEventListener('abort', cancelDelay); }
    }
    return 0;
  } finally {
    stop.abort(); active?.abort(); unwatch();
    try { await discard?.catch(() => {}); await reset(); }
    finally {
      try { await ports.tty.close(); }
      finally {
        ports.signal?.removeEventListener('abort', onSignal);
        if (!ports.signal) { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGHUP', onSignal); }
      }
    }
  }
}
/** Python's stdlib supplies PTYs and tcflush; absence fails closed, never inherits unguarded input. */
export const PROXY_TTY_PROGRAM: string = String.raw`
import errno, fcntl, json, os, pty, select, signal, subprocess, sys, termios, tty
reset=bytes.fromhex(sys.argv[1]); control=int(sys.argv[2]); events=int(sys.argv[3])
original=termios.tcgetattr(0); tty.setraw(0)
child=None; master=None; forwarding=False; observe=False; buffered=b''
def event(value): os.write(events,(json.dumps(value)+'\n').encode())
def close_child():
    global child,master,forwarding
    forwarding=False
    if child is not None:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=1)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        event(dict(event='end',exitCode=child.returncode))
        child=None
    if master is not None: os.close(master); master=None

def resize(*args):
    if master is not None and not observe:
        fcntl.ioctl(master,termios.TIOCSWINSZ,fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
signal.signal(signal.SIGWINCH,resize)
def session():
    os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
try:
    while True:
        ready=select.select([0,control]+([] if master is None else [master]),[],[],.05)[0]
        # Drain input first even when a release command arrives in the same batch.
        if 0 in ready:
            data=os.read(0,65536)
            if not data:break
            if forwarding and master is not None and not observe: os.write(master,data)
        if master is not None and master in ready:
            try:
                data=os.read(master,65536)
                if data:os.write(1,data)
            except OSError as e:
                if e.errno != errno.EIO:raise
        if child is not None and child.poll() is not None:close_child()
        if control in ready:
            data=os.read(control,65536)
            if not data:break
            buffered+=data
            while b'\n' in buffered:
                line,buffered=buffered.split(b'\n',1);c=json.loads(line)
                try:
                    op=c['op']
                    if op=='discard':forwarding=False
                    elif op=='flush':termios.tcflush(0,termios.TCIFLUSH)
                    elif op=='reset':os.write(1,reset)
                    elif op=='release':
                        termios.tcflush(0,termios.TCIFLUSH)
                        forwarding=child is not None and not observe
                    elif op=='stop':close_child()
                    elif op=='spawn':
                        close_child(); forwarding=False;observe=c['observe']
                        termios.tcflush(0,termios.TCIFLUSH)
                        master,slave=pty.openpty();tty.setraw(slave);resize()
                        try:child=subprocess.Popen(c['argv'],stdin=slave,stdout=slave,stderr=slave,preexec_fn=session)
                        finally:os.close(slave)
                    else:raise RuntimeError('unknown gate operation')
                    event(dict(id=c['id'],ok=True))
                except Exception as e:event(dict(id=c['id'],ok=False,error=str(e)))
finally:
    close_child();termios.tcflush(0,termios.TCIFLUSH);os.write(1,reset);termios.tcsetattr(0,termios.TCSANOW,original)
`;
export interface PackagedProxyTty {
  tty: ProxyTtyPorts;
  attach: PaneProxyPorts['attach'];
  close(): Promise<void>;
}
export function createPaneProxyTty(options: { pythonBinary?: string; inputFd?: number; outputFd?: number; env?: NodeJS.ProcessEnv } = {}): PackagedProxyTty {
  // Node's lazy TTY wrappers can block opening a disconnected terminal during pipe shutdown.
  // Initialize them while the inherited terminal is still present.
  void process.stdout; void process.stderr;
  const helper = spawn(options.pythonBinary ?? '/usr/bin/python3', ['-c', PROXY_TTY_PROGRAM, Buffer.from(PROXY_RESET_MODES).toString('hex'), '3', '4'], { env: options.env ?? process.env, stdio: [options.inputFd ?? 0, options.outputFd ?? 1, 2, 'pipe', 'pipe'] });
  const controlStream = helper.stdio[3]; const eventStream = helper.stdio[4];
  if (!(controlStream instanceof Writable) || !(eventStream instanceof Readable)) throw new HerdrError('tty-unavailable', 'TTY gate pipes unavailable');
  const control: Writable = controlStream; const events: Readable = eventStream;
  let sequence = 0; let buffer = ''; let ended = false; let gate: ProxyInputGate | null = null;
  const replies = new Map<number, { resolve(): void; reject(error: unknown): void }>();
  let attachment: { resolve(end: AttachEnd): void; reject(error: unknown): void } | null = null;
  const rejectAttachment = (error: unknown) => attachment?.reject(error);
  const fail = (error: unknown) => { ended = true; for (const reply of replies.values()) reply.reject(error); replies.clear(); gate?.fail(error); attachment?.reject(error); attachment = null; };
  helper.on('error', fail); control.on('error', fail); events.on('error', fail);
  helper.once('exit', () => {
    fail(new HerdrError('tty-ended', 'Owned TTY gate exited'));
    // Extra stdio sockets do not close automatically while their readable side is paused.
    control.destroy(); events.destroy();
  });
  const closed = new Promise<void>(resolve => helper.once('close', () => { fail(new HerdrError('tty-ended', 'Owned TTY gate exited')); resolve(); }));
  events.on('data', chunk => {
    buffer += chunk.toString(); if (buffer.length > 65536) { fail(new HerdrError('tty-protocol', 'TTY gate reply exceeds limit')); helper.kill('SIGTERM'); return; }
    for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const event = JSON.parse(line);
        if (event.event === 'end') { attachment?.resolve({ kind: 'stream-loss', exitCode: typeof event.exitCode === 'number' ? event.exitCode : null }); attachment = null; gate = null; }
        else { const reply = replies.get(event.id); replies.delete(event.id); if (event.ok === true) reply?.resolve(); else reply?.reject(new HerdrError('tty-refused', String(event.error))); }
      } catch (error) { fail(error); helper.kill('SIGTERM'); }
    }
  });
  function command(op: string, value: Record<string, unknown> = {}): Promise<void> {
    if (ended) return Promise.reject(new HerdrError('tty-ended', 'TTY gate unavailable'));
    const id = ++sequence; return new Promise((resolve, reject) => { replies.set(id, { resolve, reject }); control.write(`${JSON.stringify({ id, op, ...value })}\n`, error => { if (error) { replies.delete(id); reject(error); } }); });
  }
  async function close(): Promise<void> { if (!ended) { await command('stop').catch(() => {}); control.end(); } await closed; }
  return {
    tty: {
      close,
      async discardInput(signal) { await command('discard'); if (!signal.aborted) await Promise.race([closed, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]); },
      flushInput: () => command('flush'), resetModes: () => command('reset'),
      async releaseInput(input) { if (input !== gate) throw new HerdrError('tty-gate-mismatch', 'Input gate does not own this attach'); await input.ready; await command('release'); },
    },
    async attach(argv, mode, signal, input) {
      if (attachment) throw new HerdrError('tty-occupied', 'TTY gate already owns an attach');
      if (signal.aborted) throw new HerdrError('aborted', 'Attach cancelled');
      gate = input;
      const result = new Promise<AttachEnd>((resolve, reject) => { attachment = { resolve, reject }; }); void result.catch(() => {});
      const abort = () => { void command('stop').catch(error => attachment?.reject(error)); };
      signal.addEventListener('abort', abort, { once: true });
      try { await command('spawn', { argv, observe: mode === 'observe' }); input.markAttached(); if (signal.aborted) abort(); return await result; }
      catch (error) { input.fail(error); rejectAttachment(error); throw error; }
      finally { signal.removeEventListener('abort', abort); await command('discard').catch(() => {}); gate = null; }
    },
    close,
  };
}
