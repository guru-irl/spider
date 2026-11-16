// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absolutePath, HerdrError } from '../client/parse.js';
import { snapshot } from './backup.js';
export const PANE_ENTRY_MODS = ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down', 'spider-pane-waiting'] as const;
export async function planPaneModFiles(input: { assetsRoot: string; appHome: string; nodePath: string; cliPath: string; fonts: unknown; modIds: readonly string[] }): Promise<{ path: string; bytes: Buffer; mode?: number }[]> {
  for (const path of [input.assetsRoot, input.appHome, input.nodePath, input.cliPath]) absolutePath(path);
  const files: { path: string; bytes: Buffer; mode?: number }[] = [];
  for (const [suffix, place] of [['', 'tab'], ['-right', 'right'], ['-down', 'down']] as const) {
    const directory = join(input.appHome, 'mods', 'spider-machine-picker' + suffix), path = join(directory, 'config.json'), current = await snapshot(path);
    if (current.bytes !== null && current.mode !== 0o600) throw new HerdrError('picker-config-insecure', 'Machine picker configuration must be private');
    files.push({ path: join(directory, 'main.js'), bytes: Buffer.from(`// SPDX-License-Identifier: MIT\nimport { machinePickerView } from './picker.js';\nexport default machinePickerView(${JSON.stringify(place)});\n`) },
      { path: join(directory, 'mod.json'), bytes: Buffer.from(JSON.stringify({ place: 'none', title: 'Choose machine', overlay: { kind: 'popup', at: 'top', offset: 40, width: 640, height: 0.8, frame: 'none' } }, null, 2) + '\n') },
      { path, mode: 0o600, bytes: Buffer.from(JSON.stringify({ version: 1, nodePath: input.nodePath, cliPath: input.cliPath, checkMode: false, fonts: input.fonts }, null, 2) + '\n') });
    for (const name of ['picker.js', 'actions.js']) files.push({ path: join(directory, name), bytes: await readFile(join(input.assetsRoot, 'machines', name)) });
  }
  // Stage common entry dependencies; verified stock clone bodies remain version-admitted separately.
  files.push({ path: join(input.appHome, 'mods/spider-tabs/presentation-move.js'), bytes: await readFile(join(input.assetsRoot, 'agents/move.js')) });
  const actions = await readFile(join(input.assetsRoot, 'machines/actions.js'));
  for (const name of ['spider-pane', 'spider-tabs', ...['spider-menu', 'spider-new-menu'].filter(name => input.modIds.includes(name))]) files.push({ path: join(input.appHome, 'mods', name, 'machines/actions.js'), bytes: actions });
  const waiting = join(input.appHome, 'mods/spider-pane-waiting');
  files.push({ path: join(waiting, 'mod.json'), bytes: Buffer.from('{"place":"none","title":"Connecting"}\n') },
    { path: join(waiting, 'main.js'), bytes: Buffer.from("// SPDX-License-Identifier: MIT\nimport { View, div } from 'gpui-kit';\nexport default class WaitingPane extends View { render() { return div().child('Connecting…'); } }\n") });
  return files;
}
