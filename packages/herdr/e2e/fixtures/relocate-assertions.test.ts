// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { assertNativeLaunch, assertRelocatedCopy } from './relocate-assertions.js';

const source = { cwd: '/fixture/source', file: '/fixture/hub/sessions/a.jsonl' };
const away = { cwd: '/fixture/destination/worktree', file: '/fixture/box/sessions/a.jsonl' };

describe('relocated placement evidence', () => {
  it('accepts distinct destination paths within the destination roots', () => {
    expect(() => assertRelocatedCopy(source, away, '/fixture/destination', '/fixture/box')).not.toThrow();
    expect(() => assertRelocatedCopy(away, source, '/fixture/source', '/fixture/hub')).not.toThrow();
  });

  it('rejects reused source paths and paths outside the destination roots in either direction', () => {
    for (const candidate of [
      { ...away, cwd: source.cwd }, { ...away, file: source.file },
      { ...away, cwd: '/fixture/destination-elsewhere/worktree' },
      { ...away, cwd: '/fixture/destination/../outside' },
      { ...away, file: '/fixture/box-elsewhere/a.jsonl' },
    ]) expect(() => assertRelocatedCopy(source, candidate, '/fixture/destination', '/fixture/box')).toThrow();
    for (const candidate of [{ ...source, cwd: away.cwd }, { ...source, file: away.file },
      { ...source, cwd: '/fixture/other' }, { ...source, file: '/fixture/other/a.jsonl' }]) {
      expect(() => assertRelocatedCopy(away, candidate, '/fixture/source', '/fixture/hub')).toThrow();
    }
  });
});

describe('native launch evidence', () => {
  const launch = ['/usr/bin/env', 'PATH=/bin', '/fixture/pi', '--session', away.file];
  const record = { namespace: 'd', argv: ['run', '--json', '--cwd', away.cwd, '--label', 'spider.session=s1',
    '--label', 'spider.machine=box', '--label', 'spider.roam.epoch=3', '--', ...launch] };
  const check = (native: unknown, records = [record], placement = away) =>
    assertNativeLaunch(native, records, placement, 'd', 's1', 'box', 3);

  it('accepts a native response that exactly matches the recorded launch', () => {
    expect(() => check({ cwd: away.cwd, argv: launch })).not.toThrow();
  });

  it('rejects a changed cwd, any changed argv element, and a wrong reply placement', () => {
    expect(() => check({ cwd: `${away.cwd}/`, argv: launch })).toThrow();
    expect(() => check({ cwd: away.cwd, argv: ['/usr/bin/env', 'PATH=/other', ...launch.slice(2)] })).toThrow();
    expect(() => check({ cwd: away.cwd, argv: launch.slice(0, -1) })).toThrow();
    expect(() => check({ cwd: away.cwd, argv: launch }, [record], { ...away, file: '/other.jsonl' })).toThrow();
    expect(() => check({ cwd: away.cwd, argv: launch }, [record], { ...away, cwd: '/other' })).toThrow();
  });

  it('requires exactly one matching recorded session, machine, epoch and core', () => {
    expect(() => check({ cwd: away.cwd, argv: launch }, [])).toThrow();
    expect(() => check({ cwd: away.cwd, argv: launch }, [{ ...record, namespace: 'l' }])).toThrow();
    expect(() => check({ cwd: away.cwd, argv: launch }, [record, record])).toThrow();
  });
});
