import { globSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, it } from 'vitest';

it('lists literal bundle consumers that need selection without a recorded import', () => {
  const policy = JSON.parse(readFileSync('scripts/test-resources.json', 'utf8')) as { bundles: { consumers: string[] } };
  const consumers = new Set(policy.bundles.consumers);
  const self = relative(process.cwd(), import.meta.filename).replaceAll('\\', '/');
  const omitted = globSync('packages/*/src/**/*.{ts,mjs}').filter(file => file !== self
    && (file.includes('/__tests__/') || file.includes('test'))
    && /dist\/|test-bundle/.test(readFileSync(file, 'utf8'))
    && !consumers.has(file));
  expect(omitted).toEqual([]);
});
