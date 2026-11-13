import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { waitForSocketClose } from '../test-support.js';

it('waits for socket close when a reset is emitted first', async () => {
  const socket = new EventEmitter();
  socket.on('error', () => {});
  const outcome = waitForSocketClose(socket).then(() => 'closed', () => 'error');
  let settled = false;
  void outcome.then(() => { settled = true; });
  socket.emit('error', Object.assign(new Error('fixture connection reset'), { code: 'ECONNRESET' }));
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  socket.emit('close');
  expect(await outcome).toBe('closed');
});
