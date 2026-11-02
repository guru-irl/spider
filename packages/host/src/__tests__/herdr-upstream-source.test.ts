// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { cp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function stockFixture() {
  const f = await fixture();
  const source = resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/mods');
  for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome']) await cp(join(source, kind), join(f.h.directories.app, 'mods', kind), { recursive: true });
  return f;
}

test('setup accepts the complete unmodified built-in sources', async () => {
  const f = await stockFixture();
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(await readFile(join(f.h.directories.app, 'mods/spider-pane/close.svg'))).toEqual(await readFile(join(f.h.directories.app, 'mods/pane/close.svg')));
}, 60000);

test('doctor asks for setup again when installed panel, sidebar or shared feed files are older than the package', async () => {
  const f = await stockFixture(); await setupHerdr(f.request, f.parts);
  const doctor = await f.ports.doctorParts(f.request);
  for (const [item, source, installed] of [
    ['mods', 'mods/spider/data.js', 'mods/spider-panel/data.js'],
    ['clones', 'agents/children.js', 'mods/spider-agents/spider-children.js'],
    ['mods', 'shared/feed.js', 'mods/spider-panel/shared/feed.js'],
  ] as const) {
    const path = join(f.root, 'packages/herdr/assets', source), before = await readFile(path), installedPath = join(f.h.directories.app, installed), oldInstalled = await readFile(installedPath);
    await writeFile(path, Buffer.concat([before, Buffer.from('\n// updated\n')]));
    const report = await doctor.inspect(item, f.request);
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed', message: expect.stringMatching(/spider mods[\s\S]*this spider version/i), repair: expect.stringMatching(/run setup again/i) }));
    expect(await readFile(installedPath)).toEqual(oldInstalled);
    await writeFile(path, before);
  }
}, 60000);

test.each(['main', 'manifest', 'icon', 'added', 'missing'] as const)('setup refuses %s changes to built-in files before installing anything', async change => {
  const f = await stockFixture(), base = join(f.h.directories.app, 'mods/pane');
  const file = join(base, change === 'main' ? 'main.js' : change === 'manifest' ? 'mod.json' : change === 'added' ? 'unexpected.js' : 'close.svg');
  if (change === 'missing') await unlink(file);
  else if (change === 'added') await writeFile(file, 'export default 1;\n');
  else await writeFile(file, (await readFile(file, 'utf8')) + '\n');
  const modified = await readFile(file).catch(() => null);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upstream-source-unknown', message: expect.stringMatching(/pane[\s\S]*0\.1\.12/i) });
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  expect(await readFile(file).catch(() => null)).toEqual(modified);
  expect(await readFile(join(f.h.directories.app, 'mods/spider-pane/main.js')).catch(() => null)).toBeNull();
}, 60000);
