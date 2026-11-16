// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { HerdrError } from '../client/parse.js';
import { snapshot } from './backup.js';

const sourceHash = '6722e17c44e9e1af7f50f2862c4ed71660ff1c0c340a5eebb475dd66c70291dd';
const manifestHash = 'e8e0a91d23a0addf19f9f4dab48f597f252a1d44e5063e4d6ae884a88cbf735d';

export async function planToastFiles(version: string, appHome: string, assets: string): Promise<{ path: string; bytes: Buffer }[]> {
  if (version === '0.1.12' || version === '0.1.13') return [];
  if (version !== '0.1.16') throw new HerdrError('upstream-version-mismatch', `Unsupported toast source version: ${version}`);
  const stock = await snapshot(join(appHome, 'mods/toast/main.js'));
  const manifest = await snapshot(join(appHome, 'mods/toast/mod.json'));
  if (!stock.bytes || stock.hash !== sourceHash || manifest.hash !== manifestHash) throw new HerdrError('upstream-source-mismatch', 'The 0.1.16 stock toast differs from the verified source');
  const names = ['NOTICE', 'filter.js', 'main.js', 'mod.json'];
  const files = await Promise.all(names.map(async name => {
    const source = await snapshot(join(assets, name));
    if (!source.bytes) throw new HerdrError('toast-assets-missing', `The packaged toast is missing ${name}`);
    return { path: join(appHome, 'mods/spider-toast', name), bytes: source.bytes };
  }));
  const importAnchor = 'import { props, closeOverlay, run, theme } from "herdr";';
  const propsAnchor = '    const p = props() ?? {};';
  const source = stock.bytes.toString('utf8');
  if (source.split(importAnchor).length !== 2 || source.split(propsAnchor).length !== 2) throw new HerdrError('upstream-source-mismatch', 'The toast source anchors differ');
  const derived = '// SPDX-License-Identifier: Apache-2.0\n// Derived from Herdr 0.1.16; see NOTICE.\n'
    + source.replace(importAnchor, importAnchor + '\nimport { automaticAgentAlert } from "./filter.js";')
      .replace(propsAnchor, propsAnchor + '\n    if (automaticAgentAlert(p)) { closeOverlay(p.overlay); return div(); }');
  if (!files.find(file => file.path.endsWith('/main.js'))!.bytes.equals(Buffer.from(derived))) throw new HerdrError('toast-recipe-mismatch', 'The packaged toast does not match the verified guarded recipe');
  return files;
}
