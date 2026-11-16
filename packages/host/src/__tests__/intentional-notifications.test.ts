// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, bus, openDbAt, paths, setGlobalDbPathForTests } from '@spider/db-core';
import * as mountModule from '../herdr/mount.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import type { RunId, SessionId } from '../../../herdr/src/contracts.js';
import { readNotifications, storeNotification } from '../notifications/store.js';
import spiderExtension, { SPIDER_PARAMETERS } from '../extension.js';
import { withPiEvents, hostUnitPorts } from './fixtures/pi-events.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(child = false) {
  const scratch = join(paths.scratch('worktree', process.cwd()), 'intentional-notices'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root); execFileSync('git', ['init', '-q', root]);
  setGlobalDbPathForTests(join(root, 'global.db'));
  vi.stubEnv('PI_SUBAGENT_CHILD', child ? '1' : '0');
  const appLaunches = vi.fn(), queue = vi.fn((_session: string): boolean => false);
  vi.spyOn(mountModule, 'mountHerdr').mockReturnValue({ enabled: () => false, owner: () => null, queueNotification: queue,
    execution: () => ({ environmentPolicy: (env: unknown) => env }), guard: async () => undefined, dispose: async () => {} } as never);
  const tools: any[] = [], hooks = new Map<string, Function[]>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool: (tool: any) => tools.push(tool), registerCommand() {}, sendMessage: appLaunches };
  const ctx = { cwd: root, mode: 'rpc', hasUI: false, ui: { notify: appLaunches }, sessionManager: { getSessionId: () => 'parent-session', getSessionFile: () => undefined } };
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  const tool = tools.find(item => item.name === 'spider')!;
  const call = (id: string, args: Record<string, unknown>, context = ctx) => tool.execute(id, { action: 'notify', ...args }, undefined, undefined, context);
  const db = () => openDbAt(join(root, '.spider', 'project.db'), 'worktree');
  return { root, tool, call, ctx, db, hooks, appLaunches, queue };
}

it('stores with no app and no Herdr activation', async () => {
  const f = fixture();
  const result = await f.call('call-1', { message: 'Choose a fix' });
  expect(result.details).toMatchObject({ ok: true, presentation: 'stored' });
  expect(f.appLaunches).not.toHaveBeenCalled();
  const db = f.db();
  try { expect(db.prepare("SELECT phase, tool FROM events WHERE session_id=?").all('parent-session')).toEqual([{ phase: 'after', tool: 'notify' }]); }
  finally { db.close(); }
});

it('stores a distinct occurrence for each call even when the provider reuses its ID', async () => {
  const f = fixture();
  const first = await f.call('call-1', { message: 'Choose a fix' });
  const again = await f.call('call-1', { message: 'Choose a fix' });
  const second = await f.call('call-1', { message: 'Choose another fix' });
  expect(again.details.id).not.toBe(first.details.id); expect(second.details.id).not.toBe(again.details.id);
  const db = f.db();
  try { expect(db.prepare("SELECT id FROM events WHERE session_id=? AND tool='notify'").all('parent-session')).toHaveLength(3); }
  finally { db.close(); }
});

it('removes bidirectional and line separator controls from stored text', async () => {
  const f = fixture();
  await f.call('bidi', { message: 'start\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u2028\u2029end' });
  const db = f.db();
  try {
    const rows = readNotifications(db, 'parent-session' as SessionId, Date.now());
    expect(rows[0].message).toMatch(/^start\s+end$/);
    expect(rows[0].message).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
  } finally { db.close(); }
});

