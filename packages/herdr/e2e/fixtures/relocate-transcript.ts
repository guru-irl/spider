// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

export interface TranscriptEvidence {
  sessionId: string; sourceCwd: string; destinationCwd: string; bodyBytes: number; bodySha256: string;
}

/** v0 rewrites only the header cwd; every history byte must survive unchanged. */
export function verifyRelocatedTranscript(before: Buffer, after: Buffer, sessionId: string, sourceCwd: string, destinationCwd: string): TranscriptEvidence {
  const split = (bytes: Buffer) => {
    const newline = bytes.indexOf(10);
    assert.ok(newline > 0 && newline < bytes.length - 1, 'transcript has no header or history');
    const header = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline));
    return { header, fields: JSON.parse(header) as { id?: unknown; cwd?: unknown }, body: bytes.subarray(newline + 1) };
  };
  const source = split(before), destination = split(after);
  assert.equal(source.fields.id, sessionId, 'source session ID');
  assert.equal(destination.fields.id, sessionId, 'destination session ID');
  assert.equal(source.fields.cwd, sourceCwd, 'source cwd');
  assert.equal(destination.fields.cwd, destinationCwd, 'destination cwd');
  const matches = [...source.header.matchAll(/("cwd"\s*:\s*)("(?:\\.|[^"\\])*")/g)];
  assert.equal(matches.length, 1, 'source header needs one cwd value');
  const match = matches[0], start = match.index! + match[1].length;
  assert.equal(JSON.parse(match[2]), sourceCwd, 'source header cwd value');
  const expectedHeader = source.header.slice(0, start) + JSON.stringify(destinationCwd) + source.header.slice(start + match[2].length);
  assert.equal(destination.header, expectedHeader, 'header changed beyond the cwd value');
  assert.ok(source.body.equals(destination.body), 'transcript history bytes changed');
  return { sessionId, sourceCwd, destinationCwd, bodyBytes: source.body.length, bodySha256: createHash('sha256').update(source.body).digest('hex') };
}
