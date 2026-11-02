import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function rollback(f: SetupFixture) {
  const child = spawnSync(process.execPath, [join(f.root, 'dist/herdr/cli.mjs'), 'rollback', '--config', f.request.configPath], { cwd: f.h.root, env: f.h.localEnv, encoding: 'utf8', timeout: 20000 });
  if (child.error) throw child.error;
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
}

it.each([
  { kind: 'owned file', action: 'repair' },
  { kind: 'owned file', action: 'remove' },
  { kind: 'managed field', action: 'repair' },
])('rollback retains a changed $kind, then $action completes it', async ({ kind, action }) => {
  const f = await fixture(), appSettings = join(f.request.config.app.home, 'settings.json'), originalApp = await readFile(appSettings);
  await setupHerdr(f.request, f.parts);
  await copyFile(resolve('dist/herdr/cli.mjs'), join(f.root, 'dist/herdr/cli.mjs'));
  const theme = join(f.request.config.agentDirectory, 'themes/dracula-plus-glass.json');
  const target = kind === 'managed field' ? join(f.request.config.agentDirectory, 'settings.json') : theme;
  const installed = await readFile(target), value = JSON.parse(installed.toString('utf8'));
  if (kind === 'managed field') value.theme = 'user-chosen'; else value.name = 'user-edited';
  const changed = Buffer.from(JSON.stringify(value) + '\n'); await writeFile(target, changed);
  const partial = rollback(f);
  expect(partial.exitCode, partial.stderr).toBe(3);
  expect(partial.stdout).toMatch(/^Rollback restored [1-9]\d* matching files\n$/);
  const refusal = `${target} not restored: ${kind === 'managed field' ? 'managed content was changed by the user' : 'file was changed by the user'}. Repair the retained parts and rerun rollback.\n`;
  const dependency = kind === 'managed field' ? `${theme} not restored: a retained managed part still references this file. Repair the retained parts and rerun rollback.\n` : '';
  expect(partial.stderr).toBe(refusal + dependency);
  expect(await readFile(target)).toEqual(changed);
  expect(await readFile(appSettings)).toEqual(originalApp);
  expect(JSON.parse(await readFile(join(f.request.journalRoot, 'journal.json'), 'utf8')).entries.map((entry: { path: string }) => entry.path)).toContain(target);
  if (action === 'remove') await unlink(target); else await writeFile(target, installed);
  const complete = rollback(f);
  expect(complete.exitCode, complete.stderr).toBe(0);
  expect(complete.stderr).toBe('');
  expect(complete.stdout).toMatch(/^Rollback restored \d+ matching files\n$/);
  expect(JSON.parse(await readFile(join(f.request.journalRoot, 'journal.json'), 'utf8')).entries).toEqual([]);
}, 60000);

it('documents incomplete rollback separately from usage errors', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await runHerdrCli(['--help'])).toBe(0);
  expect(output).toContain('3 incomplete rollback');
  expect(output).toContain('2 usage error');
  expect(await runHerdrCli(['rollback', '--unknown'])).toBe(2);
});
