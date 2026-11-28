// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
import { unknownBuiltInNotice, unsupportedHerdrVersionNotice } from '../notices.js';
export interface CloneMod { name: string; clonedFrom: { name: string; version: string }; files: Readonly<Record<string, string>>; patchState?: { version: 1; files: Readonly<Record<string, string>> } }
export const lookCloneKinds = ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const;
export interface HerdrClones { agents: CloneMod; spaces: CloneMod; pane: CloneMod; tabs: CloneMod; 'workspace-chrome': CloneMod; menu?: CloneMod; 'new-menu'?: CloneMod }
export interface LookPatch { id: string; file?: string; anchor: string; replacement: string }
export type LookModKind = keyof HerdrClones | 'picker';
export const spacesALookVersions = ['0.1.13', '0.1.16', '0.1.18'] as const;
export type SpacesALookVersion = typeof spacesALookVersions[number];
export const isSpacesALookVersion = (version: string | undefined): version is SpacesALookVersion => spacesALookVersions.some(release => release === version);
// These releases support the blur field and the same native-view helpers.
export const hasNativeLookFeatures = (version: string | undefined): version is '0.1.16' | '0.1.18' => version === '0.1.16' || version === '0.1.18';
export type AdditionalLookPatches = Partial<Record<SpacesALookVersion, Partial<Record<LookModKind, readonly LookPatch[]>>>>;
export interface DerivedLookFile { mod: string; file: string; sourceMod: string; sourceFile: string; sourceHash: string; outputHash: string; asset: string }
export interface ReleaseLookRecipe { sourceHashes: Readonly<Record<string, string>>; mods: LookPatchSet['mods']; derivedFiles: readonly DerivedLookFile[]; outputHashes: Readonly<Record<string, string>> }
export interface LookPatchSet { version: 1; upstreamVersion: string; sourceHashes?: Partial<Record<keyof HerdrClones, Readonly<Record<string, string>>>>; mods: { agents: readonly LookPatch[]; spaces: readonly LookPatch[]; pane: readonly LookPatch[]; tabs: readonly LookPatch[]; 'workspace-chrome'?: readonly LookPatch[]; menu?: readonly LookPatch[]; 'new-menu'?: readonly LookPatch[] }; spacesA?: Partial<Record<SpacesALookVersion, ReleaseLookRecipe>>; recipe?: ReleaseLookRecipe }

