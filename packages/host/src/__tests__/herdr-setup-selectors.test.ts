import { afterEach, expect, it, vi } from 'vitest';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../../herdr/src/setup/backup.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function installedFiles(f: SetupFixture) {
  const files: Record<string, { hash: string; mode: number; mtime: number }> = {};
  async function walk(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) { for (const entry of await readdir(path)) await walk(join(path, entry)); }
    else files[path] = { hash: digest(await readFile(path)), mode: info.mode, mtime: info.mtimeMs };
  }
  for (const path of [f.request.config.app.home, f.request.config.agentDirectory, f.request.config.globalRoot, f.request.config.core.config, f.request.config.shellRc]) await walk(path);
  return files;
}

it.each(['ambiguous name', 'duplicate file', 'duplicate name and file'])('setup rejects %s before backups, managed writes or layout changes', async kind => {
  const f = await fixture(), first = join(f.request.config.agentDirectory, 'sessions/one.jsonl');
  for (const id of ['one', 'two']) await writeFile(join(f.request.config.agentDirectory, `sessions/${id}.jsonl`), [
    JSON.stringify({ type: 'session', version: 3, id, cwd: f.h.root }),
    JSON.stringify({ type: 'session_info', name: 'saved name' }),
  ].join('\n') + '\n');
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  config.spaces = kind === 'ambiguous name' ? [{ name: 'First', sessions: [{ name: 'saved name' }] }]
    : [{ name: 'First', sessions: [{ file: first }] }, { name: 'Second', sessions: [kind === 'duplicate file' ? { file: first } : { name: 'saved name', sessionId: 'one' }] }];
  await writeFile(f.request.configPath, JSON.stringify(config));
  const before = await installedFiles(f), calls = (await f.h.calls()).filter(call => call.argv[0] === 'run').length;
  let errors = '';
  const code = await runHerdrCli(['setup', '--config', f.request.configPath], { ...f.ports, stdout: () => {}, stderr: message => { errors += message; } });
  expect(code).toBe(1);
  expect(errors).toContain(kind === 'ambiguous name' ? 'session-selector-ambiguous:' : 'session-selector-duplicate:');
  expect(await installedFiles(f)).toEqual(before);
  expect((await f.h.calls()).filter(call => call.argv[0] === 'run').slice(calls)).toEqual([]);
}, 60000);
