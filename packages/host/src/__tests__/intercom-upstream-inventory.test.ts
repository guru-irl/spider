import { expect, it } from 'vitest';
import { globSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configDefaults } from 'vitest/config';
import { loadConfigFromFile } from 'vite';
const upstream = ['broker/client-liveness.test.ts', 'broker/client.test.ts', 'broker/extension.test.ts',
  'broker/framing.test.ts', 'broker/paths.test.ts', 'broker/runtime-claim.test.ts', 'broker/spawn.test.ts',
  'config.test.ts', 'cwd.test.ts', 'format-context.test.ts', 'project-agent.test.ts', 'reply-tracker.test.ts',
  'intercom.integration.test.ts', 'test/inline-message.test.ts', 'test/overlay-width.test.ts'];
it('all fifteen upstream tests are present and selected by the CI Vitest configuration', async () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const expected = upstream.map(name => `packages/intercom/src/${name}`);
  expect(expected).toHaveLength(15);
  expect(expected.filter(name => { try { const file = lstatSync(resolve(root, name)); return !file.isFile() || file.size === 0; } catch { return true; } })).toEqual([]);
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(root, 'vitest.config.ts'));
  const configuration = loaded?.config as { test?: { include?: string[]; exclude?: string[] } };
  expect(configuration?.test).toBeDefined();
  const selected = new Set(globSync(configuration.test?.include ?? configDefaults.include,
    { cwd: root, exclude: configuration.test?.exclude ?? configDefaults.exclude }));
  expect(expected.filter(name => !selected.has(name))).toEqual([]);
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const command = workflow.split('\n').find(line => line.includes('npx vitest run --shard='));
  const args = command?.split('npx vitest run ')[1].replace(/\$\{\{[^}]+\}\}/g, 'shard').trim().split(/\s+/);
  // These reporting and partition options cannot narrow the default file set.
  expect(args?.every(arg => /^--(?:shard|maxWorkers|reporter|outputFile)=/.test(arg))).toBe(true);
}, 5000);
