// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import type { OwnedPath } from '../environment.js';
import { spawnOwned } from '../processes.js';
import { cleanupLedger, registerModeRestore } from '../resources.js';
import { deadline, waitFor } from '../wait.js';

const mode = async (path: string) => (await stat(path)).mode & 0o7777;

describe('supervised directory mode restoration', () => {
  it('restores nested directories on normal close, then repeats idempotently', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-dir-mode-close') });
    const parent = suite.ownPath(join(suite.root, 'parent')), child = suite.ownPath(join(parent, 'child'));
    try {
      await mkdir(parent, { mode: 0o750 }); await chmod(parent, 0o750);
      await mkdir(child, { mode: 0o710 }); await chmod(child, 0o710);
      // Register child first: cleanup must restore the inaccessible parent before its child.
      registerModeRestore(suite.ledger, child); registerModeRestore(suite.ledger, parent);
      await chmod(child, 0); await chmod(parent, 0); registerModeRestore(suite.ledger, parent);
      const proof = await suite.close();
      expect(proof.clean, JSON.stringify(proof)).toBe(true);
      expect(await mode(parent)).toBe(0o750); expect(await mode(child)).toBe(0o710);
      await chmod(child, 0); await chmod(parent, 0);
      expect((await cleanupLedger(suite.ledger.path, 'repeat')).clean).toBe(true);
      expect(await mode(parent)).toBe(0o750); expect(await mode(child)).toBe(0o710);
    } finally { await suite.close(); }
  });

  it('restores the original directory mode after a story throws', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-dir-mode-failure') });
    const path = suite.ownPath(join(suite.root, 'directory'));
    try {
      await mkdir(path, { mode: 0o751 }); await chmod(path, 0o751);
      registerModeRestore(suite.ledger, path);
      await expect((async () => { await chmod(path, 0o500); throw new Error('deliberate story failure'); })()).rejects.toThrow('deliberate story failure');
    } finally { await suite.close(); }
    expect(await mode(path)).toBe(0o751);
  });

  it('restores a directory through standalone cleanup after its registered runner is SIGKILLed', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-dir-mode-killed') });
    try {
      const root = suite.ownPath(join(suite.root, 'owned')), ledgers = suite.ownPath(join(suite.root, 'owned-ledgers'));
      await mkdir(root); await mkdir(ledgers);
      const path = join(root, 'directory'), entry = fileURLToPath(new URL('../resources.ts', import.meta.url));
      const program = suite.ownPath(join(root, 'runner.mjs'));
      await writeFile(program, `import { openLedger, registerModeRestore } from ${JSON.stringify(new URL('../resources.ts', import.meta.url).href)};\nimport { mkdirSync, chmodSync } from 'node:fs';\nconst ledger=openLedger(${JSON.stringify(ledgers)},${JSON.stringify(root)});\nmkdirSync(${JSON.stringify(path)},{mode:0o751}); chmodSync(${JSON.stringify(path)},0o751);\nregisterModeRestore(ledger,${JSON.stringify(path)}); chmodSync(${JSON.stringify(path)},0o500);\nprocess.stdout.write('ready\\n'); setInterval(()=>{},1000);\n`);
      const runner = spawnOwned(suite.ledger, { label: 'killed-dir-runner', command: process.execPath, args: [program], env: { ...suite.env }, cwd: root, stdio: 'pipe' });
      let output = ''; runner.child.stdout!.on('data', data => output += data);
      const premature = runner.exited.then(exit => { throw new Error(`runner exited before ready: ${JSON.stringify(exit)}`); });
      await Promise.race([waitFor('runner registered directory mode', () => output, value => value.includes('ready'), deadline(15_000)), premature]);
      expect(await mode(path)).toBe(0o500);
      process.kill(-runner.identity.pid, 'SIGKILL'); await runner.exited;
      const ledger = join(ledgers, 'owned.json');
      const cleanup = await suite.invoke(process.execPath, [entry, 'cleanup', ledger]);
      expect(cleanup.exitCode, cleanup.stderr).toBe(0);
      expect(JSON.parse(cleanup.stdout)).toMatchObject({ clean: true, modeRestores: [expect.objectContaining({ path, mode: 0o751, outcome: 'restored' })] });
      expect(await mode(path)).toBe(0o751);
      const proof = JSON.parse(await readFile(ledger.replace(/\.json$/, '.cleanup.json'), 'utf8'));
      expect(proof.clean).toBe(true);
      expect((await suite.invoke(process.execPath, [entry, 'cleanup', ledger])).exitCode).toBe(0);
      expect(await mode(path)).toBe(0o751);
    } finally { await suite.close(); }
  });

  it('rejects symlinks, special files, and replaced directory identities', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-dir-mode-fence') });
    try {
      const dir = suite.ownPath(join(suite.root, 'directory')); await mkdir(dir);
      const alias = join(suite.root, 'alias'); await symlink(dir, alias);
      expect(() => registerModeRestore(suite.ledger, alias as OwnedPath)).toThrow(/mode-restore-path/);
      const fifo = suite.ownPath(join(suite.root, 'fifo')); execFileSync('mkfifo', [fifo], { env: suite.env });
      expect(() => registerModeRestore(suite.ledger, fifo)).toThrow(/mode-restore/);
      const original = join(suite.root, 'original');
      registerModeRestore(suite.ledger, dir); await rename(dir, original); await mkdir(dir);
      const proof = await cleanupLedger(suite.ledger.path, 'replaced');
      expect(proof.clean).toBe(false);
      expect(proof.modeRestores).toEqual([expect.objectContaining({ path: dir, outcome: 'refused' })]);
      await rm(dir, { recursive: true }); await rename(original, dir);
      expect((await cleanupLedger(suite.ledger.path, 'restored-identity')).clean).toBe(true);
    } finally { await suite.close(); }
  });
});
