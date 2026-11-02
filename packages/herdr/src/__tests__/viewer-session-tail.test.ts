// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionTail } from '../viewers/session-tail.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(lines: unknown[]): string {
  const root = resolve('.spider/scratch/st', randomUUID()); mkdirSync(root, { recursive: true }); roots.push(root);
  const path = join(root, 'run.jsonl'); writeFileSync(path, lines.map(line => JSON.stringify(line) + '\n').join('')); return path;
}
const header = { type: 'session', version: 3, id: 's', timestamp: 't', cwd: '/work/project' };
const message = (n: number) => ({ type: 'message', id: `m${n}`, parentId: null, timestamp: 't', message: { role: 'user', content: `hello ${n}`, timestamp: n } });

test('reads complete records, then only appended ones, and holds back a partial line', () => {
  const path = file([header, message(1)]);
  const tail = new SessionTail(path);
  const first = tail.read();
  expect(first.entries.map(entry => (entry as { id?: string }).id)).toEqual(['s', 'm1']);
  expect(first.cwd).toBe('/work/project'); expect(first.truncatedHead).toBe(false);
  appendFileSync(path, JSON.stringify(message(2)) + '\n' + JSON.stringify(message(3)).slice(0, 20));
  expect(tail.read().entries.map(entry => (entry as { id: string }).id)).toEqual(['m2']);
  appendFileSync(path, JSON.stringify(message(3)).slice(20) + '\n');
  expect(tail.read().entries.map(entry => (entry as { id: string }).id)).toEqual(['m3']);
  expect(tail.read().entries).toEqual([]);
});

test('a large transcript opens at its tail, keeps the header cwd, and says the head was skipped', () => {
  const path = file([header, ...Array.from({ length: 2000 }, (_, n) => message(n))]);
  const tail = new SessionTail(path, { initialBytes: 16 * 1024 });
  const first = tail.read();
  expect(first.truncatedHead).toBe(true); expect(first.cwd).toBe('/work/project');
  const ids = first.entries.map(entry => (entry as { id: string }).id);
  expect(ids.at(-1)).toBe('m1999'); expect(ids.length).toBeLessThan(400); expect(ids).not.toContain('m0');
  // Every returned record is whole: the cut never yields a half line.
  expect(first.entries.every(entry => (entry as { type: string }).type === 'message')).toBe(true);
});

test('invalid records are skipped and counted, never thrown', () => {
  const path = file([header]); appendFileSync(path, '{not json\n' + JSON.stringify(message(1)) + '\n');
  const result = new SessionTail(path).read();
  expect(result.entries.map(entry => (entry as { id: string }).id)).toEqual(['s', 'm1']); expect(result.invalid).toBe(1);
});

test('a missing file reads as empty, and a symlink is refused', () => {
  const path = file([header]); const missing = join(path, '..', 'missing.jsonl');
  expect(new SessionTail(missing).read()).toMatchObject({ entries: [], missing: true });
  const link = join(path, '..', 'link.jsonl'); symlinkSync(path, link);
  expect(new SessionTail(link).read()).toMatchObject({ entries: [], missing: true });
});

test('oversized records are skipped across reads without losing the next complete message', () => {
  const path = file([header]); const tail = new SessionTail(path, { recordBytes: 65536 }); tail.read();
  appendFileSync(path, '{"type":"message","message":{"role":"user","content":"' + 'x'.repeat(70000));
  expect(tail.read().entries).toEqual([]);
  appendFileSync(path, 'x'.repeat(70000)); expect(tail.read().entries).toEqual([]);
  appendFileSync(path, '"}}\n' + JSON.stringify(message(42)) + '\n');
  const result = tail.read();
  expect(result.entries).toEqual([message(42)]);
  expect(result.invalid).toBe(1);
});

test('a replaced or truncated file restarts from its beginning', () => {
  const path = file([header, message(1), message(2)]); const tail = new SessionTail(path); tail.read();
  writeFileSync(path, JSON.stringify(header) + '\n' + JSON.stringify(message(9)) + '\n');
  const again = tail.read(); expect(again.reset).toBe(true);
  expect(again.entries.map(entry => (entry as { id: string }).id)).toEqual(['s', 'm9']);
});
