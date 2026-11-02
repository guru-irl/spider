import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { globalConfigForTest } from './global-config.testutil.js';
import { resolve, join } from 'node:path';

const run = promisify(execFile);

test('a per-test global key restores the original config bytes after repeated writes', async () => {
  const root = await mkdtemp(resolve('.spider/scratch/config-helper-'));
  const file = join(root, 'config.json');
  const original = '{ "herdr.enabled": false, "unrelated": 7 }\n';
  try {
    await writeFile(file, original);
    const config = globalConfigForTest(root);
    config.set('herdr.enabled', true); config.set('herdr.config', 'fixture.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'herdr.enabled': true, 'herdr.config': 'fixture.json', unrelated: 7 });
    config.restore(); config.restore();
    expect(await readFile(file, 'utf8')).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a per-test global key removes the config file it created on cleanup', async () => {
  const root = await mkdtemp(resolve('.spider/scratch/config-helper-'));
  try {
    const config = globalConfigForTest(root);
    config.set('herdr.enabled', true);
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    config.restore();
    expect(existsSync(join(root, 'config.json'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe.sequential('automatic per-test cleanup', () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(resolve('.spider/scratch/config-helper-auto-')); await writeFile(join(root, 'config.json'), '{"herdr.enabled":false}'); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  test('sets a key without explicitly restoring it', async () => {
    globalConfigForTest(root).set('herdr.enabled', true);
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))['herdr.enabled']).toBe(true);
  });
  test('the next test sees the previous key value', async () => {
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))['herdr.enabled']).toBe(false);
  });
});

test('file teardown restores a preexisting global config before the next file in the same worker', async () => {
  const checkout = resolve('.');
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/config-isolation-'));
  const baseline = { 'herdr.enabled': 'auto', sentinel: 'original' };
  const marker = join(root, 'seeded');
  const globalPath = `resolve(${JSON.stringify(checkout)}, '.spider/scratch/vitest-global', String(process.pid), 'config.json')`;
  try {
    await writeFile(join(root, 'seed.ts'), `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const file = ${globalPath};
if (!existsSync(${JSON.stringify(marker)})) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ${JSON.stringify(JSON.stringify(baseline))}); writeFileSync(${JSON.stringify(marker)}, String(process.pid)); }
`);
    await writeFile(join(root, 'a.test.ts'), `import { expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
test('deliberately leaks a global key', () => { const file = ${globalPath}; expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(${JSON.stringify(baseline)}); writeFileSync(file, JSON.stringify({ 'herdr.enabled': true, 'herdr.config': 'leaked.json' })); });
`);
    await writeFile(join(root, 'b.test.ts'), `import { expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
test('observes the original config in the next file', () => { expect(readFileSync(${JSON.stringify(marker)}, 'utf8')).toBe(String(process.pid)); const file = ${globalPath}; expect(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined).toEqual(${JSON.stringify(baseline)}); });
`);
    await writeFile(join(root, 'vitest.config.ts'), `import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
class Ordered extends BaseSequencer { async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); } }
export default defineConfig({ test: { include: [${JSON.stringify(join(root, '*.test.ts'))}], setupFiles: [${JSON.stringify(join(root, 'seed.ts'))}, ${JSON.stringify(join(checkout, 'vitest.setup.ts'))}], sequence: { setupFiles: 'list', sequencer: Ordered }, pool: 'forks', isolate: false, maxWorkers: 1, fileParallelism: false } });
`);
    const result = await run(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', join(root, 'vitest.config.ts')], { cwd: checkout, env: { ...process.env, TMPDIR: root }, timeout: 30_000 });
    expect(result.stdout).toContain('2 passed');
  } finally {
    if (existsSync(marker)) {
      const pid = (await readFile(marker, 'utf8')).trim();
      if (/^\d+$/.test(pid)) await rm(join(checkout, '.spider/scratch/vitest-global', pid), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
