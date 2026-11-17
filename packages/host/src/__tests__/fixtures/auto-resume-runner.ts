// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHerdrConfig } from '../../../../herdr/src/config.js';
import { createProductionHerdrCliPorts } from '../../herdr/ports.js';

const args = process.argv.slice(2);
const get = (flag: string) => args[args.indexOf(flag) + 1];
const configPath = get('--config');
const config = parseHerdrConfig(JSON.parse(await readFile(configPath, 'utf8')));
const root = config.globalRoot;
await writeFile(join(root, `ready-${process.pid}`), '');
for (let i = 0; i < 1000 && !(await readdir(root)).includes('go'); i++) await delay(10);
if (!(await readdir(root)).includes('go')) throw new Error('test barrier timed out');
const ports = createProductionHerdrCliPorts(root, process.env);
try {
  await ports.resume!({ config, configPath, packageRoot: root, journalRoot: join(root, 'journal') }, { file: get('--file'), sessionId: get('--session-id'), cwd: get('--cwd') });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await ports.dispose(); }
