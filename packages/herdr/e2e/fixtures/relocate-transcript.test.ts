// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { verifyRelocatedTranscript } from './relocate-transcript.js';

const original = Buffer.from('{"type":"session","version":3,"id":"session-1","cwd":"/source","timestamp":"2026-01-01"}\n{"type":"message","text":"héllo"}\n');
const arrived = Buffer.from('{"type":"session","version":3,"id":"session-1","cwd":"/destination","timestamp":"2026-01-01"}\n{"type":"message","text":"héllo"}\n');

describe('relocated transcript evidence', () => {
  it('accepts the same history bytes and the mapped cwd in an otherwise identical header', () => {
    expect(verifyRelocatedTranscript(original, arrived, 'session-1', '/source', '/destination')).toMatchObject({
      sessionId: 'session-1', sourceCwd: '/source', destinationCwd: '/destination', bodyBytes: Buffer.byteLength('{"type":"message","text":"héllo"}\n'),
    });
  });

  it('rejects altered, truncated and missing history bytes', () => {
    for (const candidate of [
      Buffer.from(arrived.toString().replace('héllo', 'hëllo')),
      arrived.subarray(0, arrived.length - 1),
      Buffer.from(arrived.toString().split('\n')[0] + '\n'),
    ]) expect(() => verifyRelocatedTranscript(original, candidate, 'session-1', '/source', '/destination')).toThrow();
  });

  it('rejects a different session ID, a wrong cwd and any other header change', () => {
    for (const candidate of [
      Buffer.from(arrived.toString().replace('session-1', 'session-2')),
      Buffer.from(arrived.toString().replace('/destination', '/other')),
      Buffer.from(arrived.toString().replace('2026-01-01', '2026-01-02')),
      Buffer.from(arrived.toString().replace('"version":3', '"version": 3')),
    ]) expect(() => verifyRelocatedTranscript(original, candidate, 'session-1', '/source', '/destination')).toThrow();
  });
});
