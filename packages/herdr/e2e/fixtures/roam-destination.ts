// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { access, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Install only fixture-owned state; the CLI, SDK and release remain the actual packaged artifacts. */
export async function stageRoamDestination(input: { root: string; sourceAgent: string; box: string; home: string; release: string; checkout: string; cli: string }): Promise<{ agent: string; cli: string }> {
  const { root, sourceAgent, box, home, release, checkout, cli } = input;
  const sdk = join(checkout, 'node_modules/@earendil-works/pi-coding-agent');
  await Promise.all(['dist/extension.js', 'scripts/intercom-switchover.mjs', 'scripts/extension-shim.mjs'].map(path => access(join(release, path))));
  await access(join(sdk, 'dist/index.js')); await access(cli);
  const cliPath = relative(release, cli);
  if (!cliPath || cliPath.startsWith('..') || isAbsolute(cliPath)) throw new Error('fixture CLI is outside the release');
  const agent = join(root, 'ba'), wrapper = join(root, 'box-cli.mjs');
  const prefix = join(home, '.local'), sdkLink = join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  const stagedRelease = join(prefix, 'spider-releases', 'a'.repeat(64), 'node_modules/@guru-irl/spider');
  const settings = JSON.parse(await readFile(join(sourceAgent, 'settings.json'), 'utf8')) as { packages?: unknown; [key: string]: unknown };
  if (!Array.isArray(settings.packages)) throw new Error('fixture settings lack packages');
  let matches = 0;
  settings.packages = settings.packages.map(item => item === release ? (matches++, stagedRelease) : item);
  if (matches !== 1) throw new Error('fixture settings must declare the release once');
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await mkdir(join(box, 'roam'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(sdkLink), { recursive: true, mode: 0o700 });
  await mkdir(dirname(stagedRelease), { recursive: true, mode: 0o700 });
  await cp(release, stagedRelease, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  await symlink(sdk, sdkLink, 'dir');
  await writeFile(join(box, 'roam/active-release.json'), JSON.stringify(stagedRelease), { mode: 0o600 });
  await writeFile(wrapper, `process.env.HOME = ${JSON.stringify(home)};\nprocess.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agent)};\nawait import(${JSON.stringify(pathToFileURL(join(stagedRelease, cliPath)).href)});\n`, { mode: 0o600 });
  return { agent, cli: wrapper };
}
