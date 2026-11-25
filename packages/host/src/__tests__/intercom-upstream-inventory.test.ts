import { expect, it } from 'vitest';
import { globSync, lstatSync, readFileSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { configDefaults } from 'vitest/config';
import { loadConfigFromFile } from 'vite';
import { parse } from 'yaml';
it('declares the intercom workspace dependency consistently', () => {
  const host = JSON.parse(readFileSync(resolve('packages/host/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
  expect(host.dependencies['@spider/intercom']).toBe('0.0.0');
  expect(lock.packages['packages/host'].dependencies['@spider/intercom']).toBe('0.0.0');
  expect(lock.packages['node_modules/@spider/intercom']).toEqual({ resolved: 'packages/intercom', link: true });
  // npm ci links a workspace only when its version satisfies the declared range; otherwise it fetches from the registry.
  for (const [name, range] of Object.entries(host.dependencies as Record<string, string>)) {
    if (!name.startsWith('@spider/')) continue;
    const dir = lock.packages[`node_modules/${name}`]?.resolved as string;
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    expect({ name, version: pkg.version }).toEqual({ name, version: range });
    expect(lock.packages[dir].version).toBe(range);
  }
});
it('keeps native story routing aligned with the policy, including hidden workflow inputs', () => {
  const policy = JSON.parse(readFileSync('scripts/test-resources.json', 'utf8'));
  const workflow = parse(readFileSync('.github/workflows/herdr-stories.yml', 'utf8'));
  const patterns: string[] = workflow.on.pull_request.paths;
  expect(patterns).toEqual(policy.optional.stories);
  for (const [file, expected] of [
    ['.github/workflows/ci.yml', true], ['.node-version', true],
    ['packages/roam/src/store-prune.ts', true], ['docs/guide/herdr.md', true],
    ['docs/architecture/README.md', false], ['packages/pstack/skills/how/SKILL.md', false],
  ] as const) {
    const selected = patterns.reduce((included, pattern) => matchesGlob(file, pattern.replace(/^!/, '')) ? !pattern.startsWith('!') : included, false);
    expect(selected, file).toBe(expected);
  }
});
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
  // The selector's approved root roster must stay equal to full Vitest discovery.
  expect([...selected].sort()).toEqual(globSync('packages/**/src/**/*.test.ts', { cwd: root, exclude: configDefaults.exclude }).sort());
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const jobs = parse(workflow).jobs;
  const full = jobs.test;
  expect(full.if).toContain("github.event_name != 'pull_request'");
  const command = full.steps.find((step: { name?: string }) => step.name === 'Test shard').run;
  const args = command.split('npx vitest run ')[1].replace(/\$\{\{[^}]+\}\}/g, 'shard').trim().split(/\s+/);
  // Main still discovers all upstream files, not a PR selection or test-name filter.
  expect(args.every((arg: string) => /^--(?:shard|maxWorkers|reporter|outputFile)=/.test(arg))).toBe(true);
  const pr = jobs['pr-test'];
  expect(pr.strategy.matrix.shard).toEqual([1, 2]);
  expect(pr.steps.some((step: { run?: string }) => step.run?.includes('node scripts/select-tests.mjs'))).toBe(true);
  expect(pr.steps.some((step: { run?: string }) => step.run?.includes('node scripts/run-selected-tests.mjs'))).toBe(true);
  expect(jobs.checks.name).toBe('typecheck · test · build');
  expect(jobs.checks.needs).toContain('pr-test');
  expect(jobs).not.toHaveProperty('required');
}, 5000);
