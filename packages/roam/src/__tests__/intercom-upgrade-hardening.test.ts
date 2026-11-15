import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildFixture } from '../../../../scripts/test-bundle';
import { join, dirname } from 'node:path';
import { openDb, openDbReadOnly } from '@spider/db-core';
import { scratchDbPath } from '@spider/db-core/testutil';
import { openIntercomStore } from '../intercom-store';
import { makeMessageFrame } from '../intercom-codec';
import { INTERCOM_PAYLOAD_MS, type IntercomStoreOptions } from '../intercom-contracts';
import { legacyHopSchema } from './intercom-hop-fixture';
import { inspectLocalIntercomDoctor } from '../intercom-doctor';
import { disabledIntercom, DEFAULT_LIMITS } from '../contracts';

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', C = '00000000-0000-4000-8000-000000000003';
const from = { sessionId: 'sender', scopeId: 'scope' }, to = { sessionId: 'recipient', scopeId: 'scope' };
const endpoint = { address: to, machineId: A, homeEpoch: 1, activationEpoch: 'activation' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(limits?: IntercomStoreOptions['limits']) {
  const root = mkdtempSync(join(dirname(scratchDbPath('roam-intercom')), 'upgrade-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'q.db'); let time = 1000;
  const clock = { now: () => time };
  const open = () => { const store = openIntercomStore({ file, machineId: A, clock, limits }); cleanups.push(() => store.close()); return store; };
  const frame = (id: string, sequence = 1, sender = from) => makeMessageFrame({ from: sender, endpoint, originMachineId: B, sequence,
    message: { id, timestamp: 1, content: { text: 'synthetic' } } });
  return { root, file, clock, open, frame, store: open(), advance(ms: number) { time += ms; } };
}
function rows(file: string, sql: string) {
  const db = openDbReadOnly(file)!; try { return db.prepare(sql).all(); } finally { db.close(); }
}
function downgrade(file: string) {
  const db = openDb(file);
  try { legacyHopSchema(db); db.exec('DROP TABLE intercom_receipt_positions; DROP TABLE intercom_settled_watermarks; UPDATE intercom_meta SET version=6'); }
  finally { db.close(); }
}

function snapshot(file: string) {
  const db = openDbReadOnly(file)!;
  try { return (db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[])
    .map(table => ({ ...table, rows: db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all() })); }
  finally { db.close(); }
}
function deployedFixture(f: ReturnType<typeof fixture>) {
  const file = join(f.root, 'roam', 'intercom', 'queue.db'); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const source = openDbReadOnly(f.file)!, db = openDb(file);
  try {
    db.exec(readFileSync(new URL('./fixtures/e1304471-intercom.sql', import.meta.url), 'utf8'));
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { name: string }[]) {
      const columns = (db.prepare(`SELECT name FROM pragma_table_info('${name}') ORDER BY cid`).all() as { name: string }[]).map(row => row.name);
      for (const row of source.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all() as Record<string, unknown>[]) {
        if (name === 'intercom_meta') row.version = 7;
        db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
      }
    }
  } finally { source.close(); db.close(); chmodSync(file, 0o600); }
  return file;
}

it.each([false, true])('migrates exact e1304471 schema, populated=%s, with recovery and no-op reruns', async populated => {
  const f = fixture(), remote = { ...endpoint, machineId: C };
  if (populated) {
    const frame = { ...f.frame('legacy-receipt'), originMachineId: C };
    f.store.acceptInbound({ peer: C, frame }); f.store.beginDispatch({ id: 'legacy-receipt', endpoint, readiness: 'ready' });
    f.store.settleReceipt({ queue: 'inbound', peer: C, frame: { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: 'legacy-receipt', status: 'unknown', timestamp: 1000 } } });
    f.store.acceptOutbound({ from: { ...from, sessionId: 'notice-sender' }, endpoint: { ...endpoint, machineId: B }, nextHop: B, message: { id: 'legacy-notice', timestamp: 1, content: { text: 'synthetic' } } });
    f.store.pending({ kind: 'outbound', peer: B, hopBudgetMs: 100 }); f.store.fencePair(B, 'edge');
    const sender = { ...from, sessionId: 'valid-sender' };
    for (const id of ['pending', 'consumed']) f.store.acceptOutbound({ from: sender, endpoint: remote, nextHop: C, message: { id, timestamp: 1, content: { text: 'synthetic' } } });
    const consumed = f.store.retained('outbound', 'consumed')!;
    f.store.settleReceipt({ queue: 'outbound', peer: C, frame: { from: remote, to: sender, digest: consumed.identity.digest, attempt: 0,
      receipt: { messageId: 'consumed', status: 'injected', timestamp: 1000, evidence: { kind: 'entry', entryId: 'entry', sessionId: to.sessionId, activationEpoch: remote.activationEpoch } } } });
  }
  f.store.close(); const file = deployedFixture(f); let db = openDb(file);
  if (populated) db.exec(`UPDATE intercom_messages SET identity_json=json_remove(identity_json,'$.originMachineId'),
    from_key=json_array('',json_extract(from_key,'$[1]')) WHERE id IN ('legacy-receipt','legacy-notice');
    UPDATE intercom_receipts SET frame_json=json_remove(frame_json,'$.originMachineId','$.sequence');
    UPDATE intercom_revocation_notices SET frame_json=json_remove(frame_json,'$.originMachineId','$.sequence');
    DELETE FROM intercom_receipt_positions;`);
  db.exec('CREATE TRIGGER migration_crash AFTER UPDATE OF version ON intercom_meta WHEN NEW.version>=8 BEGIN SELECT crash_migration(); END'); db.close();
  const before = snapshot(file), child = join(f.root, 'migration.mjs');
  await buildFixture({ stdin: { contents: `import Database from 'better-sqlite3';import {openIntercomStore} from ${JSON.stringify(new URL('../intercom-store.ts', import.meta.url).pathname)};
    const original=Database.prototype.pragma;
    Database.prototype.pragma=function(source,...args){if(source==='foreign_keys = ON')this.function('crash_migration',()=>{process.kill(process.pid,'SIGKILL');return 0;});return original.call(this,source,...args);};
    openIntercomStore({file:${JSON.stringify(file)},machineId:${JSON.stringify(A)},clock:{now:()=>1000}});`, resolveDir: process.cwd() },
    outfile: child, bundle: true, platform: 'node', format: 'esm', external: ['better-sqlite3', 'sqlite-vec'] });
  const interrupted = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 4000 });
  expect({ signal: interrupted.signal, stderr: interrupted.stderr }).toEqual({ signal: 'SIGKILL', stderr: '' });
  expect(snapshot(file)).toEqual(before);
  db = openDb(file); db.exec('DROP TRIGGER migration_crash'); db.close();
  let store = openIntercomStore({ file, machineId: A, clock: f.clock });
  expect(rows(file, 'SELECT version FROM intercom_meta')).toEqual([{ version: 9 }]);
  if (populated) {
    expect(store.inspectBlockers(from).unknownOutcomes).toEqual(['legacy-receipt']);
    expect(store.inspectBlockers({ ...from, sessionId: 'notice-sender' }).unknownOutcomes).toEqual(['legacy-notice']);
    expect(store.retained('outbound', 'pending')).toMatchObject({ state: 'queued', payloadRetained: true });
    expect(rows(file, 'SELECT sequence FROM intercom_receipt_positions')).toEqual([{ sequence: 2 }]);
  }
  store.close(); const migrated = snapshot(file);
  store = openIntercomStore({ file, machineId: A, clock: f.clock }); store.close(); expect(snapshot(file)).toEqual(migrated);
  const diagnostics = await inspectLocalIntercomDoctor({ root: f.root, agentDir: f.root, config: { enabled: false, role: 'hub', machineId: A,
    hubMachineId: A, peers: [], discoveryRoots: [], coreUnit: '', syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() } });
  expect(diagnostics).toEqual(populated ? [
    { severity: 'warning', reason: 'intercom-migration-discard: origin-less-receipts=1', repairCommand: null },
    { severity: 'warning', reason: 'intercom-migration-discard: origin-less-revocation-notices=1', repairCommand: null },
  ] : []);
  expect(snapshot(file)).toEqual(migrated);
}, 5000);