/** Selection is not admission: callers must verify the complete source inventory. */
export function selectLookPatches(manifest: LookPatchSet, version: string): LookPatchSet {
  if (isSpacesALookVersion(version)) {
    const recipe = manifest.spacesA?.[version];
    if (!recipe) throw new HerdrError('upstream-version-mismatch', unsupportedHerdrVersionNotice(manifest.upstreamVersion));
    const kinds = [...lookCloneKinds, 'menu', 'new-menu'] as const;
    const sourceHashes = Object.fromEntries(kinds.map(kind => [kind, Object.fromEntries(Object.entries(recipe.sourceHashes).filter(([name]) => name.startsWith(`mods/${kind}/`)).map(([name, hash]) => [name.slice(`mods/${kind}/`.length), hash]))]));
    return { version: 1, upstreamVersion: version, mods: recipe.mods, sourceHashes, recipe };
  }
  if (version !== manifest.upstreamVersion || version !== '0.1.12') throw new HerdrError('upstream-version-mismatch', unsupportedHerdrVersionNotice('0.1.12, 0.1.13, 0.1.16 and 0.1.18'));
  return manifest;
}
export type PatchedClones = HerdrClones;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const count = (source: string, needle: string) => source.split(needle).length - 1;
function validateRecords(patches: readonly LookPatch[], label: string): void {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (!/^[a-z][a-z0-9-]*$/.test(patch.id) || ids.has(patch.id) || !patch.anchor || !patch.replacement || patch.file !== undefined && (!patch.file || patch.file.startsWith('/') || patch.file.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))) throw new HerdrError('invalid-look-patches', `${label}: invalid or repeated patch ID`);
    ids.add(patch.id);
  }
}
/** Apply additional records to verified staged files, never to unverified stock. */
export function applyModPatches(files: Readonly<Record<string, string>>, patches: readonly LookPatch[], label = 'mod'): Record<string, string> {
  validateRecords(patches, label);
  const result = { ...files };
  for (const patch of patches) {
    const file = patch.file ?? 'main.js';
    let source = result[file];
    if (typeof source !== 'string') throw new HerdrError('patch-anchor-mismatch', `${label}: ${file} is absent`);
    const marker = `/* spider-look:${patch.id} */`, replacement = marker + patch.replacement;
    if (count(source, marker)) {
      if (count(source, marker) !== 1 || count(source, replacement) !== 1) throw new HerdrError('patch-anchor-mismatch', `${label}: changed or repeated marker ${patch.id}`);
      continue;
    }
    if (count(source, patch.anchor) !== 1) throw new HerdrError('patch-anchor-mismatch', `${label}: expected one anchor for ${patch.id}`);
    source = source.replace(patch.anchor, () => replacement);
    result[file] = source;
  }
  return result;
}
/** Pure staging: the installer alone backs up and compare-writes the returned files. */
export async function applyLookPatches(clones: HerdrClones, patches: LookPatchSet, options: { requireCompleteSources?: boolean } = {}): Promise<PatchedClones> {
  if (patches.version !== 1) throw new HerdrError('invalid-look-patches', 'Unknown look patch version');
  const result = { ...clones };
  const kinds: readonly (keyof HerdrClones)[] = [...lookCloneKinds, ...(patches.mods.menu ? ['menu' as const] : []), ...(patches.mods['new-menu'] ? ['new-menu' as const] : [])];
  for (const kind of kinds) {
    const clone = clones[kind];
    if (!clone) throw new HerdrError('upstream-source-unknown', unknownBuiltInNotice(kind, patches.upstreamVersion));
    if (clone.clonedFrom.name !== kind || clone.clonedFrom.version !== patches.upstreamVersion) throw new HerdrError('upstream-version-mismatch', unsupportedHerdrVersionNotice(patches.upstreamVersion));
    if (clone.patchState) {
      if (clone.patchState.version !== 1 || Object.keys(clone.files).length !== Object.keys(clone.patchState.files).length || Object.entries(clone.files).some(([file, bytes]) => clone.patchState!.files[file] !== digest(bytes))) throw new HerdrError('clone-modified', `${kind}: installed clone differs from its verified digest`);
    } else if (patches.sourceHashes || options.requireCompleteSources) {
      const known = patches.sourceHashes?.[kind];
      if (!known || !known['main.js'] || typeof clone.files['main.js'] !== 'string' || Object.entries(clone.files).some(([file, bytes]) => known[file] !== digest(bytes)) || options.requireCompleteSources && Object.keys(known).some(file => !(file in clone.files))) throw new HerdrError('upstream-source-unknown', unknownBuiltInNotice(kind, patches.upstreamVersion));
    }
    if (typeof clone.files['main.js'] !== 'string') throw new HerdrError('patch-anchor-mismatch', `${kind}: main.js is absent`);
    const composedRepeat = Boolean(clone.patchState && patches.recipe);
    validateRecords(patches.mods[kind] ?? [], kind);
    if (composedRepeat) {
      const known = patches.sourceHashes?.[kind];
      if (!known || Object.keys(known).length !== Object.keys(clone.files).length || Object.entries(clone.files).some(([file, bytes]) => {
        const hash = digest(bytes), output = patches.recipe!.outputHashes[`${kind}/${file}`];
        return file === 'main.js' ? hash !== output : hash !== output && hash !== known[file];
      })) throw new HerdrError('clone-modified', `${kind}: clone is not the verified composed result`);
    }
    const files = composedRepeat ? clone.files : applyModPatches(clone.files, patches.mods[kind] ?? [], kind);
    result[kind] = { ...clone, files, patchState: { version: 1, files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])) } };
  }
  return result;
}
