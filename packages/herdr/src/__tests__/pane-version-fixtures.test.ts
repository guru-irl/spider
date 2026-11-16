// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAFragments, type SpacesAVersion } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';
import { readAppPaneCapabilities } from '../panes/capabilities.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const marker = '/* spider-look:a-pane-park */';
function fullA(version: SpacesAVersion) {
  const recipe = loadPublishedSpacesARecipe(version);
  return replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe);
}
function fragments(version: SpacesAVersion): SpacesAFragments {
  const recipe = loadPublishedSpacesARecipe(version);
  const park = recipe.aFragments.pane!.find(p => p.id === 'a-pane-park')!;
  return { pane: [{ id: 'b-proxy-action', file: 'main.js', anchor: marker + park.replacement,
    replacement: marker + park.replacement.replace('parkFocusedTerminal(', 'parkPresentedTerminal(') }],
    menu: [{ id: 'b-proxy-menu', file: 'main.js', anchor: '/* spider-look:a-menu-remote-park */',
      replacement: '/* spider-look:a-menu-remote-park *//* proxy menu continuation */' }] };
}

for (const version of ['0.1.13', '0.1.16'] as const) describe(`full B recipe ${version}`, () => {
  test('B recipe starts from A output not stock sources', () => {
    const clean = loadSpacesAFiles(version), before = structuredClone(clean), b = fragments(version);
    expect(clean.pane!['main.js']).not.toContain(b.pane![0]!.anchor);
    const afterA = fullA(version);
    expect(afterA.pane!['main.js']).toContain(b.pane![0]!.anchor);
    const final = replaySpacesBRecipe(version, clean, b);
    expect(final.pane!['main.js']).toContain('/* spider-look:b-proxy-action */');
    expect(final.pane!['main.js']).toContain('parkPresentedTerminal(');
    expect(final.agents).toEqual(afterA.agents);
    expect(final['spider-picker']).toEqual(afterA['spider-picker']);
    expect(clean).toEqual(before);
  });

  test('B anchors occur once after retained and A patches', () => {
    const a = fullA(version), b = fragments(version);
    for (const [mod, records] of Object.entries(b)) for (const patch of records) {
      expect(a[mod]![patch.file]!.split(patch.anchor)).toHaveLength(2);
    }
    const final = replaySpacesBRecipe(version, loadSpacesAFiles(version), b);
    for (const name of ['controlled-session-close', 'spider-header-name', 'style-2', 'a-pane-park', 'b-proxy-action']) {
      expect(final.pane!['main.js']!.split(`/* spider-look:${name} */`)).toHaveLength(2);
    }
  });

  test('changed A replacement refuses B replay', () => {
    const changed = fullA(version);
    changed.pane!['main.js'] = changed.pane!['main.js']!.replace(marker, marker + 'changed A bytes');
    expect(() => replaySpacesBRecipe(version, changed, fragments(version))).toThrow(/unknown.*digest/);
  });

  test('missing source refuses rather than matching an incomplete inventory', () => {
    const files = loadSpacesAFiles(version); delete files.pane!['main.js'];
    expect(() => replaySpacesBRecipe(version, files, fragments(version))).toThrow(/missing|unknown/);
  });

  test('duplicate B anchor refuses for its actual match count', () => {
    const b = { pane: [{ id: 'b-duplicate', file: 'main.js', anchor: 'return ', replacement: 'return ' }] };
    expect(() => replaySpacesBRecipe(version, loadSpacesAFiles(version), b)).toThrow(/anchor b-duplicate matched \d+ times/);
  });

  test('an empty replacement refuses while a single space deletes an anchor', () => {
    const b = { pane: [{ id: 'b-delete', file: 'main.js', anchor: marker, replacement: '' }] };
    expect(() => replaySpacesBRecipe(version, loadSpacesAFiles(version), b)).toThrow(/replacement/);
    const park = loadPublishedSpacesARecipe(version).aFragments.pane!.find(p => p.id === 'a-pane-park')!;
    const safe = { pane: [{ ...b.pane[0]!, anchor: park.replacement.split('\n').at(-1)!, replacement: ' ' }] };
    const final = replaySpacesBRecipe(version, loadSpacesAFiles(version), safe);
    expect(final.pane!['main.js']).toContain('/* spider-look:b-delete */ ');
    expect(final.pane!['main.js']).toContain(marker);
  });

  test('full ordered repeat verifies final B bytes', () => {
    const b = fragments(version), final = replaySpacesBRecipe(version, loadSpacesAFiles(version), b);
    expect(replaySpacesBRecipe(version, final, b)).toEqual(final);
    expect(replaySpacesBRecipe(version, fullA(version), b)).toEqual(final);
    const changed = structuredClone(final);
    changed.pane!['main.js'] = changed.pane!['main.js']!.replace('b-proxy-action', 'b-proxy-action-changed');
    expect(() => replaySpacesBRecipe(version, changed, b)).toThrow(/unknown.*digest|marker/);
    const mixed = structuredClone(final); mixed.pane = loadSpacesAFiles(version).pane!;
    expect(() => replaySpacesBRecipe(version, mixed, b)).toThrow(/unknown|partial/);
  });

  test('changed inner B payload refuses even with every marker intact', () => {
    const b = fragments(version), final = replaySpacesBRecipe(version, loadSpacesAFiles(version), b);
    final.menu!['main.js'] = final.menu!['main.js']!.replace('proxy menu continuation', 'changed menu continuation');
    expect(() => replaySpacesBRecipe(version, final, b)).toThrow(/unknown.*digest/);
  });

  test('a B fragment cannot introduce an unknown file or repeated marker', () => {
    const missing = { pane: [{ id: 'b-missing', file: 'missing.js', anchor: 'one', replacement: 'two' }] };
    expect(() => replaySpacesBRecipe(version, loadSpacesAFiles(version), missing)).toThrow(/missing.*file/);
    const repeated = { pane: [{ id: 'b-repeat', file: 'main.js', anchor: marker, replacement: '/* spider-look:b-repeat */ ' }] };
    expect(() => replaySpacesBRecipe(version, loadSpacesAFiles(version), repeated)).toThrow(/marker/);
  });

  test('both fixtures include source digests and NOTICE', () => {
    const file = (name: string) => readFileSync(new URL(`./fixtures/herdr-${version}/${name}`, import.meta.url), 'utf8');
    const manifest = JSON.parse(file('manifest.json'));
    expect(manifest.version).toBe(1);
    expect(manifest.upstreamVersion).toBe(version);
    expect(manifest.source).toMatch(/Herdr/);
    expect(manifest.sources).toEqual(JSON.parse(file('source-hashes.json')));
    for (const [name, sha] of Object.entries(manifest.sources)) expect(digest(file(name))).toBe(sha);
    expect(file('NOTICE')).toContain('Licensed under the Apache License, Version 2.0.');
    expect(manifest.noticeSha256).toBe(digest(file('NOTICE')));
    expect(manifest.apiSha256).toBe(digest(file('herdr.d.ts')));
    expect(file('herdr.d.ts')).toContain('export function panes(');
    expect(manifest.commandsSha256).toBe(digest(file('commands.json')));
    expect(manifest.commandDigest).toBe(digest(JSON.stringify(JSON.parse(file('commands.json')))));
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|\/Applications\/|\.invalid\/t/);
  });

  test('isolated structured commands determine capabilities without admitting a version', () => {
    const commands = JSON.parse(readFileSync(new URL(`./fixtures/herdr-${version}/commands.json`, import.meta.url), 'utf8'));
    expect(readAppPaneCapabilities(commands)).toMatchObject({ backgroundTabCreation: version === '0.1.16', explicitTargetSwap: version === '0.1.16', noFocusConversion: false });
    expect(readAppPaneCapabilities({ ...commands, version: '0.1.12' })).toEqual(readAppPaneCapabilities(commands));
    const changed = structuredClone(commands);
    const tab = changed.commands.find((command: { name: string }) => command.name === 'tab.new');
    tab.args = tab.args.filter((arg: { name: string }) => arg.name !== 'focus');
    expect(readAppPaneCapabilities(changed).backgroundTabCreation).toBe(false);
  });
});