it('explains why nested and inaccessible remote subagents cannot notify', async () => {
  const f = fixture(true);
  vi.stubEnv('PI_SPIDER_SESSION_ID', 'child-session'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'parent-session');
  vi.stubEnv('PI_SUBAGENT_RUN_ID', 'nested'); vi.stubEnv('PI_SPIDER_DB_PATH', join(f.root, 'missing.db'));
  await expect(f.call('nested', { message: 'Choose a fix' })).rejects.toThrow(/nested or remote subagents/i);
  vi.stubEnv('PI_SPIDER_SESSION_ID', 'parent-session');
  await expect(f.call('remote', { message: 'Choose a fix' })).rejects.toThrow(/nested or remote subagents/i);
  vi.stubEnv('PI_SPIDER_DB_PATH', '');
  await expect(f.call('missing-remote', { message: 'Choose a fix' })).rejects.toThrow(/nested or remote subagents/i);
});

it('explains when a recorded subagent run belongs to another machine', async () => {
  const f = fixture(true), db = f.db(), store = new RunStore(db);
  const run = store.create({ sessionId: 'parent-session', agent: 'worker' });
  store.start(run.id); store.setPid(run.id, process.pid, process.pid);
  db.prepare('UPDATE roam_meta SET machine_id=? WHERE id=1').run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); db.close();
  vi.stubEnv('PI_SPIDER_DB_PATH', join(f.root, '.spider', 'project.db')); vi.stubEnv('PI_SPIDER_SESSION_ID', 'parent-session');
  vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'parent-session'); vi.stubEnv('PI_SUBAGENT_RUN_ID', run.id);
  await expect(f.call('remote-run', { message: 'Choose a fix' })).rejects.toThrow(/nested or remote subagents/i);
});

it('validates input before resolving caller-supplied storage or focus parameters', async () => {
  const f = fixture();
  for (const extra of [{ cwd: '/nonexistent/unsafe-cwd' }, { on: 'elsewhere.invalid' }, { toolCallId: 'spoofed' }, { sessionId: 'other' }, { focus: true }]) {
    await expect(f.call('invalid', { message: 'Choose a fix', ...extra })).rejects.toThrow(/unsupported.*parameter/i);
  }
  const secretOnly = ['ghp_', 'fixture123456789012345678901234567890'].join('');
  for (const args of [{}, { message: '  ' }, { message: secretOnly }, { message: 'x', urgency: 'loud' }, { message: '🚀'.repeat(501) }, { message: 42 }]) {
    await expect(f.call('invalid', args)).rejects.toThrow();
  }
  await expect(f.call('', { message: 'Choose a fix' })).rejects.toThrow(/tool call ID/i);
  expect(f.queue).not.toHaveBeenCalled(); expect(f.appLaunches).not.toHaveBeenCalled();
});

it('accepts all urgencies and counts Unicode code points after scrubbing', async () => {
  const f = fixture();
  for (const urgency of ['low', 'attention', 'urgent']) {
    const result = await f.call(urgency, { message: '  Choose a fix  ', urgency });
    expect(result.details).toMatchObject({ ok: true, presentation: 'stored' });
  }
  const max = await f.call('max', { message: '🚀'.repeat(500) }); expect(max.details.ok).toBe(true);
  const secret = ['ghp_', 'fixture123456789012345678901234567890'].join('');
  await f.call('secret', { message: `Review credential ${secret}` });
  const db = f.db();
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE tool='notify' ORDER BY id").all() as { payload: string }[];
    const payloads = rows.map(row => JSON.parse(row.payload));
    expect(payloads.slice(0, 3).map(row => row.urgency)).toEqual(['low', 'attention', 'urgent']);
    expect(payloads[3]).toMatchObject({ urgency: 'attention', message: '🚀'.repeat(500) });
    expect(payloads[4].message).toContain('[REDACTED:'); expect(payloads[4].message).not.toContain(secret);
  } finally { db.close(); }
});

