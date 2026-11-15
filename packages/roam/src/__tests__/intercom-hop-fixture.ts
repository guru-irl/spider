import type { Db } from '@spider/db-core';
import { beforeEach } from 'vitest';
import type { IntercomExchange, IntercomIdentity } from '../intercom-contracts';

/** Reproduce the pre-hop schema while preserving its original rows. */
export function legacyHopSchema(db: Db): void {
  if ((db.prepare("SELECT name FROM pragma_table_info('intercom_meta')").all() as { name: string }[]).some(column => column.name === 'discard_counts')) {
    db.exec(`ALTER TABLE intercom_meta RENAME TO fixture_meta;
      CREATE TABLE intercom_meta (id INTEGER PRIMARY KEY CHECK(id=1),machine_id TEXT NOT NULL,version INTEGER NOT NULL,last_clock INTEGER NOT NULL);
      INSERT INTO intercom_meta SELECT id,machine_id,version,last_clock FROM fixture_meta; DROP TABLE fixture_meta;`);
  }
  if ((db.prepare("SELECT name FROM pragma_table_info('intercom_refused_slots')").all() as { name: string }[]).some(column => column.name === 'at')) {
    db.exec(`ALTER TABLE intercom_refused_slots RENAME TO fixture_refusals;
      CREATE TABLE intercom_refused_slots (from_key TEXT NOT NULL,to_key TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(from_key,to_key,sequence));
      INSERT INTO intercom_refused_slots SELECT from_key,to_key,sequence FROM fixture_refusals; DROP TABLE fixture_refusals;`);
  }
  db.exec(`DROP TABLE intercom_hop_slots; DROP TABLE intercom_hop_cursors;
    ALTER TABLE intercom_resumptions RENAME TO fixture_resumptions;
    CREATE TABLE intercom_resumptions (from_key TEXT NOT NULL,to_key TEXT NOT NULL,peer TEXT NOT NULL,
      resume_json TEXT NOT NULL,PRIMARY KEY(from_key,to_key));
    INSERT INTO intercom_resumptions(from_key,to_key,peer,resume_json) SELECT from_key,to_key,peer,resume_json FROM fixture_resumptions;
    DROP TABLE fixture_resumptions;`);
}

/** Wire fixture construction only. Negative hop-format tests use the raw bridge boundary. */
export function createHopFixture() {
  const streams = new Map<string, Map<string, number>>();
  return <T extends { exchange: IntercomExchange }>(input: T): T => {
    const value = input.exchange;
    const stream = JSON.stringify([value.senderMachine, value.recipientMachine, value.generation.edgeEpoch]);
    let slots = streams.get(stream);
    if (!slots) { slots = new Map(); streams.set(stream, slots); }
    const position = (identity: IntercomIdentity): number => {
      const key = JSON.stringify([identity.id, identity.digest, identity.sequence, identity.from, identity.to, identity.askId]);
      let sequence = slots!.get(key);
      if (sequence === undefined) { sequence = slots!.size + 1; slots!.set(key, sequence); }
      return sequence;
    };
    return { ...input, exchange: { ...value, streamStart: value.streamStart ?? { after: 0 },
      frames: value.frames.map(frame => ({ ...frame, hopSequence: frame.hopSequence ?? (frame.identity ? position(frame.identity) : 1) })),
      acknowledgements: value.acknowledgements.map(ack => ({ ...ack, hopSequence: ack.hopSequence ?? ack.identity?.sequence ?? 1 })),
      ...(value.refusals ? { refusals: value.refusals.map(refusal => ({ ...refusal, hopSequence: refusal.hopSequence ?? refusal.identity?.sequence ?? 1 })) } : {}),
    } };
  };
}

let fixture = createHopFixture();
beforeEach(() => { fixture = createHopFixture(); });
export function withHopExchange(exchange: unknown): IntercomExchange {
  const value = exchange as IntercomExchange;
  if (!value || !Array.isArray(value.frames) || !Array.isArray(value.acknowledgements)) return value;
  return fixture({ exchange: value }).exchange;
}

export function withHopRequest<T>(input: T): T {
  if (typeof input !== 'object' || input === null || !('exchange' in input)) return input;
  return { ...input, exchange: withHopExchange(input.exchange) };
}
