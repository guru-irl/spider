// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, chmod, access, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { createHerdrHarness } from './isolated.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { rollbackHerdr } from '../setup/installer.js';
import { createTerminalRegistry, writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery, setupSpaces } from '../spaces/setup.js';
import { shellQuote } from '../sessions/resume.js';
import type { SetupRequest } from '../setup/installer.js';
import { fixture, until, realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';

afterEach(() => vi.unstubAllEnvs());
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
      const command = await f.runInTerminal(['resume', '--config', f.request.configPath, '--file', f.file, '--session-id', 'selected', '--cwd', f.root]);
      const registry = createTerminalRegistry(join(f.request.config.globalRoot, 'herdr'));
      await until(async () => { try { await access(join(f.root, 'ready')); return true; } catch { return false; } });
      await delay(3000);
      expect((await registry.list())[0].owner).toMatchObject({ generation: 'authoritative', name: 'Selected' });
      await writePrivateJson(f.control, { exit: true }); const result = await command.result; expect(result.code, result.stderr).toBe(0);
    } finally { await f.h.close(); }
  }, 60000);
  registerJournalCrashTests(test, mode, ["spaces:4"]);
  test(`production resume offer declines without launching and reuses the kept address (${mode})`, async () => {
    const f = await fixture(mode, true);
    try {
      const identity = f.h.owner!.terminal, registry = createTerminalRegistry(join(f.request.config.globalRoot, 'herdr'));
      const { coreStartedAt } = await import('../../../host/src/herdr/ports.js');
      const epoch = await coreStartedAt(f.h.hcBinary, f.h.localEnv);
      await registry.record({ owner: { ...f.h.owner!, sessionId: 'selected' as never, sessionFile: f.file, name: 'Selected' }, recordedAt: epoch + 1, coreStartedAt: epoch, environment: { agentDirectory: f.request.config.agentDirectory, extensionArguments: [] } });
      const before = await (await f.runInTerminal(['resume-offer', '--config', f.request.configPath])).result; expect(before.code, before.stderr).toBe(0); expect(before.stdout).toBe('');
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
  test(`Ctrl-C before the first tab permits rollback then setup (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      const ps = join(f.root, 'bin/ps');
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then printf "999 pi pi\\n"; exit 0; fi\nexec /bin/ps "$@"\n');
      const command = f.run(['setup-cutover']); let output = ''; command.child.stderr.on('data', bytes => output += bytes);
      await until(async () => output.includes('/reload in that session'));
      command.child.kill('SIGINT'); const aborted = await command.result; expect(aborted.code).not.toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs).toEqual([]);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(true);
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n');
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
  test(`pending cutover with no tab can rollback and set up again (${mode})`, async () => {
    const f = await fixture(mode); vi.stubEnv('PATH', join(f.root, 'bin') + ':' + process.env.PATH);
    const ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; await saveJournal(f.request.journalRoot, journal);
      const parts = await ports.setupParts(f.request);
      expect((await parts.preflight(f.request)).cutoverProvedAbsent).toBe(true);
      await rollbackHerdr(f.request, parts);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(false);
      const result = await f.run(['setup-cutover']).result; expect(result.code, result.stderr).toBe(0);
      await f.stopOwners();
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).entries).toEqual([]);
      await writePrivateJson(f.control, {});
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await ports.dispose(); await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
}
