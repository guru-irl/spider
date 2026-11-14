import { expect, it } from 'vitest';
import { createHostSessionFixture, createPiEvents, hostUnitPorts } from './fixtures/pi-events';
it('the shared pi events fixture subscribes, emits, and unsubscribes', () => {
  const events = createPiEvents(), seen: unknown[] = [];
  const stop = events.on('fixture', value => seen.push(value));
  events.emit('fixture', 'first'); stop(); events.emit('fixture', 'second');
  expect(seen).toEqual(['first']);
}, 5000);
it('the shared host session fixture records physical intercom entries and can model a drop', async () => {
  const f = createHostSessionFixture({ cwd: '/fixture', sessionId: 'target', sessionFile: '/fixture/session.jsonl' });
  const observed: unknown[] = [];
  f.pi.on('message_end', () => observed.push(f.ctx.sessionManager.getEntries().map(entry => entry.id)));
  const message = { customType: 'intercom_message', details: { message: { id: 'one' }, intercom: { sessionId: 'target', activationEpoch: 'active' } } };
  f.pi.sendMessage(message); await Promise.resolve();
  expect(f.ctx.sessionManager.getEntries()).toEqual([{ ...message, type: 'custom_message', id: 'physical-entry-1' }]);
  expect(observed).toEqual([['physical-entry-1']]);
  f.setPersistMessages(false); f.pi.sendMessage(message); await Promise.resolve();
  expect(f.sent).toHaveLength(2); expect(f.ctx.sessionManager.getEntries()).toHaveLength(1);
  expect(observed).toEqual([['physical-entry-1'], ['physical-entry-1']]);
}, 5000);
it('the host unit broker port never starts a connection', async () => {
  let connected = false;
  await hostUnitPorts.intercomBroker(async () => { connected = true; });
  expect(connected).toBe(false);
}, 5000);
