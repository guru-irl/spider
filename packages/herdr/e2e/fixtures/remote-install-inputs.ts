// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { HerdrConfig } from '../../src/contracts.js';
import type { Suite } from '../harness/suite.js';
import type { RemoteSuite } from '../harness/remote.js';
import { HarnessError } from '../harness/environment.js';
import { assertDestinationPaths, destinationPath } from '../harness/destination.js';
import type { InstallOptions } from './install-inputs.js';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const inputPath = (suite: Suite) => destinationPath(suite, (suite as RemoteSuite).remote.metadata.root + '/inputs/packed-runtime.mjs');

/** Called explicitly by remote profile consumers. prepareInstallInputs still refuses missing inputs. */
export async function remoteInstallOptions(suite: Suite): Promise<InstallOptions> {
  if (suite.options.tier !== 'remote') return {};
  const remote = (suite as RemoteSuite).remote, m = remote.metadata;
  const source = inputPath(suite), cwd = destinationPath(suite, m.root + '/work');
  await assertDestinationPaths(suite, [source, cwd, m.root + '/runtime', m.nodePath]);
  const bytes = await readFile(suite.packed.remoteRuntime);
  const upload = await suite.cores!.hc(['file', 'write', '--on', suite.cores!.machine, '--json', source], 'local', { input: bytes.toString() });
  if (upload.exitCode !== 0) throw new HarnessError('remote-input-upload-failed', upload.stderr || upload.stdout, upload);
  const directory = await remote.exec(`umask 077; mkdir -p ${quote(cwd)}; chmod 700 ${quote(m.root + '/inputs')}; chmod 600 ${quote(source)}`);
  if (directory.exitCode !== 0) throw new HarnessError('remote-input-directory-failed', directory.stderr, directory);
  const machines: HerdrConfig['machines'] = [{ name: suite.cores!.machine as HerdrConfig['machines'][number]['name'], aliases: ['route.invalid'],
    runtime: { directory: m.root + '/runtime', cwd, commands: { shell: ['perl', '-e', 'alarm shift; exec @ARGV', '180', '/bin/sh'], javascript: [m.nodePath] } } }];
  await validateRemoteInstallInputs(suite, machines);
  await suite.evidence('remote-install-inputs.json', { home: m.env.HOME, root: m.root, source, sha256: createHash('sha256').update(bytes).digest('hex'), machines, upload });
  return { machines };
}

/** Explicit options are not authorization: prove both their paths and the staged packed artifact. */
export async function validateRemoteInstallInputs(suite: Suite, machines: HerdrConfig['machines']): Promise<void> {
  if (suite.options.tier !== 'remote') return;
  if (!machines.length || machines.some(machine => machine.name !== suite.cores!.machine)) throw new HarnessError('P3-remote-install-inputs', 'remote inputs must name the suite-owned destination');
  const source = inputPath(suite), remote = (suite as RemoteSuite).remote;
  const paths = [source, ...machines.flatMap(machine => [machine.runtime.directory, ...(machine.runtime.cwd ? [machine.runtime.cwd] : []), ...(machine.nodePath ? [machine.nodePath] : [])])];
  await assertDestinationPaths(suite, paths);
  const hash = createHash('sha256').update(await readFile(suite.packed.remoteRuntime)).digest('hex');
  const code = `const fs=require('node:fs'),crypto=require('node:crypto');const path=${JSON.stringify(source)};const s=fs.lstatSync(path);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&63)!==0||crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')!==${JSON.stringify(hash)})throw Error('remote-install-input-invalid');console.log(JSON.stringify({source:path,sha256:${JSON.stringify(hash)}}));`;
  const result = await remote.exec(`${quote(remote.metadata.nodePath)} -e ${quote(code)}`);
  if (result.exitCode !== 0) throw new HarnessError('P3-remote-install-inputs', 'the owned packed Linux runtime input is absent or invalid', result);
}
