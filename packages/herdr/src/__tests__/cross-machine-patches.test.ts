// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { applyCrossMachinePatches, selectCrossMachinePatches, crossMachineKinds } from '../look/cross-machine.js';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';

const manifest = () => JSON.parse(readFileSync(new URL('../../assets/look/cross-machine-patches.json', import.meta.url), 'utf8'));

test('published B recipes match their composed fragments', () => {
  const result = spawnSync(process.execPath, ['scripts/compose-spaces-b.mjs', '--check'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Published Spaces B recipes match composed output');
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  function data() {
    const a = loadPublishedSpacesARecipe(version);
    const clean = loadSpacesAFiles(version);
    const afterA = replaySpacesARecipe(version, clean, a.aFragments, a);
    const b = manifest();
    const expected = replaySpacesBRecipe(version, clean, b.versions[version]);
    const recipe = selectCrossMachinePatches(b, version);
    return { clean, afterA, expected, recipe };
  }

  test(`${version} applies B only to A's verified result and repeats byte-for-byte`, () => {
    const { afterA, expected, recipe } = data();
    const before = structuredClone(afterA);
    const output = applyCrossMachinePatches(afterA, recipe);
    expect(output).toEqual(Object.fromEntries(crossMachineKinds.map(kind => [kind, expected[kind]])));
    expect(applyCrossMachinePatches(output, recipe)).toEqual(output);
    expect(afterA).toEqual(before);
    for (const [kind, records] of Object.entries(recipe.mods)) for (const patch of records) expect(output[kind as typeof crossMachineKinds[number]]['main.js']!.split(`/* spider-look:${patch.id} */`)).toHaveLength(2);
  });

  for (const state of ['stock', 'partial', 'changed-input', 'changed-output', 'missing-file', 'extra-file'] as const) {
    test(`${version} refuses ${state} without mutating its input`, () => {
      const { clean, afterA, expected, recipe } = data();
      const files = structuredClone(state === 'stock' ? clean : state === 'changed-output' ? expected : afterA);
      if (state === 'partial') files.pane = expected.pane!;
      if (state === 'changed-input' || state === 'changed-output') files.pane!['main.js'] += '\n// changed bytes\n';
      if (state === 'missing-file') delete files.menu!['main.js'];
      if (state === 'extra-file') files.menu!['extra.js'] = '// unexpected\n';
      const before = structuredClone(files);
      expect(() => applyCrossMachinePatches(files, recipe)).toThrowError(expect.objectContaining({ code: 'cross-machine-input-mismatch' }));
      expect(files).toEqual(before);
    });
  }

  test(`${version} checks the resulting B bytes as well as the A input`, () => {
    const { afterA, recipe } = data();
    const broken = structuredClone(recipe);
    broken.outputHashes = { ...broken.outputHashes, 'agents/main.js': '0'.repeat(64) };
    expect(() => applyCrossMachinePatches(afterA, broken)).toThrowError(expect.objectContaining({ code: 'cross-machine-output-mismatch' }));
  });

  for (const state of ['missing-release', 'missing-record', 'changed-record', 'missing-checks', 'missing-digest', 'bad-digest'] as const) {
    test(`${version} refuses ${state} in the packaged recipe`, () => {
      const b = manifest();
      if (state === 'missing-release') delete b.versions[version];
      if (state === 'missing-record') b.versions[version].menu.pop();
      if (state === 'changed-record') b.versions[version].menu[0].replacement += ' ';
      if (state === 'missing-checks') delete b.checks[version];
      if (state === 'missing-digest') delete b.checks[version].inputHashes['tabs/main.js'];
      if (state === 'bad-digest') b.checks[version].inputHashes['tabs/main.js'] = 'bad';
      expect(() => selectCrossMachinePatches(b, version)).toThrowError(expect.objectContaining({ code: 'cross-machine-recipe-mismatch' }));
    });
  }
}
