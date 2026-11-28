import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import base from '../../assets/look/patches.json' with { type: 'json' };
import retained from './fixtures/spaces-a-retained.json' with { type: 'json' };
import hashes13 from './fixtures/herdr-0.1.13/source-hashes.json' with { type: 'json' };
import hashes16 from './fixtures/herdr-0.1.16/source-hashes.json' with { type: 'json' };
import hashes18 from './fixtures/herdr-0.1.18/source-hashes.json' with { type: 'json' };
import type { SpacesALookVersion } from '../look/patches.js';

export type SpacesAVersion = SpacesALookVersion;
export type SpacesAFiles = Record<string, Record<string, string>>;
export type SpacesAPatch = { id: string; file: string; anchor: string; replacement: string };
export type SpacesAFragments = Record<string, readonly SpacesAPatch[]>;
export type SpacesADerivedFile = { mod: string; file: string; sourceMod: string; sourceFile: string; sourceHash: string; contents: string; outputHash: string };
export type SpacesARecipe = {
  sourceHashes: Record<string, string>;
  retainedOverrides: Record<string, SpacesAPatch[]>;
  supersededIds: Record<string, string[]>;
  originalFailures: string[];
  mods: Record<string, SpacesAPatch[]>;
  retainedMods: Record<string, SpacesAPatch[]>;
  aFragments: SpacesAFragments;
  derivedFiles: SpacesADerivedFile[];
  outputHashes: Record<string, string>;
  markers: Record<string, string[]>;
};

