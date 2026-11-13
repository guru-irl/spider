// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HcArgvClient, HcClientOptions } from '../contracts.js';
import { invokeBytes } from './bytes.js';
import { createHcClient, invokeCli } from './hc.js';
import { requireCoreAvailable } from './liveness.js';
import { HerdrError, object, selectedSocket, text } from './parse.js';

const DIRECT_MAX_MS = 600_000;
const LAUNCH_MS = 60_000;

function destination(on: string): string[] {
  if (!on || on.trim() !== on || /[\u0000-\u001f\u007f]/.test(on)) {
    throw new HerdrError('invalid-destination', 'A valid remote machine is required');
  }
  return on.startsWith('-') ? [`--on=${on}`] : ['--on', on];
}

export function createArgvClient(options: HcClientOptions): HcArgvClient {
  // The regular client checks the test socket boundary without starting a core.
  createHcClient(options);
  const binary = options.binary;
  const maxReplyBytes = options.maxReplyBytes;
  const env = Object.freeze({ ...options.env, HC_SOCKET: selectedSocket(options.env) });
  return {
    async exec(on, argv, call) {
      const target = destination(on);
      const request = { ...call, stdin: call.stdin === undefined ? undefined : Buffer.from(call.stdin) };
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > DIRECT_MAX_MS) {
        throw new HerdrError('invalid-cli-deadline', 'Direct execution requires a deadline of at most 600 seconds');
      }
      if (!argv.length || !argv[0]) throw new HerdrError('invalid-argv', 'A remote program is required');
      const args = ['exec', ...target, '--timeout', String(Math.ceil(request.timeoutMs / 1000))];
      if (request.stdin !== undefined) args.push('--stdin');
      args.push('--', ...argv);
      if (request.signal?.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
      try { await requireCoreAvailable(env, request.signal); }
      catch (error) {
        if (request.signal?.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
        throw error;
      }
      return invokeBytes(binary, args, env, request);
    },
    async run(on, argv, labels, call) {
      const target = destination(on);
      if (!argv.length || !argv[0]) throw new HerdrError('invalid-argv', 'A remote program is required');
      const args = ['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--no-parent', ...target];
      for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
      args.push('--', ...argv);
      let value: unknown;
      try { value = await invokeCli(binary, args, env, maxReplyBytes, undefined, { timeoutMs: LAUNCH_MS, signal: call?.signal }); }
      catch (error) {
        throw new HerdrError(error instanceof HerdrError ? error.code : 'cli-error', 'Remote launch request failed');
      }
      return { terminal: text(object(value).address) };
    },
  };
}