it('records refused original positions only inside the receiver window', () => {
  const f = fixture({ queueMessages: 2 });
  for (const sequence of [2, 3, Number.MAX_SAFE_INTEGER]) {
    const frame = f.frame(`refused-${sequence}`, sequence);
    f.store.rejectFrame({ peer: B, origin: B, identity: frame.identity, reason: 'sender-unauthorized' });
  }
  expect(rows(f.file, 'SELECT sequence FROM intercom_refused_slots')).toEqual([{ sequence: 2 }]);
}, 5000);

it('bounds refusal metadata across arbitrary sender streams and ages it out', () => {
  const f = fixture({ machineMessages: 3 });
  for (let i = 0; i < 8; i++) {
    const frame = f.frame(`refused-${i}`, 1, { ...from, sessionId: `sender-${i}` });
    f.store.rejectFrame({ peer: B, origin: B, identity: frame.identity, reason: 'sender-unauthorized' });
  }
  expect(rows(f.file, 'SELECT count(*) AS n FROM intercom_refused_slots')).toEqual([{ n: 3 }]);
  f.advance(2 * INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  expect(rows(f.file, 'SELECT count(*) AS n FROM intercom_refused_slots')).toEqual([{ n: 0 }]);
}, 5000);

it('ages physical refusal history without clearing a live unknown outcome', () => {
  const f = fixture(), bad = f.frame('bad'); f.store.openHop(B, 'edge');
  f.store.rejectHop({ peer: B, edgeEpoch: 'edge', sequence: 1, identity: bad.identity, origin: B, reason: 'sender-unauthorized' });
  const live = f.frame('live'); f.store.acceptInbound({ peer: B, frame: live });
  f.store.beginDispatch({ id: 'live', endpoint, readiness: 'ready' });
  f.advance(2 * INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  expect(rows(f.file, 'SELECT count(*) AS n FROM intercom_hop_slots WHERE reason IS NOT NULL')).toEqual([{ n: 0 }]);
  expect(f.store.inspectBlockers(from).unknownOutcomes).toEqual(['live']);
}, 5000);

it.each(['intercom_receipts', 'intercom_revocation_notices'] as const)('drops unverifiable legacy entries in %s without guessing an origin or outcome', table => {
  const f = fixture();
  if (table === 'intercom_receipts') {
    const frame = f.frame('legacy'); f.store.acceptInbound({ peer: B, frame }); f.store.beginDispatch({ id: 'legacy', endpoint, readiness: 'ready' });
    f.store.settleReceipt({ queue: 'inbound', peer: B, frame: { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: 'legacy', status: 'unknown', timestamp: 1000 } } });
  } else {
    f.store.acceptOutbound({ from, endpoint: { ...endpoint, machineId: B }, nextHop: B, message: { id: 'legacy', timestamp: 1, content: { text: 'synthetic' } } });
    f.store.pending({ kind: 'outbound', peer: B, hopBudgetMs: 100 }); f.store.fencePair(B, 'edge');
  }
  f.store.acceptOutbound({ from: { ...from, sessionId: 'valid-sender' }, endpoint: { ...endpoint, machineId: C }, nextHop: C,
    message: { id: 'valid', timestamp: 1, content: { text: 'synthetic' } } });
  expect(rows(f.file, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 1 }]); f.store.close(); downgrade(f.file);
  const db = openDb(f.file);
  try { db.exec(`UPDATE intercom_messages SET identity_json=json_remove(identity_json,'$.originMachineId'),
    from_key=json_array('',json_extract(from_key,'$[1]')) WHERE id='legacy';
    UPDATE ${table} SET frame_json=json_remove(frame_json,'$.originMachineId','$.sequence');`); } finally { db.close(); }
  const store = f.open();
  expect(rows(f.file, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
  expect(store.inspectBlockers(from).unknownOutcomes).toEqual(['legacy']);
  expect(store.retained(table === 'intercom_receipts' ? 'inbound' : 'outbound', 'legacy')?.originMachineId).toBeUndefined();
  expect(store.retained('outbound', 'valid')).toMatchObject({ state: 'queued', payloadRetained: true, originMachineId: A });
}, 5000);

it('rolls back the schema version and preserves legacy state if receipt evidence cannot rebuild', () => {
  const f = fixture(), remote = { ...endpoint, machineId: B };
  for (const id of ['pending', 'consumed']) f.store.acceptOutbound({ from, endpoint: remote, nextHop: B, message: { id, timestamp: 1, content: { text: 'synthetic' } } });
  const consumed = f.store.retained('outbound', 'consumed')!;
  f.store.settleReceipt({ queue: 'outbound', peer: B, frame: { from: remote, to: from, digest: consumed.identity.digest, attempt: 0,
    receipt: { messageId: 'consumed', status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: 'entry', sessionId: to.sessionId, activationEpoch: remote.activationEpoch } } } });
  f.store.close(); downgrade(f.file);
  let db = openDb(f.file);
  db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON intercom_settled_receipts BEGIN SELECT RAISE(ABORT,'evidence unavailable'); END"); db.close();
  expect(() => f.open()).toThrow('evidence unavailable');
  expect(rows(f.file, 'SELECT version FROM intercom_meta')).toEqual([{ version: 6 }]);
  expect(rows(f.file, "SELECT name FROM sqlite_master WHERE type='table' AND name='intercom_receipt_positions'")).toEqual([]);
  db = openDb(f.file); db.exec('DROP TRIGGER fail_evidence'); db.close();
  const store = f.open();
  expect(store.retained('outbound', 'pending')).toMatchObject({ state: 'queued', payloadRetained: true });
  expect(rows(f.file, 'SELECT sequence FROM intercom_receipt_positions')).toEqual([{ sequence: 2 }]);
}, 5000);

it('refuses a hop ledger whose accepted-identity retention constraint is missing', () => {
  const f = fixture(); f.store.close(); const db = openDb(f.file);
  try { db.exec(`ALTER TABLE intercom_hop_slots RENAME TO fixture_hops;
    CREATE TABLE intercom_hop_slots (direction TEXT NOT NULL,peer TEXT NOT NULL,edge_epoch TEXT NOT NULL,sequence INTEGER NOT NULL,
      identity_key TEXT NOT NULL,id TEXT,reason TEXT,at INTEGER NOT NULL,PRIMARY KEY(direction,peer,edge_epoch,sequence),UNIQUE(direction,peer,edge_epoch,id));
    DROP TABLE fixture_hops;`); } finally { db.close(); }
  expect(() => f.open()).toThrow('Invalid intercom store identity constraints');
}, 5000);
