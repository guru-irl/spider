import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { prerequisiteDiagnostics } from '../../../roam/src/inventory';
import { healthyInventory } from '../../../roam/src/__tests__/bootstrap-fixture';

it('pins each GitHub Actions Node install to a version Roam has tested', () => {
  const dir = '.github/workflows';
  const seen: string[] = [];
  for (const file of readdirSync(dir).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(join(dir, file), 'utf8')) as {
      jobs: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
    };
    for (const [job, config] of Object.entries(workflow.jobs)) {
      for (const step of config.steps ?? []) {
        if (!step.uses?.startsWith('actions/setup-node@')) continue;
        const nodeVersion = step.with?.['node-version'];
        const label = `${file}:${job}`;
        expect(typeof nodeVersion, label).toBe('string');
        expect(prerequisiteDiagnostics({ ...healthyInventory(), nodeVersion: String(nodeVersion) }), label).toEqual([]);
        seen.push(file);
      }
    }
  }
  expect(seen).toContain('ci.yml');
  expect(seen).toContain('pr.yml');
});
