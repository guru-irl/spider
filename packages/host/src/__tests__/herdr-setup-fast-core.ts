// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import * as transport from '../../../herdr/src/client/cli-transport.js';
import { cliReplyByteLimit, SINGLE_REPLY_BYTES } from '../../../herdr/src/client/limits.js';
import { HerdrError, object, parseJson, text } from '../../../herdr/src/client/parse.js';

type Reply = { result?: unknown; raw?: string; bytesBase64?: string; stderr?: unknown; exitCode?: number };

// Keep the real fake-core daemons, routing, filesystem and clients. Only the
// per-request fake hc CLI process is replaced; streaming and special transport
// options continue through the production process transport.
export function installFastCoreTransport(h: HerdrHarness): () => void {
  const original = transport.invokeCli;
  const spy = vi.spyOn(transport, 'invokeCli').mockImplementation(async (binary, argv, env, maxBytes, input, options = {}) => {
    const root = env.HERDR_FAKE_ROOT;
    const socket = env.HC_TERMINAL_SOCKET || (env.XDG_STATE_HOME && env.HC_SESSION
      ? join(env.XDG_STATE_HOME, 'herdr-core', env.HC_SESSION, `${env.HC_SESSION}.sock`) : undefined);
    const supported = ['server', 'machine', 'ls', 'get', 'run', 'file', 'read', 'kill', 'rm', 'label', 'keep'].includes(argv[0]);
    const namedRun = argv[0] === 'run' && argv.some(arg => arg === '--name' || arg.startsWith('--name='));
    if (binary !== h.hcBinary || env.HERDR_TEST_ROOT !== h.root || ![h.directories.local, h.directories.remote].includes(root ?? '') ||
      ![h.localSocket, h.remoteSocket].includes(socket ?? '') || !supported || namedRun ||
      argv[0] === 'server' && ['start', 'stop'].includes(argv[1]) || input !== undefined ||
      options.raw || options.signal || options.timeoutMs !== undefined || options.processObserver || options.strictInput) {
      return original(binary, argv, env, maxBytes, input, options);
    }

    appendFileSync(join(root!, 'calls.jsonl'), JSON.stringify({ argv, pid: process.pid, parentPid: process.ppid,
      env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('HC_') || ['PI_SUBAGENT_CHILD', 'PI_SUBAGENT_RUN_ID'].includes(key))) }) + '\n');
    const limit = maxBytes ?? cliReplyByteLimit(argv);
    const reply = await new Promise<Reply>((resolve, reject) => {
      const client = connect(socket!); let pending = Buffer.alloc(0), done = false;
      const finish = (error?: Error, value?: Reply) => {
        if (done) return;
        done = true; clearTimeout(deadline); client.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const deadline = setTimeout(() => finish(new HerdrError('cli-timeout', 'CLI request exceeded 15000 ms', { timeoutMs: 15000 })), 15000);
      client.once('connect', () => client.write(JSON.stringify({ argv, env, input: '' }) + '\n'));
      client.once('error', error => finish(new HerdrError('server_stopped', error.message, { exitCode: 3, signal: null })));
      client.once('end', () => finish(new HerdrError('invalid-reply', 'Expected valid UTF-8 JSON')));
      client.on('data', bytes => {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > limit * 2 + 4096) { finish(new HerdrError('reply-too-large', `CLI reply exceeded its byte limit (${limit} bytes)`, { limit, source: 'reply' })); return; }
        const end = pending.indexOf(10);
        if (end < 0) return;
        try { finish(undefined, JSON.parse(pending.subarray(0, end).toString('utf8')) as Reply); }
        catch { finish(new HerdrError('invalid-reply', 'Expected valid UTF-8 JSON')); }
      });
    });
    if (reply.exitCode) {
      const stderr = Buffer.from(typeof reply.stderr === 'string' ? reply.stderr : reply.stderr === undefined ? '' : JSON.stringify(reply.stderr));
      const stderrLimit = Math.min(limit, SINGLE_REPLY_BYTES);
      if (stderr.length > stderrLimit) throw new HerdrError('reply-too-large', `CLI reply exceeded its byte limit (${stderrLimit} bytes)`, { limit: stderrLimit, source: 'error-output' });
      let error: Record<string, unknown>;
      try { error = object(object(parseJson(stderr)).error); text(error.kind); text(error.message); }
      catch { throw new HerdrError('cli-exit', `CLI exited with ${reply.exitCode}`, { exitCode: reply.exitCode, signal: null, stderr: stderr.toString('utf8'), stdout: '' }); }
      throw new HerdrError(text(error.kind), text(error.message), { exitCode: reply.exitCode, signal: null, hint: error.hint });
    }
    const bytes = typeof reply.bytesBase64 === 'string' ? Buffer.from(reply.bytesBase64, 'base64')
      : Buffer.from((typeof reply.raw === 'string' ? reply.raw : String(JSON.stringify(reply.result))) + '\n');
    if (bytes.length > limit) throw new HerdrError('reply-too-large', `CLI reply exceeded its byte limit (${limit} bytes)`, { limit, source: 'reply' });
    return parseJson(bytes);
  });
  return () => spy.mockRestore();
}
