// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { InteractiveDriver, ObservedEvent, PiDriver, RpcDriver } from '../harness/pi.js';
import { identityAlive } from '../harness/resources.js';
import { deadline, waitFor, type Deadline } from '../harness/wait.js';

export type RpcReplacement = { kind: 'new' } | { kind: 'resume'; sessionFile: string } | { kind: 'fork'; entryId: string };
export interface RpcSessionState { sessionId: string; sessionFile: string | null }
async function rpcSessionState(pi: RpcDriver, limit: Deadline): Promise<RpcSessionState> {
  const data = (await pi.rpc({ type: 'get_state' }, limit)).data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
  if (!data || typeof data.sessionId !== 'string' || (data.sessionFile !== null && typeof data.sessionFile !== 'string')) throw new Error('invalid RPC session state');
  return { sessionId: data.sessionId, sessionFile: data.sessionFile };
}
/** Use actual pi RPC session commands; callers assert their own ownership effects. */
export async function replaceRpcSession(pi: RpcDriver, replacement: RpcReplacement, limit: Deadline = deadline(60_000)): Promise<{ before: RpcSessionState; after: RpcSessionState; response: Record<string, unknown> }> {
  const before = await rpcSessionState(pi, limit);
  const command = replacement.kind === 'new' ? { type: 'new_session' }
    : replacement.kind === 'resume' ? { type: 'switch_session', sessionPath: replacement.sessionFile }
    : { type: 'fork', entryId: replacement.entryId };
  const response = await pi.rpc(command, limit);
  return { before, after: await rpcSessionState(pi, limit), response };
}
async function interactiveSessionCommand(pi: InteractiveDriver, command: '/reload' | '/new', reason: 'reload' | 'new', limit: Deadline): Promise<ObservedEvent> {
  const previous = await pi.events();
  await pi.prompt(command);
  const events = await waitFor(`interactive ${command} session_start`, () => pi.events(), list => list.slice(previous.length).some(e => e.type === 'session_start' && e.reason === reason), limit);
  return events.slice(previous.length).find(e => e.type === 'session_start' && e.reason === reason)!;
}
/** Send actual TUI commands through the broker, then wait for pi's public lifecycle event. */
export function reloadInteractive(pi: InteractiveDriver, limit: Deadline = deadline(60_000)): Promise<ObservedEvent> {
  return interactiveSessionCommand(pi, '/reload', 'reload', limit);
}
export function newInteractive(pi: InteractiveDriver, limit: Deadline = deadline(60_000)): Promise<ObservedEvent> {
  return interactiveSessionCommand(pi, '/new', 'new', limit);
}
/** Search the real /resume selector and refuse a different selected session. */
export async function resumeInteractive(pi: InteractiveDriver, target: { name: string; sessionId: string }, limit: Deadline = deadline(60_000)): Promise<ObservedEvent> {
  if (!target.name.trim() || /[\x00-\x1f\x7f]/.test(target.name) || !target.sessionId) throw new Error('invalid resume selector');
  const previous = await pi.events(), offset = (await pi.rawOutput()).length;
  await pi.prompt('/resume');
  await waitFor('resume selector lists the target', async () => (await pi.rawOutput()).subarray(offset).toString('utf8'),
    text => text.includes('Resume Session') && text.includes(target.name), limit);
  await pi.key(target.name);
  await waitFor('resume selector shows the search', async () => (await pi.rawOutput()).subarray(offset).toString('utf8'),
    text => text.lastIndexOf(target.name) > text.indexOf('Resume Session'), limit);
  await pi.key('\r');
  const events = await waitFor('interactive resume session_start', () => pi.events(), rows => rows.slice(previous.length).some(event => event.type === 'session_start' && event.reason === 'resume'), limit);
  const selected = events.slice(previous.length).find(event => event.type === 'session_start' && event.reason === 'resume')!;
  if (selected.sessionId !== target.sessionId) throw new Error('resume selector chose a different session');
  return selected;
}
/** Select the most recent user message in the real /fork selector. */
export async function forkInteractive(pi: InteractiveDriver, limit: Deadline = deadline(60_000)): Promise<ObservedEvent> {
  const previous = await pi.events(), offset = (await pi.rawOutput()).length;
  await pi.prompt('/fork');
  await waitFor('fork selector displayed', async () => (await pi.rawOutput()).subarray(offset).toString('utf8'), text => text.includes('Fork from Message'), limit);
  await pi.key('\r');
  const events = await waitFor('interactive fork session_start', () => pi.events(), rows => rows.slice(previous.length).some(event => event.type === 'session_start' && event.reason === 'fork'), limit);
  return events.slice(previous.length).find(event => event.type === 'session_start' && event.reason === 'fork')!;
}
/** Only signal the exact owned PID/start identity recorded by the foundation. */
export async function signalPi(pi: PiDriver, signal: 'SIGTERM' | 'SIGKILL', limit: Deadline = deadline(30_000)): Promise<ObservedEvent[]> {
  if (!identityAlive(pi.identity)) throw new Error('owned pi is not alive');
  process.kill(pi.pid, signal);
  await waitFor(`${signal} reaches owned pi`, () => identityAlive(pi.identity), alive => !alive, limit);
  return pi.events();
}
/** A TUI receives /quit; an RPC client closes stdin. Neither operation invents a shutdown reason. */
export async function quitPi(pi: InteractiveDriver | RpcDriver, limit: Deadline = deadline(30_000)): Promise<ObservedEvent[]> {
  if (!identityAlive(pi.identity)) throw new Error('owned pi is not alive');
  if (pi.mode === 'rpc') await pi.close();
  else {
    await pi.prompt('/quit');
    await waitFor('interactive pi quit', () => identityAlive(pi.identity), alive => !alive, limit);
  }
  const events = await pi.events();
  if (!events.some(event => event.type === 'session_shutdown' && event.reason === 'quit')) throw new Error('pi exited without an observed quit event');
  return events;
}
