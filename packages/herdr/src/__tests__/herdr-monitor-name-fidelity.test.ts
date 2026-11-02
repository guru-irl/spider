import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createClientFixture, createHerdrHarness } from './testutil.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const names = ['Compile routes', 'Builder @ remote.invalid', 'UPPER', '', 'a'.repeat(33), 't7', 't1z', '-bad', '代理', 'bad\nname', 'bad\x7fname', 'tfoo', 'test', 'm7', 'valid-name', 't1a'];
const expected = (name: string) => `bad name ${JSON.stringify(name).replace(/\x7f/g, '\\u{7f}')}: use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like an id (t7)`;

it.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('records isolated native hc name validation for comparison', async () => {
  const h = await createHerdrHarness('hc'); closes.push(() => h.close()); await h.start();
  const results = names.map(name => {
    const result = spawnSync(h.hcBinary, ['run', '--json', '--bg', '--no-notify', '--name', name, '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
    return { name, status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
  await writeFile(resolve('.spider/scratch/hc-name-native-evidence.json'), JSON.stringify(results, null, 2));
  for (const result of results.slice(0, 11)) { expect(result.status).toBe(6); expect(result.stderr).toBe(JSON.stringify({ error: { hint: 'see `hc schema`', kind: 'invalid_params', message: expected(result.name) } }) + '\n'); }
  for (const result of results.slice(11)) expect(result.status).toBe(0);
});
it.each(['standalone', 'daemon'] as const)('%s fake rejects hc-invalid readable names with the native error', async mode => {
  const h = mode === 'standalone' ? await createClientFixture() : await createHerdrHarness('fake'); closes.push(() => h.close()); if ('start' in h) await h.start();
  const corePath = join(h.localEnv.HERDR_FAKE_ROOT!, 'core.json'), before = JSON.parse(await readFile(corePath, 'utf8')).terminals;
  for (const name of names.slice(0, 11)) {
    const result = spawnSync(h.hcBinary, ['run', '--json', '--bg', '--no-notify', '--name', name, '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(6); expect(result.stdout).toBe(''); expect(result.stderr).toBe(JSON.stringify({ error: { hint: 'see `hc schema`', kind: 'invalid_params', message: expected(name) } }) + '\n');
  }
  expect(JSON.parse(await readFile(corePath, 'utf8')).terminals).toEqual(before);
  for (const name of names.slice(11)) {
    const result = spawnSync(h.hcBinary, ['run', '--json', '--bg', '--no-notify', '--name', name, '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
  }
  const payload = spawnSync(h.hcBinary, ['run', '--json', '--bg', '--no-notify', '--', process.execPath, '-e', 'setInterval(()=>{},1000)', '--', '--name', 'Bad name'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
  expect(payload.status).toBe(0);
});
