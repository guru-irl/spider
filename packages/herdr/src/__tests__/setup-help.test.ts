// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHerdrCli } from '../setup/cli.js';

test('CLI help marks doctor and rollback configuration paths optional', async () => {
  let output = '';
  expect(await runHerdrCli(['--help'], {
    request: async () => { throw new Error('Help must not read configuration'); },
    setupParts: async () => { throw new Error('Help must not compose setup'); },
    doctorParts: async () => { throw new Error('Help must not compose doctor'); },
    stdout: text => output += text,
    stderr: text => { throw new Error(text); },
  })).toBe(0);
  expect(output).toContain('doctor [--config <absolute-user-file>]');
  expect(output).toContain('rollback [--config <absolute-user-file>]');
});

test('Herdr NOTICE names the published spider package root licence', async () => {
  const notice = await readFile(resolve('packages/herdr/assets/look/NOTICE'), 'utf8');
  expect(notice).toContain('The complete licence is shipped at licenses/herdr-apache-2.0.txt at the root of the spider package.');
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  expect(manifest.files).toContain('licenses/herdr-apache-2.0.txt');
  expect(await readFile(resolve('licenses/herdr-apache-2.0.txt'), 'utf8')).toContain('Copyright [yyyy] [name of copyright owner]');
});
