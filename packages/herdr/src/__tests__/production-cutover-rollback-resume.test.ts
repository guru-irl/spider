// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { writeFile, chmod, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalRegistry, writePrivateJson } from '../sessions/registry.js';
import { shellQuote } from '../sessions/resume.js';
import { fixture, until, realCoreAvailable } from './production-cutover-fixture.js';

if (process.env.SPIDER_HERDR_E2E === '1' && !realCoreAvailable) console.warn('Skipping isolated core acceptance: hc is not installed');
for (const mode of ['fake', 'hc'] as const) {
  const test = mode === 'hc' ? it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !realCoreAvailable) : it;
  test(`production resume never overwrites pi's authoritative mapping (${mode})`, async () => {
    const f = await fixture(mode, true);
    try {
      const binary = join(f.root, 'bin/slow-hc');
      await writeFile(binary, `#!/bin/sh\nif [ "$1 $2" = 'server status' ]; then sleep 2; fi\nexec ${shellQuote(f.h.hcBinary)} "$@"\n`); await chmod(binary, 0o700);
      await writeFile(f.request.configPath, JSON.stringify({ ...f.request.config, core: { ...f.request.config.core, binary } }));
      await writePrivateJson(f.control, { activationDelay: 0 });
      const registry = createTerminalRegistry(join(f.request.config.globalRoot, 'herdr'));
      await registry.record({ owner: { ...f.h.owner!, sessionId: 'selected' as never, generation: 'offered' as never, sessionFile: f.file, cwd: f.root, name: 'Selected' },
        recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.request.config.agentDirectory, extensionArguments: [] } });
      expect((await registry.get(f.h.owner!.terminal))?.owner.generation).toBe('offered');
      const command = await f.runInTerminal(['resume', '--config', f.request.configPath, '--file', f.file, '--session-id', 'selected', '--cwd', f.root]);
      let earlyExit: { code: number | null; stderr: string } | undefined;
      void command.result.then(result => { earlyExit = result; });
      await until(async () => {
        if (earlyExit) throw new Error(`Resume exited before readiness (${earlyExit.code}): ${earlyExit.stderr}`);
        try { await access(join(f.root, 'ready')); return true; } catch { return false; }
      });
      await delay(3000);
      expect((await registry.list())[0].owner).toMatchObject({ generation: 'authoritative', name: 'Selected' });
      await writePrivateJson(f.control, { exit: true }); const result = await command.result; expect(result.code, result.stderr).toBe(0);
    } finally { await f.h.close(); }
  }, 60000);
  test(`production resume offer declines without launching and reuses the kept address (${mode})`, async () => {
    const f = await fixture(mode, true);
    try {
      const identity = f.h.owner!.terminal, registry = createTerminalRegistry(join(f.request.config.globalRoot, 'herdr'));
      const { coreStartedAt } = await import('../../../host/src/herdr/ports.js');
      const epoch = await coreStartedAt(f.h.hcBinary, f.h.localEnv);
      await registry.record({ owner: { ...f.h.owner!, sessionId: 'selected' as never, sessionFile: f.file, name: 'Selected' }, recordedAt: epoch + 1, coreStartedAt: epoch, environment: { agentDirectory: f.request.config.agentDirectory, extensionArguments: [] } });
      const before = await (await f.runInTerminal(['resume-offer', '--config', f.request.configPath])).result; expect(before.code, before.stderr).toBe(0);
      const quiet = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', before.stdout], { cwd: f.root, encoding: 'utf8' });
      expect(quiet.status, quiet.stderr).toBe(0); expect(quiet.stdout).toBe(''); expect(quiet.stderr).toBe('');
      await expect(access(join(f.root, 'launches.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
      const original = await f.h.cli(['get', identity.address, '--json']) as { pid?: number }, { processStartTime } = await import('../../../subagents/src/process-identity.js');
      const originalStart = original.pid ? processStartTime(original.pid) : null;
      await writeFile(f.request.config.core.config, 'notes = false\nshell = ' + JSON.stringify(f.shellArgv) + '\n');
      await delay(1200);
      if (mode === 'hc') { await f.h.cli(['keep', identity.address, '--json']); await f.h.cli(['server', 'restart', '--json']); }
      else { await f.h.cli(['server', 'stop', '--json']); }
      if (original.pid && originalStart && processStartTime(original.pid) === originalStart) process.kill(mode === 'fake' ? -original.pid : original.pid, 'SIGKILL');
      if (mode === 'fake') { await f.h.cli(['server', 'start', '--json']); await f.startTerminalShell(f.h.owner); }
      const offer = await (await f.runInTerminal(['resume-offer', '--config', f.request.configPath])).result; expect(offer.code, offer.stderr).toBe(0); expect(offer.stdout).toContain('spider_resume'); expect(offer.stdout).toContain('Selected');
      await expect(access(join(f.root, 'launches.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
      const command = await f.runInTerminal(['resume', '--config', f.request.configPath, '--file', f.file, '--session-id', 'selected', '--cwd', f.root]);
      await until(async () => (await registry.list())[0].owner.generation === 'authoritative');
      expect((await registry.list())[0].owner.terminal.address).toBe(identity.address);
      await writePrivateJson(f.control, { exit: true }); const result = await command.result; expect(result.code, result.stderr).toBe(0);
      expect((await f.h.hc.get(identity.address)).state).toBe('live');
    } finally { await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
}
