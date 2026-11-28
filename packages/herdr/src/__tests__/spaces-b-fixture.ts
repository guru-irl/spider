// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAFiles, type SpacesAFragments, type SpacesAPatch, type SpacesAVersion } from './spaces-a-fixture.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const markers = (text: string): string[] => [...text.matchAll(/\/\* spider-look:([a-z0-9-]+) \*\//g)].map(match => match[1]!);
const keys = (value: object) => Object.keys(value).sort().join('\0');
function sameInventory(actual: SpacesAFiles, expected: SpacesAFiles): boolean {
  return keys(actual) === keys(expected) && Object.entries(expected).every(([mod, files]) => !!actual[mod] && keys(actual[mod]!) === keys(files));
}
function sameBytes(actual: SpacesAFiles, expected: SpacesAFiles): boolean {
  return sameInventory(actual, expected) && Object.entries(expected).every(([mod, files]) => Object.entries(files).every(([file, bytes]) => actual[mod]![file] === bytes));
}

// A's fixture helper keeps its unique-anchor routine private. Use the same
// marker format and match rules here, only for B fragments on verified A bytes.
function applyFragment(text: string, patch: SpacesAPatch): string {
  if (!/^[a-z0-9-]+$/.test(patch.id) || !patch.anchor) throw new Error('invalid B patch identity or anchor');
  if (!patch.replacement) throw new Error(`empty B replacement for ${patch.id}`);
  const count = text.split(patch.anchor).length - 1;
  if (count !== 1) throw new Error(`anchor ${patch.id} matched ${count} times`);
  if (markers(text).includes(patch.id) || markers(patch.replacement).includes(patch.id)) throw new Error(`inconsistent B marker ${patch.id}`);
  const changed = text.replace(patch.anchor, () => `/* spider-look:${patch.id} */${patch.replacement}`);
  const ids = markers(changed);
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate marker after ${patch.id}`);
  return changed;
}

/** Reconstruct all stages from verified clean fixtures; never replay consumed anchors on final output. */
export function replaySpacesBRecipe(version: SpacesAVersion, files: SpacesAFiles, bFragments: SpacesAFragments): SpacesAFiles {
  const clean = loadSpacesAFiles(version);
  const recipe = loadPublishedSpacesARecipe(version);
  const afterA = replaySpacesARecipe(version, clean, recipe.aFragments, recipe);
  const final = structuredClone(afterA);
  for (const [mod, records] of Object.entries(bFragments)) for (const patch of records) {
    const text = final[mod]?.[patch.file];
    if (text === undefined) throw new Error(`missing B fragment file ${mod}/${patch.file}`);
    final[mod]![patch.file] = applyFragment(text, patch);
  }
  if (sameBytes(files, clean) || sameBytes(files, afterA)) return final;
  if (!sameInventory(files, final)) throw new Error('missing or unknown B recipe mod or file');
  // Comparing every final digest and marker list also verifies retained/A
  // regions that B intentionally edits. A's final checker cannot do that.
  for (const [mod, entries] of Object.entries(final)) for (const [file, expected] of Object.entries(entries)) {
    const actual = files[mod]![file]!;
    if (digest(actual) !== digest(expected) || JSON.stringify(markers(actual)) !== JSON.stringify(markers(expected)))
      throw new Error(`unknown source or output digest for ${mod}/${file}`);
  }
  return final;
}
