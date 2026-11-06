import { describe, expect, it } from 'vitest';
import { createSuite } from '../harness/suite.js';
import { storyId } from '../harness/scenario.js';
import { runArtifactControls } from './behavioral.js';

describe('packed behavioral controls', () => {
  it('runs unmodified artifact assertions before catching each matching bad copy', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-controls') });
    try {
      const reports = await runArtifactControls(suite);
      expect(reports.map(row => row.kind)).toEqual(['missing-runtime', 'helper-import', 'incorrect-outcome']);
      expect(reports.every(row => row.result === 'caught')).toBe(true);
      expect(reports.map(row => row.reason).join('\n')).toMatch(/runtime-probe/);
      expect(reports.map(row => row.reason).join('\n')).toMatch(/helper-import/);
      expect(reports.map(row => row.reason).join('\n')).toMatch(/runtime-outcome/);
    } finally { expect((await suite.close()).clean).toBe(true); }
  });

  it('reports the process status and output when the helper fails without stderr', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-helper-diagnostics') });
    const invoke = suite.invoke;
    try {
      const testSuite = { ...suite, invoke: (binary: string, argv: readonly string[]) => argv[0] === '--input-type=module'
        ? invoke(process.execPath, ['-e', 'process.exit(37)'])
        : invoke(binary, argv) };
      await expect(runArtifactControls(testSuite)).rejects.toThrow(/helper-import:.*exit(?:Code)?[=: ]+37.*stdout.*stderr/);
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });

  it('reports the signal when the helper is terminated', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-helper-signal') });
    const invoke = suite.invoke;
    try {
      const testSuite = { ...suite, invoke: (binary: string, argv: readonly string[]) => argv[0] === '--input-type=module'
        ? invoke(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"])
        : invoke(binary, argv) };
      await expect(runArtifactControls(testSuite)).rejects.toThrow(/helper-import:.*exit=null.*signal=SIGTERM.*stdout.*stderr/);
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });

  it('bounds large output while retaining both ends of each stream', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-helper-large-output') });
    const invoke = suite.invoke;
    try {
      const testSuite = { ...suite, invoke: (binary: string, argv: readonly string[]) => argv[0] === '--input-type=module'
        ? invoke(process.execPath, ['-e', "process.stdout.write('OUT-START' + 'x'.repeat(20000) + 'OUT-END'); process.stderr.write('ERR-START' + 'y'.repeat(20000) + 'ERR-END'); process.exitCode = 37"])
        : invoke(binary, argv) };
      let message = '';
      try { await runArtifactControls(testSuite); } catch (error) { message = String(error); }
      expect(message).toMatch(/exit=37.*stdout=.*OUT-START.*OUT-END.*stderr=.*ERR-START.*ERR-END/);
      expect(message).toContain('omitted');
      expect(message.length).toBeLessThan(5000);
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });

  it('does not count missing-module text on stdout as a caught bad copy', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-helper-false-positive') });
    const invoke = suite.invoke;
    try {
      const testSuite = { ...suite, invoke: (binary: string, argv: readonly string[]) => argv[0] === '--input-type=module' && argv[2]?.includes('bad-helper-import-')
        ? invoke(process.execPath, ['-e', "process.stdout.write('Cannot find module data.js')"])
        : invoke(binary, argv) };
      await expect(runArtifactControls(testSuite)).rejects.toThrow(/known-bad control failed for unrelated reason: helper-import/);
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });

  it('reports unexpected stdout when the helper exits successfully', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-helper-output') });
    const invoke = suite.invoke;
    try {
      const testSuite = { ...suite, invoke: (binary: string, argv: readonly string[]) => argv[0] === '--input-type=module'
        ? invoke(process.execPath, ['-e', "process.stdout.write('unexpected')"])
        : invoke(binary, argv) };
      await expect(runArtifactControls(testSuite)).rejects.toThrow(/helper-import:.*exit(?:Code)?[=: ]+0.*stdout.*unexpected.*stderr/);
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });
});
