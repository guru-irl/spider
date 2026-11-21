// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHcClient } from '../../../herdr/src/client/hc.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { herdrErrorNotice } from '../../../herdr/src/notices.js';
import { shouldNotifyHerdrError } from '../herdr/notice-deduper.js';
import type { MachineName, TerminalAddress } from '../../../herdr/src/contracts.js';

const boundary = vi.hoisted(() => ({ modes: {} as Record<string, string> }));
vi.mock('../../../herdr/src/client/liveness.js', () => ({ requireCoreAvailable: async () => {} }));
vi.mock('../../../herdr/src/client/cli-transport.js', () => ({ invokeCli: async (_binary: string, args: string[]) => {
  if (args[0] === 'machine') return { machines: [1, 2].map(n => ({ id: `remote-core-${n}`, name: `box-${n}.invalid`, host: `box-${n}.invalid`, target: `box-${n}.invalid`, state: 'connected', session: 'fixture' })) };
  if (args[0] === 'get') return { address: args[1], labels: {}, parent: null, state: 'live', status: null, exit_code: null, finished_ms: null, reason: null, signal: null };
  if (args[0] === 'file' && args[1] === 'read') {
    const mode = boundary.modes[args[args.indexOf('--on') + 1]];
    if (mode === 'timeout') throw new HerdrError('cli-timeout', 'CLI request exceeded its deadline');
    if (mode === 'cli') throw new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr: 'connection lost' });
    if (mode === 'unavailable') throw new HerdrError('unavailable', 'Destination unavailable');
    return { text: 'fresh remote content' };
  }
  throw new Error('Unexpected request');
} }));
afterEach(() => { boundary.modes = {}; vi.useRealTimers(); });

type Session = { outages: Set<string>; messages: Map<string, number>; notices: string[] };
const session = (): Session => ({ outages: new Set(), messages: new Map(), notices: [] });
const client = (session: Session) => createHcClient({ binary: 'fixture', env: { HC_SOCKET: join(process.cwd(), '.spider/scratch/offline-fixture.sock'), HC_SESSION: 'fixture' } }, key => session.outages.delete(key));
function report(session: Session, error: unknown): void {
  if (shouldNotifyHerdrError(error, session.outages, session.messages, Date.now())) session.notices.push(herdrErrorNotice(error));
}

it('latches mixed failures independently until a real remote read succeeds in that session', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2026-01-01T00:00:00Z'), sessions = [session(), session()], clients = sessions.map(client);
  async function failedRead(index: number, machine: string): Promise<void> {
    const error = await clients[index].fileRead(machine as MachineName, '/home/fixture/input').then(() => null, caught => caught);
    expect(error).toBeInstanceOf(HerdrError); report(sessions[index], error);
  }
  try {
    for (let step = 0; step <= 30; step++) {
      vi.setSystemTime(start + step * 30_000);
      boundary.modes['box-1.invalid'] = ['timeout', 'cli', 'unavailable'][step % 3];
      boundary.modes['box-2.invalid'] = ['cli', 'unavailable', 'timeout'][step % 3];
      for (let i = 0; i < clients.length; i++) {
        await failedRead(i, 'box-1.invalid');
        if (step % 5 === 0) await failedRead(i, 'box-2.invalid');
        // A successful metadata query is not proof that the destination recovered.
        if (step === 10) await clients[i].get('box-1.invalid/t1' as TerminalAddress);
      }
    }
    for (const s of sessions) {
      expect(s.notices).toHaveLength(2);
      expect(s.notices.filter(text => text.includes('box-1.invalid'))).toHaveLength(1);
      expect(s.notices.filter(text => text.includes('box-2.invalid'))).toHaveLength(1);
      expect(s.notices.every(text => text.includes('keep trying') && text.includes('Local commands'))).toBe(true);
    }
    boundary.modes['box-1.invalid'] = 'success';
    expect((await clients[0].fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh remote content');
    boundary.modes['box-1.invalid'] = 'timeout';
    await failedRead(0, 'box-1.invalid'); await failedRead(1, 'box-1.invalid'); await failedRead(0, 'box-2.invalid');
    expect(sessions.map(s => s.notices.length)).toEqual([3, 2]);
    boundary.modes['box-1.invalid'] = 'success';
    await clients[1].fileRead('box-1.invalid' as MachineName, '/home/fixture/input');
    boundary.modes['box-1.invalid'] = 'cli';
    await failedRead(1, 'box-1.invalid');
    expect(sessions.map(s => s.notices.length)).toEqual([3, 3]);
  } finally { await Promise.all(clients.map(hc => hc.dispose())); }
});

it.each([
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'authentication failed' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'unrecognized argument --wrong' }),
  new HerdrError('invalid-reply', 'Malformed JSON'),
  new HerdrError('caller-mismatch', 'Wrong terminal identity'),
])('continues reporting non-connectivity failures after the ordinary throttle: $code', error => {
  const s = session(), start = Date.parse('2026-01-01T00:00:00Z');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start); report(s, error); report(s, error);
  vi.setSystemTime(start + 60_000); report(s, error);
  expect(s.notices).toHaveLength(2);
  expect(s.outages.size).toBe(0);
});
