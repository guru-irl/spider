// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHerdrConfig } from '../config.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it.each(['offer', 'auto'] as const)('doctor reports resume mode %s', async resume => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'doctor-resume-'));
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: join(root, 'agent'), globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [], resume });
  await writeFile(config.core.config, 'notes = false\n');
  const request = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
  let output = '';
  const ports: HerdrCliPorts = {
    request: async () => request,
    setupParts: async () => { throw new Error('not used'); },
    doctorParts: async () => ({ globalRoot: root, inspect: async () => ({ failures: [] }), targets: async () => [], launchHistory: async () => [], probeMachineNode: async () => '' }),
    stdout: text => { output += text; }, stderr: text => { output += text; },
  };
  expect(await runHerdrCli(['doctor'], ports)).toBe(0);
  expect(output).toContain(`resume-mode: ${resume}`);
});
