// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated, startInteractiveShell, installedShells } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test.each(installedShells)('a new %s starts silently after production rollback removes the resume hook', async binary => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await rollbackHerdr(f.request, f.parts);
  const home = join(f.h.root, 'shell-home'); await mkdir(home);
  const rc = await readFile(f.request.config.shellRc);
  await writeFile(join(home, '.bashrc'), rc); await writeFile(join(home, '.zshrc'), rc);
  expect(await startInteractiveShell(binary, home, { ...f.h.localEnv, HC_TERMINAL_ID: 'missing.invalid', HC_TERMINAL_SOCKET: f.h.localSocket })).toEqual({ code: 0, output: '' });
});

test.each(installedShells)('a new %s ignores a missing resume hook or pinned runtime silently', async binary => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const home = join(f.h.root, 'shell-home'); await mkdir(home);
  const rc = await readFile(f.request.config.shellRc, 'utf8'), hook = join(f.h.directories.global, 'herdr/resume.sh');
  const originalHook = await readFile(hook);
  await writeFile(join(home, '.bashrc'), rc); await writeFile(join(home, '.zshrc'), rc);
  await unlink(hook);
  const env = { ...f.h.localEnv, HC_TERMINAL_ID: 'missing.invalid', HC_TERMINAL_SOCKET: f.h.localSocket };
  expect(await startInteractiveShell(binary, home, env)).toEqual({ code: 0, output: '' });
  await writeFile(hook, originalHook);
  const missingRuntimeRc = rc.split(process.execPath).join(join(f.h.root, 'absent-node'));
  await writeFile(join(home, '.bashrc'), missingRuntimeRc); await writeFile(join(home, '.zshrc'), missingRuntimeRc);
  expect(await startInteractiveShell(binary, home, env)).toEqual({ code: 0, output: '' });
});
