// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { writeFile, readFile, chmod, stat, mkdir, symlink, rm, link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import type { OwnedPath } from '../../harness/environment.js';
import { spawnOwned } from '../../harness/processes.js';
import * as resources from '../../harness/resources.js';
import { deadline, waitFor } from '../../harness/wait.js';

type Register = (ledger: resources.LedgerHandle, path: OwnedPath) => { restore(): void };
const register = (...args: Parameters<Register>) => (resources as unknown as { registerModeRestore: Register }).registerModeRestore(...args);
const mode = async (path: string) => (await stat(path)).mode & 0o7777;

describe('supervised file mode restoration', () => {
  it('records the original mode once, restores on normal close and is idempotent', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-close') });
    const path = suite.ownPath(join(suite.root, 'session.jsonl'));
    try {
      await writeFile(path, 'owned-session\n', { mode: 0o640 });
      register(suite.ledger, path); await chmod(path, 0o400); register(suite.ledger, path);
      const proof = await suite.close(); expect(proof.clean).toBe(true); expect(await mode(path)).toBe(0o640);
      await chmod(path, 0o400); expect((await resources.cleanupLedger(suite.ledger.path, 'again')).clean).toBe(true); expect(await mode(path)).toBe(0o640);
      await rm(path); expect((await resources.cleanupLedger(suite.ledger.path, 'gone')).clean).toBe(true);
    } finally { await suite.close(); }
  });
  it('restores through story failure cleanup without relying on that story to repair the mode', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-failure') });
    const path = suite.ownPath(join(suite.root, 'session.jsonl'));
    try {
      await writeFile(path, 'owned-session\n', { mode: 0o600 }); register(suite.ledger, path);
      await expect((async () => { await chmod(path, 0o400); throw new Error('deliberate story failure'); })()).rejects.toThrow('deliberate story failure');
    } finally { await suite.close(); }
    expect(await mode(path)).toBe(0o600);
  });
  it('refuses outside paths, symlinks and hardlinks while accepting owned directories', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-fence') });
    try {
      const path = suite.ownPath(join(suite.root, 'file')); await writeFile(path, 'owned');
      expect(() => register(suite.ledger, join(suite.root, '..', 'foreign') as OwnedPath)).toThrow(/mode-restore-path/);
      const alias = join(suite.root, 'alias'); await symlink(path, alias);
      expect(() => register(suite.ledger, alias as OwnedPath)).toThrow(/mode-restore-path/);
      const broken = join(suite.root, 'broken'); await symlink(join(suite.root, 'absent'), broken);
      expect(() => register(suite.ledger, broken as OwnedPath)).toThrow(/mode-restore-path/);
      const dir = suite.ownPath(join(suite.root, 'directory')); await mkdir(dir);
      expect(() => register(suite.ledger, dir)).not.toThrow();
      const hard = suite.ownPath(join(suite.root, 'hard')); await link(path, hard);
      expect(() => register(suite.ledger, hard)).toThrow(/mode-restore-file/);
    } finally { await suite.close(); }
  });
  it('refuses a substituted inode or link without changing it, then restores the original on retry', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-replacement') });
    const path = suite.ownPath(join(suite.root, 'session.jsonl')), saved = suite.ownPath(join(suite.root, 'original'));
    try {
      await writeFile(path, 'original', { mode: 0o600 }); register(suite.ledger, path); await chmod(path, 0o400); await rename(path, saved);
      await writeFile(path, 'replacement', { mode: 0o644 });
      let proof = await resources.cleanupLedger(suite.ledger.path, 'replaced-inode'); expect(proof.clean).toBe(false); expect(proof.modeRestores).toEqual([expect.objectContaining({ path, outcome: 'refused' })]); expect(await mode(path)).toBe(0o644);
      await rm(path); await symlink(saved, path);
      proof = await resources.cleanupLedger(suite.ledger.path, 'replaced-link'); expect(proof.clean).toBe(false); expect(proof.modeRestores).toEqual([expect.objectContaining({ path, outcome: 'refused' })]); expect(await mode(saved)).toBe(0o400);
      await rm(path); await rename(saved, path);
      proof = await resources.cleanupLedger(suite.ledger.path, 'original-inode-restored'); expect(proof.clean).toBe(true); expect(await mode(path)).toBe(0o600);
    } finally { await suite.close(); }
  });
  it('the independent watchdog restores the mode automatically after its runner group is SIGKILLed', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-watchdog') });
    try {
      const root = suite.ownPath(join(suite.root, 'owned')), ledgers = suite.ownPath(join(suite.root, 'owned-ledgers')); await mkdir(root); await mkdir(ledgers); await mkdir(join(root, 'h')); await mkdir(join(root, 't'));
      const path = join(root, 'session.jsonl'), ledgerPath = join(ledgers, 'owned.json'), program = suite.ownPath(join(root, 'runner.mjs'));
      await writeFile(program, `import { openLedger, registerModeRestore, startWatchdog } from ${JSON.stringify(new URL('../../harness/resources.ts', import.meta.url).href)};\nimport { writeFileSync, chmodSync } from 'node:fs';\nconst ledger=openLedger(${JSON.stringify(ledgers)},${JSON.stringify(root)});\nwriteFileSync(${JSON.stringify(path)}, 'owned-session\\n', {mode:0o640});\nregisterModeRestore(ledger,${JSON.stringify(path)});chmodSync(${JSON.stringify(path)},0o400);\nstartWatchdog(ledger,Date.now()+120000,${JSON.stringify(join(ledgers, 'watchdog.log'))});\nprocess.stdout.write('ready\\n');setInterval(()=>{},1000);\n`);
      const runner = spawnOwned(suite.ledger, { label: 'watchdog-mode-runner', command: process.execPath, args: [program], env: { ...suite.env }, cwd: root, stdio: 'pipe' });
      let output = ''; runner.child.stdout!.on('data', d => output += d);
      await waitFor('runner and independent watchdog registered', () => output, text => text.includes('ready'), deadline(10000));
      const before = resources.readLedger(ledgerPath); expect(before.watchdog).toBeDefined(); expect(await mode(path)).toBe(0o400);
      process.kill(-runner.identity.pid, 'SIGKILL'); await runner.exited;
      await waitFor('watchdog restores mode after runner pipe closes', async () => ({ state: resources.readLedger(ledgerPath).state, mode: await mode(path) }), value => value.state === 'closed' && value.mode === 0o640, deadline(15000));
      const proof = JSON.parse(await readFile(ledgerPath.replace(/\.json$/, '.cleanup.json'), 'utf8'));
      expect(proof).toMatchObject({ clean: true, reason: 'watchdog:owner-pipe-closed', modeRestores: [expect.objectContaining({ path, mode: 0o640, outcome: 'restored' })] });
      await waitFor('independent mode watchdog exits', () => resources.identityAlive(before.watchdog!), alive => !alive, deadline(10000));
    } finally { await suite.close(); }
  });
  it('restores after a registered runner is SIGKILLed using the independent cleanup entry point', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-mode-killed-runner') });
    try {
      const root = suite.ownPath(join(suite.root, 'owned')), ledgers = suite.ownPath(join(suite.root, 'owned-ledgers')); await mkdir(root); await mkdir(ledgers);
      const path = join(root, 'session.jsonl'), entry = fileURLToPath(new URL('../../harness/resources.ts', import.meta.url));
      const program = suite.ownPath(join(root, 'runner.mjs'));
      await writeFile(program, `import { openLedger, registerModeRestore } from ${JSON.stringify(new URL('../../harness/resources.ts', import.meta.url).href)};\nimport { writeFileSync, chmodSync } from 'node:fs';\nconst ledger=openLedger(${JSON.stringify(ledgers)},${JSON.stringify(root)});\nwriteFileSync(${JSON.stringify(path)}, 'owned-session\\n', {mode:0o640});\nregisterModeRestore(ledger,${JSON.stringify(path)});\nchmodSync(${JSON.stringify(path)},0o400);\nprocess.stdout.write('ready\\n');\nsetInterval(()=>{},1000);\n`);
      const runner = spawnOwned(suite.ledger, { label: 'killed-mode-runner', command: process.execPath, args: [program], env: { ...suite.env }, cwd: root, stdio: 'pipe' });
      let output = ''; runner.child.stdout!.on('data', d => output += d);
      const exited = runner.exited.then(v => { throw new Error(`runner exited before ready: ${JSON.stringify(v)}`); });
      await Promise.race([waitFor('runner registered denied mode', () => output, s => s.includes('ready'), deadline(10000)), exited]);
      expect(await mode(path)).toBe(0o400); process.kill(-runner.identity.pid, 'SIGKILL'); await runner.exited;
      const ledger = join(ledgers, 'owned.json');
      const cleanup = await suite.invoke(process.execPath, [entry, 'cleanup', ledger]);
      expect(cleanup.exitCode).toBe(0); expect(JSON.parse(cleanup.stdout).clean).toBe(true); expect(await mode(path)).toBe(0o640);
      const saved = JSON.parse(await readFile(ledger.replace(/\.json$/, '.cleanup.json'), 'utf8')); expect(saved.clean).toBe(true);
      const again = await suite.invoke(process.execPath, [entry, 'cleanup', ledger]); expect(again.exitCode).toBe(0); expect(await mode(path)).toBe(0o640);
    } finally { await suite.close(); }
  });
});