const sourceHashes: Record<SpacesAVersion, Record<string, string>> = { '0.1.13': hashes13, '0.1.16': hashes16, '0.1.18': hashes18 };
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const markerIds = (text: string): string[] => [...text.matchAll(/\/\* spider-look:([a-z0-9-]+) \*\//g)].map(m => m[1]!);

export function loadSpacesAFiles(version: SpacesAVersion): SpacesAFiles {
  const files: SpacesAFiles = {};
  for (const [name, expected] of Object.entries(sourceHashes[version])) {
    const contents = readFileSync(new URL(`./fixtures/herdr-${version}/${name}`, import.meta.url), 'utf8');
    if (digest(contents) !== expected) throw new Error(`source digest mismatch for ${name}`);
    if (!name.startsWith('mods/')) continue;
    const [, mod, file] = name.split('/');
    (files[mod!] ??= {})[file!] = contents;
  }
  return files;
}

function retainedRecipe(version: SpacesAVersion): SpacesARecipe {
  const metadata = retained[version];
  const mods: Record<string, SpacesAPatch[]> = {};
  for (const [mod, patches] of Object.entries(base.mods)) {
    const removed = (metadata.supersededIds as Record<string, string[]>)[mod] ?? [];
    const overrides = (metadata.retainedOverrides as Record<string, SpacesAPatch[]>)[mod] ?? [];
    mods[mod] = patches.filter(p => !removed.includes(p.id)).map(p => overrides.find(v => v.id === p.id) ?? { ...p, file: 'main.js' });
  }
  return { ...structuredClone(metadata), sourceHashes: sourceHashes[version], mods, retainedMods: mods, aFragments: {}, derivedFiles: [], outputHashes: {}, markers: {} };
}

function checkRecipe(version: SpacesAVersion, recipe: SpacesARecipe, fragments: SpacesAFragments): void {
  for (const [mod, removals] of Object.entries(recipe.supersededIds)) {
    const patches = (base.mods as Record<string, { id: string }[]>)[mod];
    for (const id of removals) if (!patches?.some(p => p.id === id)) throw new Error(`unknown removal ${mod}/${id}`);
    if (new Set(removals).size !== removals.length) throw new Error(`duplicate removal in ${mod}`);
  }
  const expected = retainedRecipe(version);
  for (const field of ['sourceHashes', 'supersededIds', 'retainedOverrides', 'retainedMods'] as const) {
    if (JSON.stringify(recipe[field]) !== JSON.stringify(expected[field])) throw new Error(`altered retained recipe ${field}`);
  }
  const ordered = { ...expected.mods };
  for (const [mod, patches] of Object.entries(fragments)) ordered[mod] = [...(ordered[mod] ?? []), ...patches];
  if (JSON.stringify(recipe.mods) !== JSON.stringify(ordered) || JSON.stringify(recipe.aFragments) !== JSON.stringify(fragments)) throw new Error('altered retained or A patch order');
}

function apply(text: string, patch: SpacesAPatch): string {
  if (!/^[a-z0-9-]+$/.test(patch.id) || !patch.anchor) throw new Error('invalid patch identity or anchor');
  const count = text.split(patch.anchor).length - 1;
  if (count !== 1) throw new Error(`anchor ${patch.id} matched ${count} times`);
  if (markerIds(text).includes(patch.id) || markerIds(patch.replacement).includes(patch.id)) throw new Error(`inconsistent marker ${patch.id}`);
  const result = text.replace(patch.anchor, () => `/* spider-look:${patch.id} */${patch.replacement}`);
  const markers = markerIds(result);
  if (new Set(markers).size !== markers.length) throw new Error(`duplicate marker after ${patch.id}`);
  return result;
}

function compile(version: SpacesAVersion, fragments: SpacesAFragments, recipe: SpacesARecipe): SpacesAFiles {
  checkRecipe(version, recipe, fragments);
  const files = loadSpacesAFiles(version);
  for (const [mod, patches] of Object.entries(recipe.retainedMods)) for (const patch of patches) {
    const text = files[mod]?.[patch.file];
    if (text === undefined) throw new Error(`missing retained file ${mod}/${patch.file}`);
    files[mod]![patch.file] = apply(text, patch);
  }
  for (const [mod, patches] of Object.entries(fragments)) {
    const regions: Record<string, { start: number; end: number; id: string }[]> = {};
    for (const patch of patches) {
      const text = files[mod]?.[patch.file];
      if (text === undefined) throw new Error(`missing fragment file ${mod}/${patch.file}`);
      const start = text.indexOf(patch.anchor), end = start + patch.anchor.length;
      const previous = regions[patch.file] ??= [];
      if (start >= 0 && previous.some(p => start < p.end && p.start < end)) throw new Error(`overlapping A region ${patch.id}`);
      const changed = apply(text, patch);
      const delta = changed.length - text.length;
      for (const region of previous) if (region.start >= end) { region.start += delta; region.end += delta; }
      previous.push({ start, end: end + delta, id: patch.id });
      files[mod]![patch.file] = changed;
    }
  }
  const copies = new Set<string>();
  for (const artifact of recipe.derivedFiles) {
    const name = `${artifact.mod}/${artifact.file}`;
    if (copies.has(name)) throw new Error(`duplicate derived file ${name}`);
    copies.add(name);
    const upstream = sourceHashes[version][`mods/${artifact.sourceMod}/${artifact.sourceFile}`];
    if (!upstream || upstream !== artifact.sourceHash || digest(artifact.contents) !== artifact.outputHash) throw new Error(`derived file digest mismatch for ${name}`);
    (files[artifact.mod] ??= {})[artifact.file] = artifact.contents;
  }
  return files;
}

export function composeSpacesARecipe(version: SpacesAVersion, fragments: SpacesAFragments = {}, derivedFiles: SpacesADerivedFile[] = []): SpacesARecipe {
  const recipe = retainedRecipe(version);
  recipe.derivedFiles = derivedFiles;
  recipe.aFragments = structuredClone(fragments);
  recipe.mods = { ...recipe.retainedMods };
  for (const [mod, patches] of Object.entries(fragments)) recipe.mods[mod] = [...(recipe.mods[mod] ?? []), ...patches];
  const files = compile(version, fragments, recipe);
  for (const [mod, entries] of Object.entries(files)) for (const [file, text] of Object.entries(entries)) {
    const name = `${mod}/${file}`;
    recipe.outputHashes[name] = digest(text);
    recipe.markers[name] = markerIds(text);
  }
  return recipe;
}

export function loadPublishedSpacesARecipe(version: SpacesAVersion): SpacesARecipe {
  const record = (base as unknown as { spacesA?: Record<SpacesAVersion, Omit<SpacesARecipe, 'retainedMods' | 'aFragments' | 'derivedFiles'> & { derivedFiles: (Omit<SpacesADerivedFile, 'contents'> & { asset: string })[] }> }).spacesA?.[version];
  if (!record) throw new Error(`missing published recipe for ${version}`);
  const retainedMods = retainedRecipe(version).retainedMods;
  const aFragments = Object.fromEntries(Object.entries(record.mods).map(([mod, patches]) => [mod, patches.slice(retainedMods[mod]?.length ?? 0)]).filter(([, patches]) => (patches as SpacesAPatch[]).length));
  const derivedFiles = record.derivedFiles.map(file => ({ ...file, contents: readFileSync(new URL(`../../assets/${file.asset}`, import.meta.url), 'utf8') }));
  return { ...record, retainedMods, aFragments: aFragments as SpacesAFragments, derivedFiles };
}

export const spacesARecipes: Record<SpacesAVersion, SpacesARecipe> = {
  '0.1.13': composeSpacesARecipe('0.1.13'),
  '0.1.16': composeSpacesARecipe('0.1.16'),
  '0.1.18': composeSpacesARecipe('0.1.18'),
};

/** Reconstruct expected bytes from clean fixtures instead of reusing consumed anchors. */
export function replaySpacesARecipe(version: SpacesAVersion, files: SpacesAFiles, fragments: SpacesAFragments = {}, recipe: SpacesARecipe = composeSpacesARecipe(version, fragments)): SpacesAFiles {
  const final = compile(version, fragments, recipe);
  const clean = loadSpacesAFiles(version);
  const sameFiles = (a: SpacesAFiles, b: SpacesAFiles): boolean => Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.entries(b).every(([mod, entries]) => Object.keys(a[mod]!).sort().join() === Object.keys(entries).sort().join() && Object.entries(entries).every(([file, text]) => a[mod]![file] === text));
  for (const [mod, entries] of Object.entries(final)) for (const [file, text] of Object.entries(entries)) {
    const name = `${mod}/${file}`;
    if (recipe.outputHashes[name] !== digest(text) || JSON.stringify(recipe.markers[name]) !== JSON.stringify(markerIds(text))) throw new Error(`recorded output digest or marker mismatch for ${name}`);
  }
  if (sameFiles(files, clean)) return final;
  if (Object.keys(files).sort().join() !== Object.keys(final).sort().join()) throw new Error('missing or unknown mod');
  let cleanCount = 0, finalCount = 0;
  for (const [mod, entries] of Object.entries(final)) {
    if (Object.keys(files[mod]!).sort().join() !== Object.keys(entries).sort().join()) throw new Error(`missing or unknown file in ${mod}`);
    for (const [file, text] of Object.entries(entries)) {
      const name = `${mod}/${file}`, actual = files[mod]![file]!;
      if (recipe.outputHashes[name] !== digest(text) || JSON.stringify(recipe.markers[name]) !== JSON.stringify(markerIds(text))) throw new Error(`recorded output digest or marker mismatch for ${name}`);
      if (actual === text) finalCount++;
      else if (actual === clean[mod]?.[file]) cleanCount++;
      else throw new Error(`unknown source or output digest for ${name}`);
    }
  }
  if (cleanCount && finalCount) {
    const changed = Object.entries(final).flatMap(([mod, entries]) => Object.entries(entries).filter(([file, text]) => text !== clean[mod]?.[file]).map(([file]) => files[mod]![file] === final[mod]![file]));
    if (changed.some(Boolean) && changed.some(x => !x)) throw new Error('partial final output');
  }
  return final;
}
