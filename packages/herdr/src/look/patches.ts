// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
export interface CloneMod { name: string; clonedFrom: { name: string; version: string }; files: Readonly<Record<string, string>>; patchState?: { version: 1; files: Readonly<Record<string, string>> } }
export interface HerdrClones { agents: CloneMod; spaces: CloneMod; pane: CloneMod; tabs: CloneMod }
export interface LookPatch { id: string; anchor: string; replacement: string }
export interface LookPatchSet { version: 1; upstreamVersion: string; mods: { agents: readonly LookPatch[]; spaces: readonly LookPatch[]; pane: readonly LookPatch[]; tabs: readonly LookPatch[] } }
export type PatchedClones = HerdrClones;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Pure staging: the installer alone backs up and compare-writes the returned files. */
export async function applyLookPatches(clones: HerdrClones, patches: LookPatchSet): Promise<PatchedClones> {
  if (patches.version !== 1) throw new HerdrError('invalid-look-patches', 'Unknown look patch version');
  const result = { ...clones };
  for (const kind of ['agents', 'spaces', 'pane', 'tabs'] as const) {
    const clone = clones[kind];
    if (clone.clonedFrom.name !== kind || clone.clonedFrom.version !== patches.upstreamVersion) throw new HerdrError('upstream-version-mismatch', `${kind}: explicitly rebase patches from the current built-in`);
    if (clone.patchState) {
      if (clone.patchState.version !== 1 || Object.keys(clone.files).length !== Object.keys(clone.patchState.files).length || Object.entries(clone.files).some(([file, bytes]) => clone.patchState!.files[file] !== digest(bytes))) throw new HerdrError('clone-modified', `${kind}: installed clone differs from its verified digest`);
    }
    let source = clone.files['main.js'];
    if (typeof source !== 'string') throw new HerdrError('patch-anchor-mismatch', `${kind}: main.js is absent`);
    const ids = new Set<string>();
    for (const patch of patches.mods[kind]) {
      if (!/^[a-z][a-z0-9-]*$/.test(patch.id) || ids.has(patch.id) || !patch.anchor || !patch.replacement) throw new HerdrError('invalid-look-patches', `${kind}: invalid or repeated patch ID`);
      ids.add(patch.id);
      const marker = `/* spider-look:${patch.id} */`;
      const replacement = marker + patch.replacement;
      if (count(source, marker)) {
        if (count(source, marker) !== 1 || count(source, replacement) !== 1) throw new HerdrError('patch-anchor-mismatch', `${kind}: changed or repeated marker ${patch.id}`);
        continue;
      }
      if (count(source, patch.anchor) !== 1) throw new HerdrError('patch-anchor-mismatch', `${kind}: expected one anchor for ${patch.id}`);
      source = source.replace(patch.anchor, replacement);
    }
    const files = { ...clone.files, 'main.js': source };
    result[kind] = { ...clone, files, patchState: { version: 1, files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])) } };
  }
  return result;
}
