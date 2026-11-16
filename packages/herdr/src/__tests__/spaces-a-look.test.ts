import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import base from '../../assets/look/patches.json' with { type: 'json' };
import { composeSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, spacesARecipes, loadPublishedSpacesARecipe, type SpacesAFragments } from './spaces-a-fixture.js';
import probes from './fixtures/spaces-a-anchor-probes.json' with { type: 'json' };

it('checks published recipe bytes without rewriting the manifest', () => {
  const manifest = new URL('../../assets/look/patches.json', import.meta.url);
  const before = readFileSync(manifest, 'utf8');
  const result = spawnSync(process.execPath, ['scripts/compose-spaces-a.mjs', '--check'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(manifest, 'utf8')).toBe(before);
});

for (const version of ['0.1.13', '0.1.16'] as const) describe(`Spaces A recipe ${version}`, () => {
  it('publishes the complete ordered Agents recipe with numeric-title repair', () => {
    const published = (base as unknown as { spacesA?: Record<string, any> }).spacesA?.[version];
    expect(published, 'complete release recipe').toBeDefined();
    const agents = JSON.parse(readFileSync(new URL(`../../assets/look/spaces-a-sidebar/agents-${version}.json`, import.meta.url), 'utf8'));
    expect(published.mods.agents).toEqual([...spacesARecipes[version].retainedMods.agents!, ...agents]);
    const recipe = composeSpacesARecipe(version, { agents });
    const final = replaySpacesARecipe(version, loadSpacesAFiles(version), { agents }, recipe);
    expect(published.outputHashes['agents/main.js']).toBe(recipe.outputHashes['agents/main.js']);
    expect(published.markers['agents/main.js']).toEqual(recipe.markers['agents/main.js']);
    expect(replaySpacesARecipe(version, final, { agents }, recipe)).toEqual(final);
    expect(final.agents!['main.js']).toContain('/* spider-look:a-agents-names */');
  });

  it('publishes complete local Spaces recipes with exact global-index drag regions', () => {
    const published = (base as unknown as { spacesA: Record<string, any> }).spacesA[version];
    const agents = JSON.parse(readFileSync(new URL(`../../assets/look/spaces-a-sidebar/agents-${version}.json`, import.meta.url), 'utf8'));
    const spaces = JSON.parse(readFileSync(new URL(`../../assets/look/spaces-a-sidebar/spaces-${version}.json`, import.meta.url), 'utf8'));
    expect(published.mods.spaces).toEqual([...spacesARecipes[version].retainedMods.spaces!, ...spaces]);
    const fragments = { agents, spaces };
    const recipe = composeSpacesARecipe(version, fragments);
    const final = replaySpacesARecipe(version, loadSpacesAFiles(version), fragments, recipe);
    expect(published.outputHashes['spaces/main.js']).toBe(recipe.outputHashes['spaces/main.js']);
    expect(replaySpacesARecipe(version, final, fragments, recipe)).toEqual(final);
    expect(spaces.find((p: any) => p.id === 'a-spaces-row-identity').anchor.split('\n')).toHaveLength(3);
    expect(final.spaces!['main.js']).not.toMatch(/refreshMachines\(|async reconnect\(/);
    expect(final.spaces!['main.js']).toContain('/* spider-look:a-spaces-drag */');
  });

  it('replays the complete published recipe and selects only the supported derived toast', () => {
    const recipe = loadPublishedSpacesARecipe(version);
    const files = loadSpacesAFiles(version);
    const final = replaySpacesARecipe(version, files, recipe.aFragments, recipe);
    expect(final['spider-picker']?.['main.js']).toBe(readFileSync(new URL('../../assets/picker/main.js', import.meta.url), 'utf8'));
    expect(recipe.derivedFiles.map(file => `${file.mod}/${file.file}`)).toEqual(version === '0.1.13'
      ? ['spider-picker/main.js', 'spider-picker/mod.json', 'agents/mod.json']
      : ['spider-picker/main.js', 'spider-picker/mod.json', 'spider-toast/main.js', 'spider-toast/mod.json', 'agents/mod.json']);
    expect(JSON.parse(final.agents!['mod.json']!)).toMatchObject({ capabilities: { clipboard: { write: true } } });
    expect(final.toast).toEqual(files.toast);
    expect(replaySpacesARecipe(version, final, recipe.aFragments, recipe)).toEqual(final);
    const layout = JSON.parse(readFileSync(new URL('../../assets/look/layout-edits.json', import.meta.url), 'utf8'));
    expect(layout.root.toast).toBeUndefined();
    expect(layout.spacesA?.[version]?.root?.toast).toBe(version === '0.1.16' ? 'spider-toast' : undefined);
    for (const [mod, entries] of Object.entries(final)) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: entries['main.js'], encoding: 'utf8' });
      expect(checked.status, `${mod}: ${checked.stderr}`).toBe(0);
    }
  });

  it('replays all 22 non-overlapping structural probes without treating them as View payloads', () => {
    const files = loadSpacesAFiles(version);
    const fragments = probes[version];
    expect(Object.values(fragments).flat()).toHaveLength(22);
    const identity = fragments.spaces.find(p => p.id === 'a-spaces-row-identity')!;
    expect(identity.anchor.split('\n')).toHaveLength(3);
    expect(identity.anchor).not.toContain('return v_flex()');
    const final = replaySpacesARecipe(version, files, fragments);
    expect(replaySpacesARecipe(version, final, fragments)).toEqual(final);
    const broad = structuredClone(fragments);
    broad.spaces.find(p => p.id === 'a-spaces-row-identity')!.anchor += '\n    return v_flex()';
    broad.spaces.find(p => p.id === 'a-spaces-row-identity')!.replacement = broad.spaces.find(p => p.id === 'a-spaces-row-identity')!.anchor;
    const avatar = broad.spaces.find(p => p.id === 'a-spaces-avatar')!;
    const retained = replaySpacesARecipe(version, files).spaces!['main.js']!;
    const start = retained.indexOf(identity.anchor), end = retained.indexOf(avatar.anchor) + avatar.anchor.length;
    broad.spaces.find(p => p.id === 'a-spaces-row-identity')!.anchor = retained.slice(start, end);
    broad.spaces.find(p => p.id === 'a-spaces-row-identity')!.replacement = retained.slice(start, end);
    expect(() => replaySpacesARecipe(version, files, broad)).toThrow(/overlap/);
  });

  it('contains the native default layout and global key map used by isolated staging', () => {
    const layout = JSON.parse(readFileSync(new URL(`./fixtures/herdr-${version}/layouts/main.json`, import.meta.url), 'utf8'));
    const keys = JSON.parse(readFileSync(new URL(`./fixtures/herdr-${version}/keys.json`, import.meta.url), 'utf8'));
    expect(layout).toMatchObject({ id: 'root', type: 'row', titlebar: 'none' });
    expect(keys.global['cmd-shift-w']).toBe('pane.close');
    expect(keys.global['cmd-p']).toBe('mod.open:picker');
  });

  it('contains exact manifests, referenced icons and separate declarations', () => {
    const files = loadSpacesAFiles(version);
    for (const mod of ['agents', 'spaces', 'picker', 'pane', 'tabs', 'menu', 'new-menu', 'workspace-chrome', 'toast']) {
      expect(JSON.parse(files[mod]!['mod.json']!)).toHaveProperty('place');
      for (const [name, text] of Object.entries(files[mod]!)) if (name.endsWith('.svg')) expect(text.trim()).toMatch(/^<svg[\s\S]*<\/svg>$/);
    }
    expect(files['workspace-chrome']!['main.js']).not.toContain('<svg');
    expect(files['workspace-chrome']!['minus.svg']).toContain('<svg');
    expect(files.tabs!['win-max.svg']).toContain('<svg');
  });

  it('records every original retained failure and resolves it by variant or named removal', () => {
    const files = loadSpacesAFiles(version);
    const failures: string[] = [];
    for (const [mod, patches] of Object.entries(base.mods)) {
      let text = files[mod]!['main.js']!;
      for (const patch of patches) {
        const count = text.split(patch.anchor).length - 1;
        if (count !== 1) failures.push(`${mod}/${patch.id}`);
        else text = text.replace(patch.anchor, `/* spider-look:${patch.id} */${patch.replacement}`);
      }
    }
    expect(failures).toEqual(spacesARecipes[version].originalFailures);
    expect(failures).toHaveLength(version === '0.1.13' ? 3 : 18);
    for (const failure of failures) {
      const [mod, id] = failure.split('/');
      expect(spacesARecipes[version].supersededIds[mod!]?.includes(id!) || spacesARecipes[version].retainedOverrides[mod!]?.some(p => p.id === id)).toBe(true);
    }
  });

  it('replays all surviving retained patches and returns identical final bytes on repeat', () => {
    const files = loadSpacesAFiles(version);
    const final = replaySpacesARecipe(version, files);
    expect(replaySpacesARecipe(version, final)).toEqual(final);
    expect(Object.values(spacesARecipes[version].mods).flat()).toHaveLength(100);
    expect(final.toast).toEqual(files.toast);
    for (const [mod, entries] of Object.entries(final)) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: entries['main.js'], encoding: 'utf8' });
      expect(checked.status, `${mod}: ${checked.stderr}`).toBe(0);
    }
  });

  it('records complete final patch order and permits a single provenance-checked derived artifact', () => {
    const files = loadSpacesAFiles(version);
    const fragments: SpacesAFragments = { agents: [{ id: 'a-final', file: 'main.js', anchor: 'const SORTS = [', replacement: 'const SORTS = [ /* final */' }] };
    const contents = files.picker!['main.js']!;
    const outputHash = createHash('sha256').update(contents).digest('hex');
    const recipe = composeSpacesARecipe(version, fragments, [{ mod: 'spider-picker', file: 'main.js', sourceMod: 'picker', sourceFile: 'main.js', sourceHash: outputHash, contents, outputHash }]);
    expect(recipe.mods.agents!.at(-1)!.id).toBe('a-final');
    const final = replaySpacesARecipe(version, files, fragments, recipe);
    expect(final['spider-picker']!['main.js']).toBe(contents);
    expect(replaySpacesARecipe(version, final, fragments, recipe)).toEqual(final);
    recipe.outputHashes['agents/main.js'] = 'unknown';
    expect(() => replaySpacesARecipe(version, final, fragments, recipe)).toThrow(/digest/);
    expect(() => composeSpacesARecipe(version, {}, [{ ...recipe.derivedFiles[0]!, sourceHash: 'unknown' }])).toThrow(/derived file digest/);
    expect(() => composeSpacesARecipe(version, {}, [recipe.derivedFiles[0]!, recipe.derivedFiles[0]!])).toThrow(/duplicate derived/);
  });

  it('applies actual fragment payloads after retained patches and rejects changed inner bytes', () => {
    const files = loadSpacesAFiles(version);
    const fragments: SpacesAFragments = { agents: [{ id: 'a-test', file: 'main.js', anchor: 'const SORTS = [', replacement: 'const SORTS = [ /* final payload */' }] };
    const final = replaySpacesARecipe(version, files, fragments);
    expect(final.agents!['main.js']).toContain('/* spider-look:a-test */const SORTS = [ /* final payload */');
    expect(replaySpacesARecipe(version, final, fragments)).toEqual(final);
    final.agents!['main.js'] = final.agents!['main.js']!.replace('final payload', 'altered payload');
    expect(() => replaySpacesARecipe(version, final, fragments)).toThrow(/digest/);
  });

  it('rejects overlapping A regions before changing any bytes', () => {
    const files = loadSpacesAFiles(version);
    const fragments: SpacesAFragments = { agents: [
      { id: 'a-outer', file: 'main.js', anchor: 'const SORTS = [', replacement: 'const SORTS = [' },
      { id: 'a-inner', file: 'main.js', anchor: 'SORTS = [', replacement: 'SORTS = [' },
    ] };
    expect(() => replaySpacesARecipe(version, files, fragments)).toThrow(/overlap/);
    expect(files).toEqual(loadSpacesAFiles(version));
  });

  it('rejects changed sources, missing files and partial final output', () => {
    const files = loadSpacesAFiles(version);
    const changed = structuredClone(files);
    changed.agents!['main.js'] += '\n';
    expect(() => replaySpacesARecipe(version, changed)).toThrow(/digest/);
    delete changed.agents!['main.js'];
    expect(() => replaySpacesARecipe(version, changed)).toThrow(/missing/);
    const partial = structuredClone(files);
    partial.agents = replaySpacesARecipe(version, files).agents!;
    expect(() => replaySpacesARecipe(version, partial)).toThrow(/partial/);
  });

  it('rejects removed and duplicate fragment anchors, duplicate markers and unknown removals', () => {
    const files = loadSpacesAFiles(version);
    expect(() => replaySpacesARecipe(version, files, { agents: [{ id: 'a-missing', file: 'main.js', anchor: 'missing source region', replacement: '' }] })).toThrow(/anchor.*0/);
    expect(() => replaySpacesARecipe(version, files, { agents: [{ id: 'a-duplicate', file: 'main.js', anchor: 'const ', replacement: '' }] })).toThrow(/anchor/);
    expect(() => replaySpacesARecipe(version, files, { agents: [{ id: 'a-marker', file: 'main.js', anchor: 'const SORTS = [', replacement: '/* spider-look:a-marker */const SORTS = [' }] })).toThrow(/marker/);
    const recipe = structuredClone(spacesARecipes[version]);
    recipe.supersededIds.agents!.push('unknown-patch');
    expect(() => replaySpacesARecipe(version, files, {}, recipe)).toThrow(/unknown removal/);
    recipe.supersededIds.agents!.pop();
    recipe.mods.agents![0]!.replacement += ' altered';
    expect(() => replaySpacesARecipe(version, files, {}, recipe)).toThrow(/retained/);
  });
});
