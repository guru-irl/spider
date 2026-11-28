// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { connect } from 'node:net';
import { vi } from 'vitest';
import * as transport from '../../../herdr/src/client/cli-transport.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import type { HerdrHarness } from '../../../herdr/src/__tests__/isolated.js';

export function createViewerCaseTracker() {
  let work: Promise<void> | undefined;
  return {
    run(body: () => Promise<void>): Promise<void> {
      if (work) throw new Error('Previous viewer case has not drained');
      work = body();
      return work;
    },
    async drain(): Promise<void> {
      const pending = work;
      if (!pending) return;
      try { await pending; } catch { /* The test itself reports its failure. */ }
      finally { if (work === pending) work = undefined; }
    },
  };
}

/** Only read-only calls to this fixture's fake cores bypass the CLI process. */
export function useViewerCoreReads(h: HerdrHarness): void {
  const original = transport.invokeCli;
  vi.spyOn(transport, 'invokeCli').mockImplementation((binary, argv, env, maxBytes, input, options) => {
    const command = argv.join(' ');
    const read = command === 'server status --json' || command === 'machine ls --json'
      || (argv.length === 3 && argv[0] === 'get' && argv[2] === '--json');
    const socketPath = env.HC_SOCKET;
    if (binary !== h.hcBinary || !read || (socketPath !== h.localSocket && socketPath !== h.remoteSocket) || input || options?.raw) {
      return original(binary, argv, env, maxBytes, input, options);
    }
    if (options?.signal?.aborted) return Promise.reject(new HerdrError('cli-aborted', 'CLI request aborted'));
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let reply = '', done = false;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true; options?.signal?.removeEventListener('abort', aborted); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(new HerdrError('cli-aborted', 'CLI request aborted'));
      options?.signal?.addEventListener('abort', aborted, { once: true });
      socket.setTimeout(options?.timeoutMs ?? 15_000, () => finish(new HerdrError('cli-timeout', 'Fake core read timed out')));
      socket.once('error', finish);
      socket.once('connect', () => socket.write(JSON.stringify({ argv, env, input: '' }) + '\n'));
      socket.on('data', bytes => {
        reply += bytes.toString();
        if (Buffer.byteLength(reply) > (maxBytes ?? 8 * 1024 * 1024)) return finish(new HerdrError('reply-too-large', 'Fake core reply exceeded the limit'));
        const end = reply.indexOf('\n');
        if (end < 0) return;
        try {
          const { result, exitCode, stderr } = JSON.parse(reply.slice(0, end));
          if (exitCode) {
            const detail = typeof stderr === 'string' ? JSON.parse(stderr) : stderr;
            throw new HerdrError(detail?.error?.kind ?? 'cli-exit', detail?.error?.message ?? 'Fake core read failed');
          }
          finish(undefined, result);
        } catch (error) { finish(error as Error); }
      });
      socket.once('end', () => finish(new Error('Fake core closed before replying')));
    });
  });
}
