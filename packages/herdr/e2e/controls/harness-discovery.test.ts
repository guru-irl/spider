import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore Configuration-time JavaScript helper is also tested at runtime.
import { harnessIncludes, assertHarnessCoverage, auditHarnessFiles } from './harness-discovery.mjs';

describe('harness file coverage', () => {
  it('includes fixture tests at any depth alongside foundation and confidence tests', () => {
    expect(harnessIncludes).toContain('packages/herdr/e2e/fixtures/**/*.test.ts');
    expect(() => assertHarnessCoverage(['packages/herdr/e2e/fixtures/payloads/example.test.ts'])).not.toThrow();
    expect(() => assertHarnessCoverage(['packages/herdr/e2e/harness/new-test.test.ts'])).not.toThrow();
  });
  it('discovers an actual nested fixture test and diagnoses an actual uncovered file', () => {
    mkdirSync(join(process.cwd(), '.spider/scratch/e2-tests'), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/e2-tests/placement-'));
    try {
      const fixtures = join(root, 'packages/herdr/e2e/fixtures/payloads');
      mkdirSync(fixtures, { recursive: true }); writeFileSync(join(fixtures, 'proof.test.ts'), '');
      expect(auditHarnessFiles(root)).toEqual(['packages/herdr/e2e/fixtures/payloads/proof.test.ts']);
      const outside = join(root, 'packages/herdr/e2e/unlisted'); mkdirSync(outside); writeFileSync(join(outside, 'omitted.test.ts'), '');
      expect(() => auditHarnessFiles(root)).toThrow(/uncovered harness test: .*omitted.test.ts/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports a test suffix outside the include patterns rather than hiding the file', () => {
    mkdirSync(join(process.cwd(), '.spider/scratch'), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/suffix-'));
    try {
      const fixtures = join(root, 'packages/herdr/e2e/fixtures/payloads');
      mkdirSync(fixtures, { recursive: true }); writeFileSync(join(fixtures, 'omitted.spec.mjs'), '');
      expect(() => auditHarnessFiles(root)).toThrow(/uncovered harness test: .*omitted.spec.mjs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('fails with the omitted filename instead of silently ignoring a harness test', () => {
    expect(() => assertHarnessCoverage(['packages/herdr/e2e/fixtures/payloads/proof.test.ts'], harnessIncludes.filter((glob: string) => !glob.includes('fixtures')))).toThrow(/uncovered harness test/);
    expect(() => assertHarnessCoverage(['packages/herdr/e2e/unlisted/example.test.ts'])).toThrow(/uncovered harness test: packages\/herdr\/e2e\/unlisted\/example.test.ts/);
  });
});
