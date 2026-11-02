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
});
