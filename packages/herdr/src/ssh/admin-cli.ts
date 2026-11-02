// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:os';
import { HerdrError } from '../client/parse.js';
import type { SessionId, HerdrConfig } from '../contracts.js';
import { runHerdrAdmin } from './admin.js';
import { normalizeSshHost } from './parse.js';

export const ADMIN_USAGE = 'admin [--session-id <id>] --wrapper <absolute-path> --reason <text> --destination <managed-machine> -- <argv...>';

/** The approved wrapper receives destination as argv[0], followed by the untouched trailing argv. */
export async function runAdminCli(argv: readonly string[], environment: Readonly<NodeJS.ProcessEnv> = process.env, resolveConfig?: () => Promise<HerdrConfig>): Promise<number> {
  const flags = new Map<string, string>(); let separator = -1;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--') { separator = i; break; }
    if (!['--session-id', '--wrapper', '--reason', '--destination'].includes(flag) || flags.has(flag))
      throw new HerdrError('cli-usage', ADMIN_USAGE);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new HerdrError('cli-usage', ADMIN_USAGE);
    flags.set(flag, value);
  }
  const wrapper = flags.get('--wrapper'), reason = flags.get('--reason'), destination = flags.get('--destination');
  const sessionId = flags.get('--session-id') ?? environment.PI_SPIDER_SESSION_ID;
  if (separator < 0 || !wrapper || !reason || !destination || !sessionId || !sessionId.trim() || sessionId.length > 2048 || /[\x00-\x1f\x7f]/.test(sessionId))
    throw new HerdrError('cli-usage', ADMIN_USAGE + '\nSupply --session-id for a top-level session; children may use PI_SPIDER_SESSION_ID.');
  if (!resolveConfig) throw new HerdrError('setup-composition-unavailable', 'Administration requires the host-resolved user policy');
  const config = await resolveConfig();
  const auditDirectory = join(config.globalRoot, 'herdr/admin');
  const result = await runHerdrAdmin({ owner: { sessionId: sessionId as SessionId }, wrapper, reason, destination, argv: argv.slice(separator + 1) }, {
    wrappers: config.admin.wrappers, environment,
    // Repair must not depend on hc or a live/valid cache. The user config is authoritative here.
    routing: {
      async checkArgv([name]) {
        const host = normalizeSshHost(name);
        const machine = config.machines.find(machine => [machine.name, ...machine.aliases].some(target => normalizeSshHost(target) === host));
        return machine ? { kind: 'refuse', machine: machine.name, reason: 'Managed destination requires an audited route' } : { kind: 'allow' };
      },
      async checkShell() { throw new HerdrError('admin-not-authorized', 'Admin requires an explicit managed destination'); },
    },
    async audit(row) {
      await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
      const file = await open(join(auditDirectory, 'audit.jsonl'), 'a', 0o600);
      try { await file.writeFile(JSON.stringify(row) + '\n'); await file.sync(); }
      finally { await file.close(); }
    },
    async transport(request) {
      const token = randomBytes(32).toString('hex'), bypassDirectory = join(auditDirectory, 'bypass');
      await mkdir(bypassDirectory, { recursive: true, mode: 0o700 });
      const capability = join(bypassDirectory, token);
      await writeFile(capability, token, { flag: 'wx', mode: 0o600 });
      try {
        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(request.wrapper.path, [request.destination, ...request.argv], { env: { ...request.env, SPIDER_HERDR_SSH_BYPASS: token }, stdio: 'inherit' });
          const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
          const handlers = signals.map(signal => { const handler = () => { child.kill(signal); }; process.on(signal, handler); return [signal, handler] as const; });
          const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
          child.once('error', error => { cleanup(); reject(error); });
          child.once('close', (code, signal) => { cleanup(); resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)); });
        });
        // Streams are inherited, never buffered or replayed as CLI text.
        return { exitCode, stdout: '', stderr: '' };
      } finally { await unlink(capability); }
    },
  });
  return result.exitCode ?? 1;
}
