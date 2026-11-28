import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { verifiedHerdrFile } from '../herdr/ports.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('production template refresh retains the original backup for rollback', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const template = (await f.parts.generateTemplates(f.request, f.context))[0].path;
  const original = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === template)!;
  const current = await readFile(template);
  await verifiedHerdrFile(f.request.journalRoot, { path: template, expected: digest(current), bytes: Buffer.concat([current, Buffer.from('\nRefreshed instructions.\n')]) });
  const refreshed = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === template)!;
  expect(refreshed.before).toBe(original.before);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(template).then(() => true, () => false)).toBe(false);
});

test.each(['resume', 'theme', 'keys'] as const)('rollback preserves dependencies of a user-changed managed %s and reports it', async kind => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const warnings: string[] = []; f.parts.warn = warning => warnings.push(warning);
  let dependency: string;
  if (kind === 'resume') {
    await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('. ', '. changed '));
    dependency = join(f.h.directories.global, 'herdr/resume.sh');
  } else if (kind === 'theme') {
    await writeFile(join(f.h.directories.agent, 'settings.json'), '{"theme":"user-theme"}');
    dependency = join(f.h.directories.agent, 'themes/dracula-plus-glass.json');
  } else {
    const path = join(f.h.directories.app, 'keys.json'), keys = JSON.parse(await readFile(path, 'utf8'));
    keys.terminal['cmd-shift-o'] = 'user.action'; await writeFile(path, JSON.stringify(keys));
    dependency = join(f.h.directories.app, 'mods/spider-panel/main.js');
  }
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(dependency).then(() => true, () => false)).toBe(true);
  expect(warnings.some(warning => warning.includes('not restored'))).toBe(true);
});

test('rollback reports damaged resume markers and retains the referenced hook', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const warnings: string[] = []; f.parts.warn = warning => warnings.push(warning);
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('# spider:resume:end', '# user-edited:end'));
  await rollbackHerdr(f.request, f.parts);
  expect(warnings.some(warning => warning.includes('not restored'))).toBe(true);
  expect(await readFile(join(f.h.directories.global, 'herdr/resume.sh')).then(() => true, () => false)).toBe(true);
});
