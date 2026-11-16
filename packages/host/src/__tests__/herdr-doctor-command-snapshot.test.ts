// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { doctorHerdr, type DoctorParts } from '../../../herdr/src/setup/doctor.js';
import type { SetupRequest } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';

const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const validCommands = [
  { name: 'mod.open', args: [{ name: 'name', required: true }] },
  { name: 'terminal.park', args: [{ name: 'terminal', required: true }] },
  { name: 'pane.close', args: [] },
  { name: 'tab.new', args: [] },
  { name: 'terminal.open', args: [] },
  { name: 'terminal.keep', args: [] },
  { name: 'pane.split', args: [] },
];

async function fixture() {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'doctor-')); roots.push(root);
  const appHome = join(root, 'app'), agentDirectory = join(root, 'agent'), globalRoot = join(root, 'global');
  for (const directory of [appHome, agentDirectory, globalRoot]) await mkdir(directory, { mode: 0o700 });
  const packageRoot = resolve('.'), schema = join(root, 'commands.json'), log = join(root, 'calls.log'), app = join(root, 'app-cli.cjs');
  await writeFile(join(appHome, 'keys.json'), await readFile(join(packageRoot, 'packages/herdr/assets/keys.json')));
  await writeFile(join(root, 'core.toml'), 'notes = false\n');
  await writeFile(log, '');
  await writeFile(app, `#!${process.execPath}\nconst {appendFileSync,readFileSync}=require('node:fs');\nif(process.argv[2]!=='commands') throw new Error('Unexpected app command');\nappendFileSync(${JSON.stringify(log)},'commands\\n');\nprocess.stdout.write(readFileSync(${JSON.stringify(schema)},'utf8'));\n`, { mode: 0o700 });
  const config = parseHerdrConfig({ app: { binary: app, home: appHome }, core: { binary: process.execPath, config: join(root, 'core.toml') }, agentDirectory, globalRoot, shellRc: join(root, 'shellrc'), spaces: [], machines: [] });
  const request: SetupRequest = { config, packageRoot, configPath: join(root, 'config.json'), journalRoot: join(root, 'journal') };
  const ports = createProductionHerdrCliPorts(packageRoot, { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot });
  disposals.push(() => ports.dispose());
  const parts = await ports.doctorParts(request);
  const doctor: DoctorParts = {
    ...parts,
    inspect: (...args) => args[0] === 'keys' || args[0] === 'pane-capabilities' ? parts.inspect(...args) : Promise.resolve({ failures: [] }),
    targets: async () => [], launchHistory: async () => [], probeRuntimeRoot: undefined,
  };
  return { request, parts, doctor, log: () => readFile(log, 'utf8'), reply: (value: unknown) => writeFile(schema, typeof value === 'string' ? value : JSON.stringify({ commands: value })) };
}

test('doctor reports key and pane capabilities from fresh read-only listings', async () => {
  const f = await fixture();
  const invalid = validCommands.filter(command => command.name !== 'pane.split').map(command => command.name === 'terminal.park' ? { ...command, args: [{ name: 'terminal', required: false }] } : command);
  await f.reply(invalid);
  const first = await doctorHerdr(f.request, f.doctor);
  expect(first.failures).toContainEqual(expect.objectContaining({ item: 'keys', code: 'native-command-mismatch', message: 'terminal.park does not require terminal' }));
  expect(first.warnings).toContainEqual(expect.objectContaining({ item: 'pane-capabilities', code: 'pane-command-unavailable', message: 'Required pane command is unavailable: pane.split' }));
  const firstCalls = await f.log(); expect(firstCalls).toMatch(/^(?:commands\n)+$/);

  await f.reply(validCommands);
  const second = await doctorHerdr(f.request, f.doctor);
  expect(second.failures.filter(failure => failure.item === 'keys')).toEqual([]);
  expect(second.warnings.filter(warning => warning.item === 'pane-capabilities')).toEqual([]);
  expect(second.information).toContainEqual(expect.objectContaining({ item: 'pane-capabilities', code: 'pane-capabilities' }));
  expect((await f.log()).slice(firstCalls.length)).toMatch(/^(?:commands\n)+$/);
});

test('a failed listing warns both checks and is retried by the next doctor pass', async () => {
  const f = await fixture(); await f.reply('not valid JSON');
  const failed = await doctorHerdr(f.request, f.doctor);
  expect(failed.warnings).toContainEqual(expect.objectContaining({ item: 'keys', code: 'inspection-unavailable', message: expect.stringContaining('native commands') }));
  expect(failed.warnings).toContainEqual(expect.objectContaining({ item: 'pane-capabilities', code: 'pane-capabilities-unknown' }));
  const firstCalls = await f.log(); expect(firstCalls).toMatch(/^(?:commands\n)+$/);
  await f.reply(validCommands);
  const recovered = await doctorHerdr(f.request, f.doctor);
  expect(recovered.warnings.filter(warning => warning.item === 'pane-capabilities')).toEqual([]);
  expect(recovered.warnings).not.toContainEqual(expect.objectContaining({ item: 'keys', message: expect.stringContaining('native commands') }));
  expect((await f.log()).slice(firstCalls.length)).toMatch(/^(?:commands\n)+$/);
});

test('standalone inspections and concurrent doctor passes use fresh listings', async () => {
  const f = await fixture(); await f.reply(validCommands);
  expect((await f.parts.inspect('keys', f.request)).failures).toEqual([]);
  await f.reply(validCommands.filter(command => command.name !== 'terminal.park'));
  expect((await f.parts.inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'native-command-missing', message: 'Native command is missing: terminal.park' }));
  await f.reply(validCommands);
  const standaloneCalls = await f.log(); expect(standaloneCalls).toBe('commands\ncommands\n');
  const reports = await Promise.all([doctorHerdr(f.request, f.doctor), doctorHerdr(f.request, f.doctor)]);
  for (const report of reports) {
    expect(report.failures.filter(failure => failure.item === 'keys')).toEqual([]);
    expect(report.information).toContainEqual(expect.objectContaining({ item: 'pane-capabilities', code: 'pane-capabilities' }));
  }
  expect((await f.log()).slice(standaloneCalls.length)).toMatch(/^(?:commands\n){2,}$/);
});
