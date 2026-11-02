// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';

function ports(calls: unknown[]): HerdrCliPorts & { out: string[] } {
  const out: string[] = [];
  return {
    out, stdout: text => { out.push(text); }, stderr: text => { out.push(text); },
    request: async () => { throw new Error('memory review needs no setup request'); },
    setupParts: async () => { throw new Error('unused'); }, doctorParts: async () => { throw new Error('unused'); },
    memoryReview: {
      list: repoKeys => { calls.push(['list', repoKeys]); return { ok: true, op: 'pending', items: [], unavailable: [] }; },
      decide: (op, target) => { calls.push([op, target]); return { ok: true, op, uuid: target.uuid }; },
    },
  };
}

describe('memory review CLI', () => {
  test('lists pending memories for the given repos as one JSON line', async () => {
    const calls: unknown[] = [], p = ports(calls);
    expect(await runHerdrCli(['memory', 'pending', '--repo', '/fixture/alpha/.git', '--repo', '/fixture/beta/.git'], p)).toBe(0);
    expect(calls).toEqual([['list', ['/fixture/alpha/.git', '/fixture/beta/.git']]]);
    expect(p.out).toEqual([JSON.stringify({ ok: true, op: 'pending', items: [], unavailable: [] }) + '\n']);
  });
  test('approves a global memory and rejects a repo memory', async () => {
    const calls: unknown[] = [], p = ports(calls);
    expect(await runHerdrCli(['memory', 'approve', '--scope', 'global', '--uuid', 'u1'], p)).toBe(0);
    expect(await runHerdrCli(['memory', 'reject', '--scope', 'repo', '--repo', '/fixture/alpha/.git', '--uuid', 'u2'], p)).toBe(0);
    expect(calls).toEqual([['approve', { scope: 'global', repoKey: null, uuid: 'u1' }], ['reject', { scope: 'repo', repoKey: '/fixture/alpha/.git', uuid: 'u2' }]]);
  });
  test('a refused decision exits 1 with its reason', async () => {
    const p = ports([]);
    p.memoryReview!.decide = () => ({ ok: false, code: 'not-pending', message: 'This memory is no longer waiting for review.' });
    expect(await runHerdrCli(['memory', 'approve', '--scope', 'global', '--uuid', 'u1'], p)).toBe(1);
    expect(JSON.parse(p.out[0]!)).toEqual({ ok: false, code: 'not-pending', message: 'This memory is no longer waiting for review.' });
  });
  test.each([
    [['memory', 'approve', '--scope', 'repo', '--uuid', 'u1']],
    [['memory', 'approve', '--scope', 'global', '--repo', '/fixture/alpha/.git', '--uuid', 'u1']],
    [['memory', 'reject', '--scope', 'team', '--uuid', 'u1']],
    [['memory', 'approve', '--scope', 'global']],
    [['memory', 'pending', '--repo', 'relative/.git']],
    [['memory', 'forget', '--scope', 'global', '--uuid', 'u1']],
  ])('rejects bad arguments %j with a usage reply', async argv => {
    const calls: unknown[] = [], p = ports(calls);
    expect(await runHerdrCli(argv, p)).toBe(2);
    expect(calls).toEqual([]);
    expect(JSON.parse(p.out[0]!)).toMatchObject({ ok: false, code: 'cli-usage' });
  });
});
