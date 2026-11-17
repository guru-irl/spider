// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
import { applyModPatches, type LookPatch } from './patches.js';

export const crossMachineKinds = ['pane', 'tabs', 'menu', 'new-menu', 'agents'] as const;
export const crossMachineHelpers = ['pane/actions.js', 'pane/machine.js', 'machines/actions.js', 'machines/picker.js'] as const;
type CrossMachineKind = typeof crossMachineKinds[number];
type ModFiles = Readonly<Record<string, Readonly<Record<string, string>>>>;
export interface CrossMachineLookRecipe {
  mods: Readonly<Record<CrossMachineKind, readonly LookPatch[]>>;
  inputHashes: Readonly<Record<string, string>>;
  outputHashes: Readonly<Record<string, string>>;
  recordsHash: string;
  helperHashes: Readonly<Record<typeof crossMachineHelpers[number], string>>;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (message: string): never => { throw new HerdrError('cross-machine-recipe-mismatch', message); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Missing cross-machine recipe data');
  return value as Record<string, unknown>;
}
function hashes(value: unknown): Readonly<Record<string, string>> {
  const entries = Object.entries(record(value));
  if (!entries.length || entries.some(([name, hash]) => !crossMachineKinds.some(kind => name.startsWith(`${kind}/`)) || name.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return fail('Invalid cross-machine file digests');
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Parse packaged records once at the asset boundary; missing releases never mean no B. */
export function selectCrossMachinePatches(value: unknown, version: string): CrossMachineLookRecipe {
  const manifest = record(value);
  if (manifest.version !== 1 || !['0.1.13', '0.1.16'].includes(version)) return fail('Unsupported cross-machine recipe version');
  const mods = record(record(manifest.versions)[version]);
  if (Object.keys(mods).length !== crossMachineKinds.length || crossMachineKinds.some(kind => !Array.isArray(mods[kind]) || !(mods[kind] as unknown[]).length)) return fail('Incomplete cross-machine records');
  const checks = record(record(manifest.checks)[version]);
  if (checks.recordsHash !== digest(JSON.stringify(mods))) return fail('Cross-machine records differ from their verified digest');
  const inputHashes = hashes(checks.inputHashes), outputHashes = hashes(checks.outputHashes);
  const helperHashes = record(checks.helperHashes);
  if (Object.keys(helperHashes).length !== crossMachineHelpers.length || crossMachineHelpers.some(name => typeof helperHashes[name] !== 'string' || !/^[a-f0-9]{64}$/.test(helperHashes[name] as string))) return fail('Invalid cross-machine helper digests');
  if (Object.keys(inputHashes).sort().join('\0') !== Object.keys(outputHashes).sort().join('\0') || crossMachineKinds.some(kind => !inputHashes[`${kind}/main.js`])) return fail('Incomplete cross-machine file digests');
  return { mods: mods as CrossMachineLookRecipe['mods'], inputHashes, outputHashes, recordsHash: checks.recordsHash as string, helperHashes: helperHashes as CrossMachineLookRecipe['helperHashes'] };
}
function matches(files: ModFiles, expected: Readonly<Record<string, string>>): boolean {
  const entries = crossMachineKinds.flatMap(kind => Object.entries(files[kind] ?? {}).map(([file, bytes]) => [`${kind}/${file}`, digest(bytes)] as const));
  return entries.length === Object.keys(expected).length && entries.every(([name, hash]) => expected[name] === hash);
}
/** Accept only the complete A result or the complete B result, never a partial transition. */
export function applyCrossMachinePatches(files: ModFiles, recipe: CrossMachineLookRecipe): Record<CrossMachineKind, Record<string, string>> {
  const repeat = matches(files, recipe.outputHashes);
  if (!repeat && !matches(files, recipe.inputHashes)) throw new HerdrError('cross-machine-input-mismatch', 'Cross-machine patches require the verified Spaces A result');
  const output = Object.fromEntries(crossMachineKinds.map(kind => [kind, repeat ? { ...files[kind] } : applyModPatches(files[kind]!, recipe.mods[kind], kind)])) as Record<CrossMachineKind, Record<string, string>>;
  if (!matches(output, recipe.outputHashes)) throw new HerdrError('cross-machine-output-mismatch', 'Cross-machine output differs from its verified digest');
  return output;
}
