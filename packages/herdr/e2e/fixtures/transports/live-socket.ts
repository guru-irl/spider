// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createServer } from 'node:net';
import { once } from 'node:events';
import { assertSocketPath } from '../../harness/environment.js';
import type { Suite } from '../../harness/suite.js';

/** A connection is the complete liveness protocol. No hc reply is manufactured. */
export async function listenCoreIdentity(suite: Suite, socket: string): Promise<{ close(): Promise<void> }> {
  const owned = suite.ownPath(socket); assertSocketPath(suite.root, owned);
  const server = createServer(client => client.end());
  const listening = once(server, 'listening'); server.listen(owned); await listening;
  server.unref();
  let closing: Promise<void> | undefined;
  return { close() { return closing ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
