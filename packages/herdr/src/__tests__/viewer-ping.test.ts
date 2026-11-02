// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import type { IpcDescriptor } from '../contracts.js';

test('a viewer health probe times out promptly even while the owner socket stays connected', async () => {
  const root = resolve('.spider/scratch/vp', randomBytes(3).toString('hex')); await mkdir(root, { recursive: true });
  const address = join(root, 's'), capabilityFile = join(root, 'cap'); await writeFile(capabilityFile, 'a'.repeat(64), { mode: 0o600 });
  const sockets = new Set<Socket>(); const server = createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(address, resolve)); await chmod(address, 0o600);
  const client = createSessionIpcClient({ version: 1, address, capabilityFile, sessionId: 'owner', generation: 'activation' } as IpcDescriptor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.ping({ timeoutMs: 30 }).then(() => 'unexpected reply', (error: { code?: string }) => error.code),
      new Promise(resolve => { timer = setTimeout(() => resolve('probe still waiting'), 500); }),
    ]);
    expect(result).toBe('unavailable');
  } finally {
    clearTimeout(timer); client.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
