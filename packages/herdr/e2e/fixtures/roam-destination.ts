// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { access, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Install only fixture-owned state; the CLI, SDK and release remain the actual packaged artifacts. */
export async function stageRoamDestination(input: { root: string; sourceAgent: string; box: string; home: string; release: string; sdk: string; cli: string }): Promise<{ agent: string; cli: string }> {
  const { root, sourceAgent, box, home, release, sdk, cli } = input;
  await Promise.all(['dist/extension.js', 'scripts/intercom-switchover.mjs', 'scripts/extension-shim.mjs'].map(path => access(join(release, path))));
  await access(join(sdk, 'dist/index.js')); await access(cli);
  const agent = join(root, 'ba'), wrapper = join(root, 'box-cli.mjs');
  const sdkLink = join(home, '.local/lib/node_modules/@earendil-works/pi-coding-agent');
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await mkdir(join(box, 'roam'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(sdkLink), { recursive: true, mode: 0o700 });
  await copyFile(join(sourceAgent, 'settings.json'), join(agent, 'settings.json'));
  await symlink(sdk, sdkLink, 'dir');
  await writeFile(join(box, 'roam/active-release.json'), JSON.stringify(release), { mode: 0o600 });
  await writeFile(wrapper, `process.env.HOME = ${JSON.stringify(home)};\nprocess.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agent)};\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`, { mode: 0o600 });
  return { agent, cli: wrapper };
}
