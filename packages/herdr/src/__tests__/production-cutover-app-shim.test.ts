// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createAppClient } from '../client/app.js';
import { cutoverAppScript } from './production-cutover-fixture.js';

const run = promisify(execFile);
let root: string;
let app: string;
let layout: string;
let calls: string;

beforeEach(async () => {
  const parent = resolve('.spider/scratch/cutover-app');
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, "app's space-"));
  app = join(root, 'app');
  layout = join(root, 'layout.json');
  calls = join(root, 'calls');
  const fallback = join(root, 'fallback.mjs');
  await writeFile(fallback, `import {appendFile} from 'node:fs/promises';\nawait appendFile(${JSON.stringify(calls)}, 'called\\n');\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
  await writeFile(app, cutoverAppScript(process.execPath, fallback, layout));
  await chmod(app, 0o700);
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('serves version and current layout in real processes without starting the Node app', async () => {
  const doc = { spaces: [{ id: 's1', name: 'One', tabs: [{ id: 't1', name: 'Tab', terminals: [{ terminal: 'term', pane: 'pane' }] }] }] };
  await writeFile(layout, JSON.stringify(doc));
  expect((await run(app, ['--version'])).stdout.trim()).toBe('herdr-app 0.1.12');
  const client = createAppClient({ binary: app, env: process.env });
  expect(await client.listSpaces()).toEqual([{ id: 's1', name: 'One', machine: null, tabs: [{ id: 't1', name: 'Tab' }] }]);
  expect(await client.ownerPlacement('term' as never)).toEqual({ space: 's1', tab: 't1', pane: 'pane' });
  await writeFile(layout, '{"spaces":[]}');
  expect(await client.listSpaces()).toEqual([]);
  await expect(access(calls)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('forwards changing app commands and their arguments to a real Node process', async () => {
  const result = await run(app, ['do', 'space.select', '--name', 'with spaces']);
  expect(JSON.parse(result.stdout)).toEqual(['app', 'do', 'space.select', '--name', 'with spaces']);
  await expect(access(calls)).resolves.toBeUndefined();
});

test('a missing layout makes the spawned app command fail', async () => {
  await expect(run(app, ['ls'])).rejects.toMatchObject({ code: 1 });
  await expect(access(calls)).rejects.toMatchObject({ code: 'ENOENT' });
});
