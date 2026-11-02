import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { createFixtureRoot, createFencedDirectories, checkoutRoot } from '../harness/environment.js';
import { openLedger, cleanupLedger, identityOf, identityAlive } from '../harness/resources.js';
import { assertRecoveryProof } from './killed-run.js';

describe('killed-run proof boundary', () => {
  it('the independent CLI retries a cleanup-failed ledger instead of only re-verifying survivors', async () => {
    const root = await createFixtureRoot(); await createFencedDirectories(root);
    const ledgers = join(root, 'retry-ledgers'); mkdirSync(ledgers);
    const ledger = openLedger(ledgers, root);
    const daemon = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', join(root, 'owned-late-registration')], { detached: true, stdio: 'ignore', env: { PATH: '/bin:/usr/bin', HOME: join(root, 'h'), TMPDIR: join(root, 't') } });
    const identity = identityOf(daemon.pid!);
    try {
      const failed = await cleanupLedger(ledger.path, 'first-attempt');
      expect(failed.clean).toBe(false); expect(ledger.read().state).toBe('cleanup-failed');
      // Recovery observes and registers the already-owned descendant by its real identity.
      ledger.update(l => l.processes.push({ ...identity, label: 'owned-recovered-daemon', group: true }));
      const result = spawnSync(process.execPath, [join(checkoutRoot(), 'packages/herdr/e2e/harness/resources.ts'), 'cleanup', ledger.path], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', HOME: join(root, 'h'), TMPDIR: join(root, 't') }, timeout: 20_000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ clean: true, repeated: true });
      expect(identityAlive(identity)).toBe(false);
      expect(ledger.read().state).toBe('closed');
    } finally {
      if (identityAlive(identity)) process.kill(-identity.pid, 'SIGKILL');
      await cleanupLedger(ledger.path, 'test-finally'); rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects a claimed clean proof with survivors and an unclean proof', () => {
    expect(() => assertRecoveryProof({ clean: true, survivors: [{ kind: 'process', id: 'owned' }] })).toThrow(/cleanup survivors/);
    expect(() => assertRecoveryProof({ clean: false, survivors: [] })).toThrow(/cleanup unproved/);
    expect(() => assertRecoveryProof({ clean: true, survivors: [] })).not.toThrow();
  });
});
