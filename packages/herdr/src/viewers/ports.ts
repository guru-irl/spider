// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// The text viewer must start without loading any pi peer.
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { HerdrError } from '../client/parse.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { submitViewerSteer } from './steering.js';
import type { ViewerOptions } from './program.js';
import type { RunId, SessionId } from '../contracts.js';

export function createViewerPorts(argv: readonly string[], io: { stdin: Readable; stdout: Writable; signal?: AbortSignal }): ViewerOptions<ReturnType<typeof createSessionIpcClient>> | null {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { io.stdout.write('usage: viewer --feed-root <absolute-feed-root> --session <session-id> --run <run-id> [--intent automatic|explicit] [--initial-status <status>]\n  --help, -h\n'); return null; }
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) { if (!['--run', '--session', '--feed-root', '--intent', '--initial-status', '--pi-root', '--run-db'].includes(argv[i]) || values.has(argv[i]) || !argv[i + 1]) throw new HerdrError('viewer-usage', 'Invalid viewer arguments'); values.set(argv[i], argv[i + 1]); }
  const feedRoot = values.get('--feed-root') ?? '', sessionId = values.get('--session') ?? '', id = values.get('--run') ?? '';
  const intent = values.get('--intent') ?? 'explicit';
  const initialStatus = values.get('--initial-status') as ViewerOptions['initialStatus'], runDbPath = values.get('--run-db');
  if (runDbPath !== undefined && (!isAbsolute(runDbPath) || runDbPath.includes('\0'))) throw new HerdrError('viewer-usage', 'Invalid viewer arguments');
  if (initialStatus !== undefined && !['queued', 'running', 'paused', 'done', 'failed', 'cancelled'].includes(initialStatus)) throw new HerdrError('viewer-usage', 'Invalid viewer arguments');
  if (intent !== 'automatic' && intent !== 'explicit') throw new HerdrError('viewer-usage', 'Invalid viewer arguments');
  if (!values.has('--run') || !values.has('--session') || !values.has('--feed-root') || !isAbsolute(feedRoot) || !sessionId || !id || [sessionId, id].some(id => /[/\\\0]/.test(id) || id === '.' || id === '..'))
    throw new HerdrError('viewer-usage', 'usage: viewer --feed-root <absolute-root> --session <id> --run <id>');
  const clients = new Set<ReturnType<typeof createSessionIpcClient>>();
  const runId = id as RunId;
  return { feedRoot, sessionId: sessionId as SessionId, runId, intent, initialStatus, runDbPath, piPackageRoot: values.get('--pi-root'), ...io,
    createClient(descriptor) { const client = createSessionIpcClient(descriptor); clients.add(client); return client; },
    submitSteer: (client, text) => submitViewerSteer(client, runId, text),
    async release() { for (const client of clients) client.dispose(); clients.clear(); },
  };
}
