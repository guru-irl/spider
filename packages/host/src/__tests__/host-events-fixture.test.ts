import { expect, it } from 'vitest';
import { createPiEvents, hostUnitPorts } from './fixtures/pi-events';
it('the shared pi events fixture subscribes, emits, and unsubscribes', () => {
  const events = createPiEvents(), seen: unknown[] = [];
  const stop = events.on('fixture', value => seen.push(value));
  events.emit('fixture', 'first'); stop(); events.emit('fixture', 'second');
  expect(seen).toEqual(['first']);
}, 5000);
it('the host unit broker port never starts a connection', async () => {
  let connected = false;
  await hostUnitPorts.intercomBroker(async () => { connected = true; });
  expect(connected).toBe(false);
}, 5000);
