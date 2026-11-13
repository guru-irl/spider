// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Bounded process transport for JSON and raw byte replies.
import { spawn } from 'node:child_process';
import { HerdrError, parseJson, object, text } from './parse.js';
import { cliReplyByteLimit, SINGLE_REPLY_BYTES } from './limits.js';

export interface CliRequestOptions { timeoutMs?: number; signal?: AbortSignal; raw?: boolean; strictInput?: boolean; acceptedExitCodes?: readonly number[] }

export async function invokeCli(binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, maxBytes: number = cliReplyByteLimit(argv), input?: Buffer, options: CliRequestOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new HerdrError('invalid-cli-deadline', 'CLI deadline must be a finite nonnegative timer duration');
  if (options.signal?.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
  const acceptedExitCodes = new Set(options.raw ? options.acceptedExitCodes ?? [] : []);
  if ([...acceptedExitCodes].some(code => !Number.isSafeInteger(code) || code < 1 || code > 255))
    throw new HerdrError('invalid-exit-code', 'Accepted exit codes must be positive bytes');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...argv], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let errorSize = 0; let failure: HerdrError | null = null;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined, reapTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(reapTimer); options.signal?.removeEventListener('abort', aborted); };
    const stop = (error: HerdrError) => {
      if (finished || failure) return;
      failure = error;
      clearTimeout(deadline);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reapTimer = setTimeout(() => {
          finished = true; cleanup();
          reject(new HerdrError(error.code, error.message, { pid: child.pid, timeoutMs, unreaped: true }));
        }, 2000);
      }, 1000);
    };
    const aborted = () => stop(new HerdrError('cli-aborted', 'CLI request aborted', { pid: child.pid, timeoutMs }));
    const deadline = setTimeout(() => stop(new HerdrError('cli-timeout', `CLI request exceeded ${timeoutMs} ms`, { pid: child.pid, timeoutMs })), timeoutMs);
    options.signal?.addEventListener('abort', aborted, { once: true });
    const overflow = (limit: number, source: 'reply' | 'error-output') => stop(new HerdrError('reply-too-large', `CLI reply exceeded its byte limit (${limit} bytes)`, { pid: child.pid, limit, source }));
    child.stdout.on('data', (bytes: Buffer) => { if (failure) return; size += bytes.length; if (size > maxBytes) overflow(maxBytes, 'reply'); else stdout.push(bytes); });
    const stderrLimit = options.raw ? SINGLE_REPLY_BYTES : Math.min(maxBytes, SINGLE_REPLY_BYTES);
    child.stderr.on('data', (bytes: Buffer) => { if (failure) return; errorSize += bytes.length; if (errorSize > stderrLimit) overflow(stderrLimit, 'error-output'); else stderr.push(bytes); });
    child.once('error', error => stop(new HerdrError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-hc' : 'spawn-error', error.message, { pid: child.pid })));
    child.once('close', (code, signal) => {
      if (finished) return;
      finished = true; cleanup();
      if (failure) { reject(failure); return; }
      if (code !== 0 && !(code !== null && acceptedExitCodes.has(code))) {
        if (options.raw) { reject(new HerdrError('cli-exit', `CLI exited with ${code ?? signal}`, { exitCode: code, signal })); return; }
        try {
          const error = object(object(parseJson(Buffer.concat(stderr))).error);
          reject(new HerdrError(text(error.kind), text(error.message), { exitCode: code, signal, hint: error.hint }));
        } catch { reject(new HerdrError('cli-exit', `CLI exited with ${code ?? signal}`, { exitCode: code, signal, stderr: Buffer.concat(stderr).toString('utf8'), stdout: Buffer.concat(stdout).toString('utf8') })); }
        return;
      }
      if (options.raw) { resolve(Buffer.concat(stdout)); return; }
      try { resolve(parseJson(Buffer.concat(stdout))); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => {
      if ((options.raw || options.strictInput) && input !== undefined) stop(new HerdrError('stdin-error', 'CLI could not receive the complete request', { pid: child.pid }));
    });
    child.stdin.end(input);
  });
}