it('attributes a child notice to its verified parent despite a different cwd', async () => {
  const f = fixture(true), db = f.db(); const childCwd = join(f.root, 'elsewhere'); mkdirSync(childCwd); execFileSync('git', ['init', '-q', childCwd]);
  const store = new RunStore(db), run = store.create({ sessionId: 'parent-session', agent: 'worker' });
  store.start(run.id); store.setPid(run.id, process.pid, process.pid); db.close();
  vi.stubEnv('PI_SPIDER_DB_PATH', join(f.root, '.spider', 'project.db'));
  vi.stubEnv('PI_SPIDER_SESSION_ID', 'parent-session'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'parent-session'); vi.stubEnv('PI_SUBAGENT_RUN_ID', run.id);
  const ctx = { ...f.ctx, cwd: childCwd, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => 'child-session' } };
  const result = await f.call('child-call', { message: 'Choose a fix' }, ctx);
  expect(result.details).toMatchObject({ ok: true, presentation: 'stored' });
  const check = f.db();
  try {
    const row = check.prepare("SELECT session_id, phase, tool, payload FROM events WHERE tool='notify'").get() as any;
    expect(row).toMatchObject({ session_id: 'parent-session', phase: 'after', tool: 'notify' });
    expect(JSON.parse(row.payload)).toMatchObject({ version: 1, kind: 'agent-notification', runId: run.id });
  } finally { check.close(); }
  expect(f.queue).not.toHaveBeenCalled(); expect(f.appLaunches).not.toHaveBeenCalled();
  expect(existsSync(join(childCwd, '.spider', 'project.db'))).toBe(false);
});

it('refuses missing or mismatched inherited child ownership', async () => {
  const f = fixture(true), db = f.db(), run = new RunStore(db).create({ sessionId: 'another-owner', agent: 'worker' });
  new RunStore(db).setPid(run.id, process.pid, process.pid); db.close();
  vi.stubEnv('PI_SPIDER_DB_PATH', ''); vi.stubEnv('PI_SPIDER_SESSION_ID', ''); vi.stubEnv('PI_SUBAGENT_RUN_ID', '');
  await expect(f.call('missing', { message: 'Choose a fix' })).rejects.toThrow(/owner|ownership/i);
  vi.stubEnv('PI_SPIDER_DB_PATH', join(f.root, '.spider', 'project.db')); vi.stubEnv('PI_SPIDER_SESSION_ID', 'parent-session'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'parent-session'); vi.stubEnv('PI_SUBAGENT_RUN_ID', run.id);
  await expect(f.call('mismatch', { message: 'Choose a fix' })).rejects.toThrow(/owner|ownership/i);
  const check = f.db();
  try {
    const foreign = new RunStore(check).create({ sessionId: 'parent-session', agent: 'worker' });
    new RunStore(check).setPid(foreign.id, process.pid + 10000, process.pid);
    vi.stubEnv('PI_SUBAGENT_RUN_ID', foreign.id);
    await expect(f.call('foreign-pid', { message: 'Choose a fix' })).rejects.toThrow(/owner|ownership/i);
    expect(check.prepare("SELECT id FROM events WHERE tool='notify'").all()).toEqual([]);
  } finally { check.close(); }
});

it('keeps at most 64 qualifying occurrences and sorts equal timestamps by ID', () => {
  const f = fixture(), db = f.db(), sessionId = 'parent-session' as SessionId, now = Date.now();
  try {
    const caller = { sessionId, runId: null }, input = { message: 'Choose a fix', urgency: 'attention' as const };
    const notes = Array.from({ length: 65 }, (_, i) => storeNotification(db, caller, `call-${i}`, input, now));
    const listed = readNotifications(db, sessionId, now);
    expect(listed).toHaveLength(64);
    expect(listed.map(note => note.id)).toEqual(notes.map(note => note.id).sort().slice(0, 64));
    const child = storeNotification(db, { sessionId, runId: 'run-a' as RunId }, 'call-0', input, now);
    expect(child.id).not.toBe(notes[0].id);
  } finally { db.close(); }
});

