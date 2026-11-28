// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAVersion } from '../../src/__tests__/spaces-a-fixture.js';
import { applyLookPatches, type HerdrClones } from '../../src/look/patches.js';
import { notificationAgentPatches } from '../../src/look/notification-patches.js';
import { rewriteImportPrefix } from '../../../host/src/herdr/imports.js';
import { ownedPath, scratchRoot } from '../harness/environment.js';

export type StagedSpacesA = { files: { path: string; sha256: string; source: string }[]; manifest: string; unresolved: string[] };

export async function stageSpacesAFiles(destination: string, version: SpacesAVersion, assetRoot: string = fileURLToPath(new URL('../../assets/', import.meta.url))): Promise<StagedSpacesA> {
  const root = ownedPath(scratchRoot(), resolve(destination));
  const recipe = loadPublishedSpacesARecipe(version);
  const composed = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe);
  const patchInputs = Object.fromEntries(['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'].map(kind => [kind, { name: kind, clonedFrom: { name: kind, version }, files: composed[kind] }])) as unknown as HerdrClones;
  const notified = await applyLookPatches(patchInputs, { version: 1, upstreamVersion: version, mods: { agents: notificationAgentPatches, spaces: [], pane: [], tabs: [] } });
  composed.agents = { ...notified.agents.files };
  const payload = new Map<string, { bytes: Buffer; source: string }>();
  const put = (path: string, bytes: string | Buffer, source: string) => payload.set(path, { bytes: Buffer.from(bytes), source });
  const layout = JSON.parse(await readFile(new URL(`../../src/__tests__/fixtures/herdr-${version}/layouts/main.json`, import.meta.url), 'utf8'));
  const edits = JSON.parse(await readFile(join(assetRoot, 'look/layout-edits.json'), 'utf8'));
  Object.assign(layout, edits.spacesA?.[version]?.root ?? {});
  put('layouts/main.json', JSON.stringify(layout, null, 2) + '\n', `stock:${version}/layouts/main.json+asset:look/layout-edits.json`);
  put('keys.json', await readFile(new URL(`../../src/__tests__/fixtures/herdr-${version}/keys.json`, import.meta.url)), `stock:${version}/keys.json`);
  const clones = { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', 'workspace-chrome': 'spider-chrome', menu: 'spider-menu' };
  for (const [mod, clone] of Object.entries(clones)) {
    for (const [file, contents] of Object.entries(composed[mod]!)) put(`mods/${clone}/${file}`, contents, `recipe:${version}/${mod}/${file}`);
  }
  const assets = async (directory: string, target: string, children = false) => {
    for (const entry of await readdir(join(assetRoot, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isDirectory()) throw new Error(`unexpected asset entry ${directory}/${entry.name}`);
      if (entry.name.endsWith('.d.ts')) continue;
      if (directory === 'shared' && entry.name === 'navigation.js' && !['mods/spider-agents/shared', 'mods/spider-panel/shared', 'mods/spider-picker/shared'].includes(target)) continue;
      put(`${target}/${children && entry.name === 'children.js' ? 'spider-children.js' : entry.name}`, await readFile(join(assetRoot, directory, entry.name)), `asset:${directory}/${entry.name}`);
    }
  };
  await assets('agents', 'mods/spider-agents', true);
  await assets('spaces', 'mods/spider-spaces');
  await assets('pane', 'mods/spider-pane');
  await assets('tabs', 'mods/spider-tabs');
  await assets('mods/spider', 'mods/spider-panel');
  put('mods/spider-agents/sound.js', await readFile(join(assetRoot, 'mods/spider/sound.js')), 'asset:mods/spider/sound.js');
  await assets('picker', 'mods/spider-picker');
  if (composed['spider-toast']) for (const file of ['NOTICE', 'filter.js', 'main.js', 'mod.json']) {
    const asset = `toast/${version === '0.1.18' && file === 'main.js' ? 'main-0.1.18.js' : file}`;
    const bytes = await readFile(join(assetRoot, asset));
    const expected = composed['spider-toast'][file];
    if (expected !== undefined && !bytes.equals(Buffer.from(expected))) throw new Error(`unexpected toast asset ${asset}`);
    put(`mods/spider-toast/${file}`, bytes, `asset:${asset}`);
  }
  for (const clone of [...Object.values(clones), 'spider-panel', 'spider-picker']) {
    await assets('shared', `mods/${clone}/shared`);
    if (['spider-agents', 'spider-panel', 'spider-picker'].includes(clone)) {
      put(`mods/${clone}/spider-children.js`, await readFile(join(assetRoot, 'agents/children.js')), 'asset:agents/children.js');
    }
  }
  for (const shape of ['triangle', 'diamond', 'pentagon', 'hexagon', 'heptagon', 'octagon', 'star']) {
    put(`mods/spider-picker/space-${shape}.svg`, await readFile(join(assetRoot, 'agents', `space-${shape}.svg`)), `asset:agents/space-${shape}.svg`);
  }
  const unresolved: string[] = [];
  for (const [file, entry] of payload) {
    if (!file.endsWith('.js')) continue;
    let source = entry.bytes.toString('utf8');
    if (file.startsWith('mods/spider-picker/')) source = rewriteImportPrefix(source, '../shared/', './shared/').source;
    source = rewriteImportPrefix(source, '../agents/children.js', '../spider-children.js').source;
    entry.bytes = Buffer.from(source);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if ((tree as any).parseDiagnostics.length) throw new Error(`invalid staged JavaScript ${file}`);
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.') && !payload.has(resolve('/', dirname(file), specifier).slice(1))) unresolved.push(`${file}: ${specifier}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  if (unresolved.length) throw new Error(`unresolved staged imports ${unresolved.join(', ')}`);
  const files: { path: string; sha256: string; source: string }[] = [];
  for (const [relative, entry] of [...payload].sort(([a], [b]) => a.localeCompare(b))) {
    const file = ownedPath(root, join(root, relative));
    await mkdir(dirname(file), { recursive: true });
    const current = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current?.isSymbolicLink()) throw new Error(`symbolic staging target ${relative}`);
    await writeFile(file, entry.bytes);
    files.push({ path: relative, sha256: createHash('sha256').update(entry.bytes).digest('hex'), source: entry.source });
  }
  const manifest = join(root, 'manifest.tsv');
  await writeFile(manifest, 'path\tsha256\tsource\n' + files.map(file => `${file.path}\t${file.sha256}\t${file.source}`).join('\n') + '\n');
  return { files, manifest, unresolved };
}
