// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { invokeCli } from './cli-transport.js';
import { HerdrError } from './parse.js';

export async function invokeBytes(
  binary: string,
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  options: { timeoutMs: number; maxBytes: number; stdin?: Buffer; signal?: AbortSignal },
): Promise<Buffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new HerdrError('invalid-byte-limit', 'Byte limit must be a nonnegative safe integer');
  }
  const input = options.stdin === undefined ? undefined : Buffer.from(options.stdin);
  return await invokeCli(binary, argv, env, options.maxBytes, input, { timeoutMs: options.timeoutMs, signal: options.signal, raw: true }) as Buffer;
}