it('includes the seven-day boundary, excludes expired and generic events', () => {
  const f = fixture(), db = f.db(), sessionId = 'parent-session' as SessionId, now = Date.now(), age = 7 * 86400000;
  try {
    const caller = { sessionId, runId: null }, input = { message: 'Choose a fix', urgency: 'attention' as const };
    const old = storeNotification(db, caller, 'old', input, now - age - 1);
    const boundary = storeNotification(db, caller, 'boundary', input, now - age);
    const current = storeNotification(db, caller, 'current', input, now);
    appendEvent(db, { sessionId, ts: now, phase: 'after', tool: 'exec', payload: { version: 1, kind: 'agent-notification', id: 'fake' } });
    appendEvent(db, { sessionId, ts: now, phase: 'after', tool: 'notify', payload: { version: 1, kind: 'tool-result', id: 'generic' } });
    db.prepare("INSERT INTO events (session_id, ts, phase, tool, payload) VALUES (?, ?, 'after', 'notify', ?)").run(sessionId, now, '{');
    expect(readNotifications(db, sessionId, now).map(note => note.id)).toEqual([current.id, boundary.id]);
    expect(readNotifications(db, sessionId, now).some(note => note.id === old.id)).toBe(false);
  } finally { db.close(); }
});

it('does not publish an occurrence when its surrounding transaction rolls back', () => {
  const f = fixture(), db = f.db(), observed: string[] = [], off = bus.on(event => { if (event.tool === 'notify') observed.push(event.sessionId); });
  try {
    expect(() => db.transaction(() => {
      storeNotification(db, { sessionId: 'parent-session' as SessionId, runId: null }, 'rolled-back', { message: 'Choose a fix', urgency: 'attention' }, Date.now());
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(observed).toEqual([]); expect(db.prepare("SELECT id FROM events WHERE tool='notify'").all()).toEqual([]);
  } finally { off(); db.close(); }
});

it('returns panel-feed only after commit and never queues a failed write', async () => {
  const f = fixture();
  f.queue.mockImplementation(() => { const db = f.db(); try { expect(db.prepare("SELECT id FROM events WHERE tool='notify'").all()).toHaveLength(1); } finally { db.close(); } return true; });
  const result = await f.call('queued', { message: 'Choose a fix' }); expect(result.details.presentation).toBe('panel-feed');
  const db = f.db(); db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END"); db.close();
  await expect(f.call('failed', { message: 'Choose another fix' })).rejects.toThrow(/fixture commit failure/i);
  expect(f.queue).toHaveBeenCalledTimes(1); expect(f.appLaunches).not.toHaveBeenCalled();
});

it('does not queue or announce a notification when SQLite rejects commit', async () => {
  const f = fixture(), db = f.db(), observed: string[] = [], off = bus.on(event => { if (event.tool === 'notify') observed.push(event.sessionId); });
  db.exec(`CREATE TABLE parent_key (id INTEGER PRIMARY KEY);
    CREATE TABLE deferred_ref (parent INTEGER REFERENCES parent_key(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_notice_on_commit AFTER INSERT ON events BEGIN INSERT INTO deferred_ref(parent) VALUES (999); END`); db.close();
  try {
    await expect(f.call('commit-failure', { message: 'Choose a fix' })).rejects.toThrow(/foreign key constraint/i);
    expect(f.queue).not.toHaveBeenCalled(); expect(observed).toEqual([]);
    const check = f.db(); try { expect(check.prepare("SELECT id FROM events WHERE tool='notify'").all()).toEqual([]); } finally { check.close(); }
  } finally { off(); }
});

it('declares notify, urgency, and the human-action-only rule to the model', () => {
  const f = fixture();
  expect(SPIDER_PARAMETERS.properties.action.enum).toContain('notify');
  expect((SPIDER_PARAMETERS.properties as any).urgency).toMatchObject({ type: 'string', enum: ['low', 'attention', 'urgent'] });
  expect(f.tool.description).toMatch(/notify.*only when a person must act, never for completion/i);
});
