// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

// An isolated fixture must not inventory unrelated host sessions.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const remoteNode = '/nonexistent/remote/node';
async function remoteNodeFixture() {
  const f = await fixture();
  const calls = join(f.h.root, 'remote-node-calls.jsonl');
  const logger = join(f.h.root, 'record-node-run.mjs');
  const core = join(f.h.root, 'core-with-remote-node');
  await writeFile(calls, '');
  await writeFile(logger, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  // Model a separate machine filesystem at the transport boundary. Only remote
  // launches can resolve this path; the local doctor still sees a missing file.
  await writeFile(core, `#!/bin/bash
args=("$@")
if [[ "$1" == run ]]; then
  '${process.execPath}' '${logger}' "$@" || exit $?
  remote=0
  for ((i=0; i<\${#args[@]}-1; i++)); do
    if [[ "\${args[i]}" == --on && "\${args[i+1]}" == remote.invalid ]]; then remote=1; fi
  done
  for ((i=0; i<\${#args[@]}-1; i++)); do
    if [[ "$remote" == 1 && "\${args[i]}" == -- && "\${args[i+1]}" == '${remoteNode}' ]]; then args[i+1]='${process.execPath}'; fi
  done
fi
exec '${f.h.hcBinary}' "\${args[@]}"
`, { mode: 0o700 });
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  config.core.binary = core;
  config.machines[0].nodePath = remoteNode;
  await writeFile(f.request.configPath, JSON.stringify(config));
  // Exercise the real config lookup and installer, not a handwritten layout.
  f.request = await f.ports.request(f.request.configPath);
  f.parts = await f.ports.setupParts(f.request);
  const verify = f.parts.verify;
  f.parts.verify = async request => {
    const report = await verify(request);
    expect(report.failures, JSON.stringify(report.failures)).toEqual([]);
    return report;
  };
  return { ...f, calls };
}

test('setup checks an absolute machine Node path only on that machine', async () => {
  const f = await remoteNodeFixture();
  await expect(access(remoteNode)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toEqual([]);
  expect(report.probes).toContainEqual(expect.objectContaining({ machine: 'remote.invalid', nodePath: remoteNode, version: process.version }));
  const launches: string[][] = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const versions = launches.filter(argv => argv.includes('--version'));
  expect(versions).toHaveLength(2); // Setup and an uncached standalone doctor.
  for (const argv of versions) {
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', remoteNode, '--version']);
    expect(argv.slice(argv.indexOf('--on'), argv.indexOf('--on') + 2)).toEqual(['--on', 'remote.invalid']);
  }
}, 60_000);

test('doctor still rejects a missing local mod launcher beside an absolute remote Node path', async () => {
  const f = await remoteNodeFixture();
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  // This is the sidebar written by the production installer, including its
  // separate local launcher pin and nested remote machine configuration.
  const props = layout.children.find((node: { id: string }) => node.id === 'sidebar').content.props;
  expect(props).toMatchObject({ nodePath: process.execPath, cliPath: join(f.root, 'dist/herdr/cli.mjs'), configPath: f.request.configPath,
    machines: [expect.objectContaining({ nodePath: remoteNode })] });
  const missingLocal = join(f.h.root, 'removed-local-node');
  props.nodePath = missingLocal;
  await writeFile(path, JSON.stringify(layout));
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  const pinFailures = report.failures.filter(failure => failure.code === 'pinned-node-unavailable');
  expect(pinFailures).toEqual([expect.objectContaining({ item: 'local-node', message: expect.stringContaining(`installed mod props pins ${missingLocal}`) })]);
  expect(report.failures.some(failure => failure.message.includes(remoteNode))).toBe(false);
}, 60_000);
