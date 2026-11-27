// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { assertRelocatedCopy } from './relocate-assertions.js';

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
